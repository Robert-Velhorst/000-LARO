import { createHash } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { ENV } from "./_core/env";
import { getInitializedDb } from "./db";
import { getHostedRedisScriptClient } from "./hostedRedis";
import { systemConfig } from "./schema";
import { trackUsage } from "./usageTracking";

export const LLM_OPERATIONS = [
  "case_assistant",
  "hybrid_search",
  "document_analysis",
  "timeline_correction",
  "lawyer_rating",
  "dossier_comparison",
  "dossier_discovery",
] as const;

export type LLMOperation = typeof LLM_OPERATIONS[number];
export type LLMProviderClass = "local" | "external";

export type LLMOperationProfile = {
  maxInputCharacters: number;
  defaultOutputTokens: number;
  maxOutputTokens: number;
};

/**
 * Per-call limits. These are intentionally operation-specific because a short
 * search expansion and a source-grounded document chunk have very different
 * legitimate context requirements.
 */
export const LLM_OPERATION_PROFILES: Record<LLMOperation, LLMOperationProfile> = {
  case_assistant: { maxInputCharacters: 100_000, defaultOutputTokens: 900, maxOutputTokens: 900 },
  hybrid_search: { maxInputCharacters: 12_000, defaultOutputTokens: 300, maxOutputTokens: 300 },
  document_analysis: { maxInputCharacters: 75_000, defaultOutputTokens: 4_096, maxOutputTokens: 4_096 },
  timeline_correction: { maxInputCharacters: 160_000, defaultOutputTokens: 1_400, maxOutputTokens: 1_400 },
  lawyer_rating: { maxInputCharacters: 24_000, defaultOutputTokens: 1_200, maxOutputTokens: 1_200 },
  dossier_comparison: { maxInputCharacters: 48_000, defaultOutputTokens: 2_500, maxOutputTokens: 32_768 },
  dossier_discovery: { maxInputCharacters: 48_000, defaultOutputTokens: 2_500, maxOutputTokens: 2_500 },
};

const OWNER_WINDOW_MS = 60 * 60 * 1_000;
const OWNER_MAX_CONCURRENT = 2;
type OwnerLimits = { requests: number; inputCharacters: number; outputTokens: number };
const GLOBAL_OWNER_LIMITS: OwnerLimits = {
  requests: 60,
  inputCharacters: 4_000_000,
  outputTokens: 240_000,
};
const PROVIDER_CLASS_LIMITS: Record<LLMProviderClass, OwnerLimits> = {
  local: GLOBAL_OWNER_LIMITS,
  external: { requests: 20, inputCharacters: 1_000_000, outputTokens: 80_000 },
};

type BudgetMetric = "requests" | "inputCharacters" | "outputTokens";
type BudgetLimit = BudgetMetric | "concurrency" | "operationInput" | "operationOutput" | "budgetStore";
type CounterState = { value: number; resetAt: number };
type MetricSpec = { key: string; metric: BudgetMetric; cost: number; maximum: number };

const memoryCounters = new Map<string, CounterState>();
const activeByOwner = new Map<string, number>();

export class LLMUsageLimitError extends TRPCError {
  readonly limit: BudgetLimit;

  constructor(limit: BudgetLimit, message: string) {
    super({
      code: limit === "operationInput" || limit === "operationOutput" ? "PAYLOAD_TOO_LARGE" : "TOO_MANY_REQUESTS",
      message,
    });
    this.name = "LLMUsageLimitError";
    this.limit = limit;
  }
}

export function isLLMUsageLimitError(error: unknown): error is LLMUsageLimitError {
  return error instanceof LLMUsageLimitError;
}

export function resolveLLMOutputTokens(operation: LLMOperation, requested?: number): number {
  const profile = LLM_OPERATION_PROFILES[operation];
  const outputTokens = requested ?? profile.defaultOutputTokens;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 1 || outputTokens > profile.maxOutputTokens) {
    throw new LLMUsageLimitError(
      "operationOutput",
      `${operation} output must be an integer from 1 to ${profile.maxOutputTokens} tokens.`,
    );
  }
  return outputTokens;
}

