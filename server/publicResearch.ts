import { getDb } from "./db";
import { AUDIT_ACTIONS, writeAuditLogOrThrow } from "./audit";

export const PUBLIC_RESEARCH_CONTRACT_VERSION = "case-public-research-v1" as const;

export type PublicResearchSource =
  | "kvk_open_dataset"
  | "rechtspraak_rss"
  | "koop_bwb_sru";

export type PublicResearchCompleteness =
  | "complete"
  | "partial"
  | "unavailable"
  | "failed";

export type PublicResearchProviderOutcome =
  | "complete"
  | "partial"
  | "empty"
  | "unavailable"
  | "failed";

export interface PublicResearchReceipt {
  contractVersion: typeof PUBLIC_RESEARCH_CONTRACT_VERSION;
  recordId: string;
  caseId: string;
  source: PublicResearchSource;
  normalizedQuery: string;
  retrievedAt: string;
  resultCount: number | null;
  completeness: PublicResearchCompleteness;
  /** True only when a complete provider response authoritatively returned zero rows. */
  empty: boolean;
}

export class PublicResearchProviderError extends Error {
  constructor(
    public readonly outcome: Exclude<PublicResearchProviderOutcome, "complete" | "partial">,
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PublicResearchProviderError";
  }
}

export function normalizePublicResearchQuery(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("nl-NL");
}

export function providerHttpError(provider: string, status: number): PublicResearchProviderError {
  if (status === 404) {
    return new PublicResearchProviderError("empty", "not_found", `${provider} returned no matching record.`);
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new PublicResearchProviderError(
      "unavailable",
      `http_${status}`,
      `${provider} is temporarily unavailable. Retry the research later.`,
    );
  }
  return new PublicResearchProviderError(
    "failed",
    `http_${status}`,
    `${provider} rejected the research request. Review the query and retry.`,
  );
}

export function classifyPublicResearchError(error: unknown, provider: string): {
  outcome: "unavailable" | "failed";
  code: string;
  message: string;
} {
  if (error instanceof PublicResearchProviderError) {
    if (error.outcome === "empty") {
      return { outcome: "failed", code: error.code, message: error.message };
    }
    return { outcome: error.outcome, code: error.code, message: error.message };
  }
  if (
    error instanceof TypeError
    || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
  ) {
    return {
      outcome: "unavailable",
      code: "transport_unavailable",
      message: `${provider} could not be reached. Retry the research later.`,
    };
  }
  if (error instanceof Error && /(?:response limit|safety limit)/i.test(error.message)) {
    return {
      outcome: "failed",
      code: "response_too_large",
      message: error.message,
    };
  }
  return {
    outcome: "failed",
    code: "invalid_provider_response",
    message: `${provider} returned a response LARO could not safely use. No conclusion was recorded.`,
  };
}

export function researchStateFromOutcome(outcome: PublicResearchProviderOutcome): {
  completeness: PublicResearchCompleteness;
  empty: boolean;
} {
  if (outcome === "empty") return { completeness: "complete", empty: true };
  return { completeness: outcome, empty: false };
}

export async function recordPublicResearch(input: {
  userId: string;
  caseId: string;
  source: PublicResearchSource;
  normalizedQuery: string;
  retrievedAt: string;
  resultCount: number | null;
  completeness: PublicResearchCompleteness;
  empty?: boolean;
  context?: Record<string, string | number | boolean | null>;
}): Promise<PublicResearchReceipt> {
  const db = await getDb();
  if (!db) throw new Error("Research history database not available");
  const empty = input.completeness === "complete"
    && input.resultCount === 0
    && input.empty === true;
  const recordId = writeAuditLogOrThrow(db, {
    userId: input.userId,
    action: AUDIT_ACTIONS.PUBLIC_RESEARCH_RECORDED,
    entityType: "case",
    entityId: input.caseId,
    details: {
      contractVersion: PUBLIC_RESEARCH_CONTRACT_VERSION,
      caseId: input.caseId,
      source: input.source,
      normalizedQuery: input.normalizedQuery,
      retrievedAt: input.retrievedAt,
      resultCount: input.resultCount,
      completeness: input.completeness,
      empty,
      ...(input.context || {}),
    },
  });
  return {
    contractVersion: PUBLIC_RESEARCH_CONTRACT_VERSION,
    recordId,
    caseId: input.caseId,
    source: input.source,
    normalizedQuery: input.normalizedQuery,
    retrievedAt: input.retrievedAt,
    resultCount: input.resultCount,
    completeness: input.completeness,
    empty,
  };
}
