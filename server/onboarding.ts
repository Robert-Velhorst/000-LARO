/**
 * Canonical, owner-scoped first-run lifecycle.
 *
 * Only presentation state is persisted. Progress is derived from the user's
 * real workspace so the desktop and hosted renderers cannot drift from the
 * underlying case, evidence, and outreach records.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { cases, evidence, outreachStatus, systemConfig } from "./schema";

export const ONBOARDING_STEP_KEYS = ["case", "evidence", "outreach"] as const;
export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];
export type OnboardingStatus = "active" | "skipped" | "complete";

export interface OnboardingStep {
  key: OnboardingStepKey;
  route: "/cases" | "/evidence" | "/outreach";
  complete: boolean;
}

export interface OnboardingState {
  status: OnboardingStatus;
  complete: boolean;
  currentStepKey: OnboardingStepKey;
  completedSteps: number;
  totalSteps: number;
  canComplete: boolean;
  steps: OnboardingStep[];
}

type PersistedOnboardingState = {
  status: OnboardingStatus;
  currentStepKey: OnboardingStepKey;
};

const STEP_DEFINITIONS: ReadonlyArray<Omit<OnboardingStep, "complete">> = [
  { key: "case", route: "/cases" },
  { key: "evidence", route: "/evidence" },
  { key: "outreach", route: "/outreach" },
];

function stateKey(userId: string): string {
  return `onboarding:state:${userId}`;
}

function legacyCompleteKey(userId: string): string {
  return `onboarding:complete:${userId}`;
}

function isStepKey(value: unknown): value is OnboardingStepKey {
  return typeof value === "string" && (ONBOARDING_STEP_KEYS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is OnboardingStatus {
  return value === "active" || value === "skipped" || value === "complete";
}

function parsePersistedState(value: string | null | undefined): PersistedOnboardingState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!isStatus(parsed.status) || !isStepKey(parsed.currentStepKey)) return null;
    return { status: parsed.status, currentStepKey: parsed.currentStepKey };
  } catch {
    return null;
  }
}

function defaultPersistedState(): PersistedOnboardingState {
  return { status: "active", currentStepKey: ONBOARDING_STEP_KEYS[0] };
}

async function writePersistedState(userId: string, state: PersistedOnboardingState): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const updatedAt = new Date();
  db.transaction((tx) => {
    tx.insert(systemConfig)
      .values({ configKey: stateKey(userId), configValue: JSON.stringify(state), updatedAt } as any)
      .onConflictDoUpdate({
        target: systemConfig.configKey,
        set: { configValue: JSON.stringify(state), updatedAt },
      })
      .run();
    tx.delete(systemConfig).where(eq(systemConfig.configKey, legacyCompleteKey(userId))).run();
  });
}

async function readPersistedState(userId: string): Promise<PersistedOnboardingState> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({ key: systemConfig.configKey, value: systemConfig.configValue })
    .from(systemConfig)
    .where(eq(systemConfig.configKey, stateKey(userId)))
    .limit(1);
  const parsed = parsePersistedState(rows[0]?.value);
  if (parsed) return parsed;

  const legacyRows = await db
    .select({ value: systemConfig.configValue })
    .from(systemConfig)
    .where(eq(systemConfig.configKey, legacyCompleteKey(userId)))
    .limit(1);
  const migrated = legacyRows[0]
    ? {
        status: legacyRows[0].value === "true" ? "complete" as const : "active" as const,
        currentStepKey: ONBOARDING_STEP_KEYS[0],
      }
    : defaultPersistedState();

  // Rewrite malformed current values and migrate the legacy boolean shape.
  if (rows[0] || legacyRows[0]) await writePersistedState(userId, migrated);
  return migrated;
}

async function deriveCompletedSteps(userId: string): Promise<Record<OnboardingStepKey, boolean>> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [caseRows, evidenceRows, outreachRows] = await Promise.all([
    db.select({ id: cases.id })
      .from(cases)
      .where(eq(cases.userId, userId))
      .limit(1),
    db.select({ id: evidence.id })
      .from(evidence)
      .innerJoin(cases, and(eq(cases.id, evidence.caseId), eq(cases.userId, userId)))
      .where(eq(evidence.userId, userId))
      .limit(1),
    db.select({ id: outreachStatus.id })
      .from(outreachStatus)
      .innerJoin(cases, and(eq(cases.id, outreachStatus.caseId), eq(cases.userId, userId)))
      .limit(1),
  ]);

  return {
    case: caseRows.length > 0,
    evidence: evidenceRows.length > 0,
    outreach: outreachRows.length > 0,
  };
}

async function buildState(userId: string, persisted?: PersistedOnboardingState): Promise<OnboardingState> {
  const current = persisted ?? await readPersistedState(userId);
  const completed = await deriveCompletedSteps(userId);
  const completedSteps = ONBOARDING_STEP_KEYS.filter((key) => completed[key]).length;
  const steps = STEP_DEFINITIONS.map((step) => ({ ...step, complete: completed[step.key] }));
  return {
    status: current.status,
    complete: current.status === "complete",
    currentStepKey: current.currentStepKey,
    completedSteps,
    totalSteps: steps.length,
    canComplete: completedSteps === steps.length,
    steps,
  };
}

export function getOnboardingState(userId: string): Promise<OnboardingState> {
  return buildState(userId);
}

export async function setOnboardingCurrentStep(
  userId: string,
  currentStepKey: OnboardingStepKey,
): Promise<OnboardingState> {
  const current = await readPersistedState(userId);
  const next = { status: "active" as const, currentStepKey };
  if (current.status !== next.status || current.currentStepKey !== next.currentStepKey) {
    await writePersistedState(userId, next);
  }
  return buildState(userId, next);
}

export async function skipOnboarding(userId: string): Promise<OnboardingState> {
  const current = await readPersistedState(userId);
  const next = { ...current, status: "skipped" as const };
  await writePersistedState(userId, next);
  return buildState(userId, next);
}

export async function resetOnboarding(userId: string): Promise<OnboardingState> {
  const next = defaultPersistedState();
  await writePersistedState(userId, next);
  return buildState(userId, next);
}

export async function completeOnboarding(userId: string): Promise<OnboardingState | null> {
  const current = await buildState(userId);
  if (!current.canComplete) return null;
  const next = { status: "complete" as const, currentStepKey: "outreach" as const };
  await writePersistedState(userId, next);
  return buildState(userId, next);
}