export function assertLLMInputWithinProfile(operation: LLMOperation, inputCharacters: number): void {
  const maximum = LLM_OPERATION_PROFILES[operation].maxInputCharacters;
  if (!Number.isSafeInteger(inputCharacters) || inputCharacters < 0 || inputCharacters > maximum) {
    throw new LLMUsageLimitError(
      "operationInput",
      `${operation} input exceeds its ${maximum}-character limit.`,
    );
  }
}

function ownerDigest(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex");
}

function metricSpecs(ownerId: string, providerClass: LLMProviderClass, inputCharacters: number, outputTokens: number): MetricSpec[] {
  const digest = ownerDigest(ownerId);
  const costs: Record<BudgetMetric, number> = { requests: 1, inputCharacters, outputTokens };
  return (Object.keys(costs) as BudgetMetric[]).flatMap((metric) => [
    {
      key: `llm-budget:v1:${digest}:global:${metric}`,
      metric,
      cost: costs[metric],
      maximum: GLOBAL_OWNER_LIMITS[metric],
    },
    {
      key: `llm-budget:v1:${digest}:${providerClass}:${metric}`,
      metric,
      cost: costs[metric],
      maximum: PROVIDER_CLASS_LIMITS[providerClass][metric],
    },
  ]);
}

function parseCounter(value: string | null | undefined, now: number): CounterState {
  if (!value) return { value: 0, resetAt: now + OWNER_WINDOW_MS };
  try {
    const parsed = JSON.parse(value) as Partial<CounterState>;
    if (Number.isSafeInteger(parsed.value) && Number.isSafeInteger(parsed.resetAt) && Number(parsed.resetAt) > now) {
      return { value: Number(parsed.value), resetAt: Number(parsed.resetAt) };
    }
  } catch {
    // A malformed or expired operational counter starts a fresh fixed window.
  }
  return { value: 0, resetAt: now + OWNER_WINDOW_MS };
}

function limitMessage(metric: BudgetMetric, resetAt: number): string {
  const resetSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000));
  const label = metric === "requests" ? "request" : metric === "inputCharacters" ? "input-character" : "output-token";
  return `The owner AI ${label} budget is exhausted. Retry in ${resetSeconds} seconds.`;
}

function consumeMemory(specs: MetricSpec[]): void {
  const now = Date.now();
  const states = specs.map((spec) => ({ spec, state: parseCounter(
    memoryCounters.has(spec.key) ? JSON.stringify(memoryCounters.get(spec.key)) : null,
    now,
  ) }));
  const blocked = states.find(({ spec, state }) => state.value + spec.cost > spec.maximum);
  if (blocked) throw new LLMUsageLimitError(blocked.spec.metric, limitMessage(blocked.spec.metric, blocked.state.resetAt));
  for (const { spec, state } of states) {
    memoryCounters.set(spec.key, { value: state.value + spec.cost, resetAt: state.resetAt });
  }
}

function consumeDatabase(specs: MetricSpec[]): void {
  const db = getInitializedDb();
  if (!db) return consumeMemory(specs);
  const now = Date.now();
  const result = db.transaction((tx) => {
    const states = specs.map((spec) => {
      const row = tx.select({ value: systemConfig.configValue })
        .from(systemConfig)
        .where(eq(systemConfig.configKey, spec.key))
        .get();
      return { spec, state: parseCounter(row?.value, now) };
    });
    const blocked = states.find(({ spec, state }) => state.value + spec.cost > spec.maximum);
    if (blocked) return { allowed: false as const, metric: blocked.spec.metric, resetAt: blocked.state.resetAt };
    for (const { spec, state } of states) {
      const next = JSON.stringify({ value: state.value + spec.cost, resetAt: state.resetAt });
      tx.insert(systemConfig).values({ configKey: spec.key, configValue: next, updatedAt: new Date(now) })
        .onConflictDoUpdate({ target: systemConfig.configKey, set: { configValue: next, updatedAt: new Date(now) } })
        .run();
    }
    return { allowed: true as const };
  });
  if (!result.allowed) throw new LLMUsageLimitError(result.metric, limitMessage(result.metric, result.resetAt));
}

const REDIS_WEIGHTED_BUDGET_SCRIPT = `
local count = #KEYS
for i = 1, count do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  local cost = tonumber(ARGV[1 + i])
  local maximum = tonumber(ARGV[1 + count + i])
  if current + cost > maximum then
    local ttl = redis.call('PTTL', KEYS[i])
    if ttl < 1 then ttl = tonumber(ARGV[1]) end
    return {0, i, ttl}
  end
end
for i = 1, count do
  local cost = tonumber(ARGV[1 + i])
  local current = redis.call('INCRBY', KEYS[i], cost)
  if current == cost then redis.call('PEXPIRE', KEYS[i], ARGV[1]) end
end
return {1, 0, tonumber(ARGV[1])}
`;

async function consumeHosted(specs: MetricSpec[]): Promise<void> {
  try {
    const client = await getHostedRedisScriptClient();
    const result = await client.eval(REDIS_WEIGHTED_BUDGET_SCRIPT, {
      keys: specs.map((spec) => `laro:${spec.key}`),
      arguments: [
        String(OWNER_WINDOW_MS),
        ...specs.map((spec) => String(spec.cost)),
        ...specs.map((spec) => String(spec.maximum)),
      ],
    });
    if (!Array.isArray(result) || result.length !== 3) throw new Error("Invalid shared budget result");
    if (Number(result[0]) === 1) return;
    const index = Number(result[1]) - 1;
    const spec = specs[index];
    const resetAt = Date.now() + Math.max(1, Number(result[2]));
    if (!spec || !Number.isFinite(resetAt)) throw new Error("Invalid shared budget rejection");
    throw new LLMUsageLimitError(spec.metric, limitMessage(spec.metric, resetAt));
  } catch (error) {
    if (isLLMUsageLimitError(error)) throw error;
    throw new LLMUsageLimitError("budgetStore", "The shared AI usage budget is unavailable; no provider request was sent.");
  }
}

export async function acquireLLMUsageBudget(input: {
  ownerId: string;
  providerClass: LLMProviderClass;
  inputCharacters: number;
  outputTokens: number;
}): Promise<() => void> {
  const ownerId = input.ownerId.trim();
  if (!ownerId || ownerId.length > 256) {
    throw new LLMUsageLimitError("budgetStore", "A valid owner identity is required for model usage.");
  }
  const active = activeByOwner.get(ownerId) || 0;
  if (active >= OWNER_MAX_CONCURRENT) {
    throw new LLMUsageLimitError("concurrency", "Only two model requests may run concurrently for one owner.");
  }
  activeByOwner.set(ownerId, active + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const current = activeByOwner.get(ownerId) || 0;
    if (current <= 1) activeByOwner.delete(ownerId);
    else activeByOwner.set(ownerId, current - 1);
  };
  try {
    const specs = metricSpecs(ownerId, input.providerClass, input.inputCharacters, input.outputTokens);
    if (ENV.isHosted) await consumeHosted(specs);
    else consumeDatabase(specs);
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export async function recordLLMUsageTelemetry(input: {
  ownerId: string;
  caseId?: string;
  operation: LLMOperation;
  providerClass: LLMProviderClass;
  inputCharacters: number;
  outputTokens: number;
  outcome: "success" | "provider_error" | "budget_rejected";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}): Promise<void> {
  if (!getInitializedDb()) return;
  const actualTokens = Number.isSafeInteger(input.totalTokens) && Number(input.totalTokens) > 0
    ? Number(input.totalTokens)
    : 1;
  try {
    await trackUsage({
      userId: input.ownerId,
      caseId: input.caseId,
      resourceType: "ai_model_invocation",
      quantity: actualTokens,
      metadata: {
        operation: input.operation,
        providerClass: input.providerClass,
        outcome: input.outcome,
        inputCharacters: input.inputCharacters,
        requestedOutputTokens: input.outputTokens,
        promptTokens: Number.isSafeInteger(input.promptTokens) ? input.promptTokens : null,
        completionTokens: Number.isSafeInteger(input.completionTokens) ? input.completionTokens : null,
        totalTokens: Number.isSafeInteger(input.totalTokens) ? input.totalTokens : null,
        quantityUnit: actualTokens === 1 && !input.totalTokens ? "invocation" : "tokens",
      },
    });
  } catch (error) {
    console.warn("[LLM_USAGE] Could not persist non-sensitive usage telemetry:", error instanceof Error ? error.message : "unknown error");
  }
}

/** Test isolation for direct transport tests that do not boot a database. */
export function resetLLMUsageBudgetForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("LLM budget reset is test-only");
  memoryCounters.clear();
  activeByOwner.clear();
}
