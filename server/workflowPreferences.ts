import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { userPreferences } from "./schema";
import { writeAuditLogOrThrow } from "./audit";
import {
  EXTERNAL_LLM_PROVIDERS,
  LLM_PROVIDERS,
  isLocalLLMProvider,
  type ExternalLLMProvider,
  type LLMProvider,
} from "./llm";
import { EXTERNAL_DOCUMENT_SHARING_SCOPE } from "../shared/workflowConsent";

export const WORKFLOW_PREFERENCE_KEY = "workflow-controls";

export type AnalysisMode = "local" | "cloud";
export type AnalysisProvider = "local" | LLMProvider;
export type ReviewMode = "each" | "batch" | "automatic";

export interface ExternalDocumentSharingConsent {
  id: string;
  version: 1;
  provider: ExternalLLMProvider;
  scope: typeof EXTERNAL_DOCUMENT_SHARING_SCOPE;
  actorUserId: string;
  grantedAt: string;
  automaticImports: boolean;
  revokedAt: string | null;
  revokedByUserId: string | null;
}

export interface WorkflowPreferences {
  analysisMode: AnalysisMode;
  analysisProvider: AnalysisProvider;
  autoAnalyzeImports: boolean;
  autoOrganizeDocuments: boolean;
  /** Derived from the active provider-bound consent. Legacy boolean values never grant consent. */
  shareRawDocumentContent: boolean;
  externalDocumentSharingConsent: ExternalDocumentSharingConsent | null;
  outreachReviewMode: ReviewMode;
  messageApprovalMode: ReviewMode;
}

export const DEFAULT_WORKFLOW_PREFERENCES: WorkflowPreferences = {
  analysisMode: "local",
  analysisProvider: "local",
  autoAnalyzeImports: true,
  autoOrganizeDocuments: true,
  shareRawDocumentContent: false,
  externalDocumentSharingConsent: null,
  outreachReviewMode: "each",
  messageApprovalMode: "each",
};

function isExternalProvider(value: unknown): value is ExternalLLMProvider {
  return typeof value === "string" && (EXTERNAL_LLM_PROVIDERS as readonly string[]).includes(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function parseConsent(value: unknown): ExternalDocumentSharingConsent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const consent = value as Partial<ExternalDocumentSharingConsent>;
  const validRevocation = (consent.revokedAt === null && consent.revokedByUserId === null) ||
    (isIsoTimestamp(consent.revokedAt) && typeof consent.revokedByUserId === "string" && Boolean(consent.revokedByUserId));
  if (
    typeof consent.id !== "string" || !consent.id ||
    consent.version !== 1 ||
    !isExternalProvider(consent.provider) ||
    consent.scope !== EXTERNAL_DOCUMENT_SHARING_SCOPE ||
    typeof consent.actorUserId !== "string" || !consent.actorUserId ||
    !isIsoTimestamp(consent.grantedAt) ||
    typeof consent.automaticImports !== "boolean" ||
    !validRevocation
  ) return null;
  if (consent.revokedAt !== null &&
      new Date(consent.revokedAt as string).getTime() < new Date(consent.grantedAt as string).getTime()) return null;
  return consent as ExternalDocumentSharingConsent;
}

function hasActiveConsent(
  preferences: Pick<WorkflowPreferences, "analysisProvider" | "autoAnalyzeImports" | "externalDocumentSharingConsent">,
  provider: ExternalLLMProvider,
  userId: string,
): boolean {
  const consent = preferences.externalDocumentSharingConsent;
  return preferences.analysisProvider === provider &&
    consent?.provider === provider &&
    consent.actorUserId === userId &&
    consent.scope === EXTERNAL_DOCUMENT_SHARING_SCOPE &&
    consent.revokedAt === null &&
    consent.automaticImports === preferences.autoAnalyzeImports;
}

function parseWorkflowPreferences(value: string | null | undefined, userId: string): WorkflowPreferences {
  if (!value) return { ...DEFAULT_WORKFLOW_PREFERENCES };
  try {
    const parsedValue = JSON.parse(value) as unknown;
    if (!parsedValue || typeof parsedValue !== "object" || Array.isArray(parsedValue)) {
      return { ...DEFAULT_WORKFLOW_PREFERENCES };
    }
    const parsed = parsedValue as Partial<WorkflowPreferences>;
    const configuredProvider = LLM_PROVIDERS.includes(parsed.analysisProvider as LLMProvider)
      ? parsed.analysisProvider as LLMProvider
      : null;
    const analysisProvider: AnalysisProvider = parsed.analysisProvider === "local"
      ? "local"
      : configuredProvider || (parsed.analysisMode === "cloud" ? "forge" : "local");
    const autoAnalyzeImports = parsed.autoAnalyzeImports !== false;
    const parsedConsent = parseConsent(parsed.externalDocumentSharingConsent);
    const externalDocumentSharingConsent = parsedConsent?.actorUserId === userId ? parsedConsent : null;
    const preferences: WorkflowPreferences = {
      analysisMode: analysisProvider === "local" || isLocalLLMProvider(analysisProvider) ? "local" : "cloud",
      analysisProvider,
      autoAnalyzeImports,
      autoOrganizeDocuments: parsed.autoOrganizeDocuments !== false,
      shareRawDocumentContent: false,
      externalDocumentSharingConsent,
      outreachReviewMode: ["each", "batch", "automatic"].includes(parsed.outreachReviewMode || "")
        ? parsed.outreachReviewMode as ReviewMode
        : "each",
      messageApprovalMode: ["each", "batch", "automatic"].includes(parsed.messageApprovalMode || "")
        ? parsed.messageApprovalMode as ReviewMode
        : "each",
    };
    preferences.shareRawDocumentContent = isExternalProvider(analysisProvider) &&
      hasActiveConsent(preferences, analysisProvider, userId);
    return preferences;
  } catch {
    return { ...DEFAULT_WORKFLOW_PREFERENCES };
  }
}

export function documentContentAuthorizationToken(
  preferences: WorkflowPreferences,
  provider: LLMProvider,
  userId: string,
): string | null {
  if (preferences.analysisProvider !== provider) return null;
  if (isLocalLLMProvider(provider)) return `local:${provider}`;
  return isExternalProvider(provider) && hasActiveConsent(preferences, provider, userId)
    ? `consent:${preferences.externalDocumentSharingConsent!.id}:${preferences.externalDocumentSharingConsent!.grantedAt}`
    : null;
}

export function isDocumentContentProviderAuthorized(
  preferences: WorkflowPreferences,
  provider: LLMProvider,
  userId: string,
): boolean {
  return documentContentAuthorizationToken(preferences, provider, userId) !== null;
}

export type WorkflowPreferenceUpdates = Partial<Omit<
  WorkflowPreferences,
  "shareRawDocumentContent" | "externalDocumentSharingConsent"
>>;

function storePreferences(tx: any, userId: string, preferences: WorkflowPreferences, now: Date): void {
  tx.insert(userPreferences).values({
    id: nanoid(),
    userId,
    key: WORKFLOW_PREFERENCE_KEY,
    value: JSON.stringify(preferences),
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [userPreferences.userId, userPreferences.key],
    set: { value: JSON.stringify(preferences), updatedAt: now },
  }).run();
}

function revokeConsent(
  consent: ExternalDocumentSharingConsent,
  userId: string,
  now: Date,
): ExternalDocumentSharingConsent {
  return { ...consent, revokedAt: now.toISOString(), revokedByUserId: userId };
}

function writeConsentAudit(
  tx: any,
  action: "workflow.external_document_sharing_granted" | "workflow.external_document_sharing_revoked",
  userId: string,
  consent: ExternalDocumentSharingConsent,
): void {
  writeAuditLogOrThrow(tx, {
    userId,
    action,
    entityType: "workflow_consent",
    entityId: consent.id,
    idempotencyKey: `${consent.id}:${action}`,
    details: {
      consentId: consent.id,
      provider: consent.provider,
      scope: consent.scope,
      actorUserId: consent.actorUserId,
      grantedAt: consent.grantedAt,
      automaticImports: consent.automaticImports,
      revokedAt: consent.revokedAt,
      revokedByUserId: consent.revokedByUserId,
    },
  });
}

export async function getWorkflowPreferences(userId: string): Promise<WorkflowPreferences> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(
      eq(userPreferences.userId, userId),
      eq(userPreferences.key, WORKFLOW_PREFERENCE_KEY),
    ))
    .limit(1);
  return parseWorkflowPreferences(row?.value, userId);
}

export async function updateWorkflowPreferences(
  userId: string,
  updates: WorkflowPreferenceUpdates,
): Promise<WorkflowPreferences> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction((tx) => {
    const row = tx
      .select({ value: userPreferences.value })
      .from(userPreferences)
      .where(and(
        eq(userPreferences.userId, userId),
        eq(userPreferences.key, WORKFLOW_PREFERENCE_KEY),
      ))
      .limit(1)
      .get();
    const current = parseWorkflowPreferences(row?.value, userId);
    const normalizedUpdates = { ...updates };
    if (updates.analysisProvider) {
      normalizedUpdates.analysisMode = updates.analysisProvider === "local" || isLocalLLMProvider(updates.analysisProvider)
        ? "local"
        : "cloud";
    } else if (updates.analysisMode) {
      normalizedUpdates.analysisProvider = updates.analysisMode === "cloud" ? "forge" : "local";
    }
    const now = new Date();
    let next = parseWorkflowPreferences(JSON.stringify({ ...current, ...normalizedUpdates }), userId);
    const consent = current.externalDocumentSharingConsent;
    if (consent && consent.revokedAt === null && (
      current.analysisProvider !== next.analysisProvider ||
      current.autoAnalyzeImports !== next.autoAnalyzeImports
    )) {
      const revokedConsent = revokeConsent(consent, userId, now);
      next = parseWorkflowPreferences(JSON.stringify({ ...next, externalDocumentSharingConsent: revokedConsent }), userId);
      writeConsentAudit(tx, "workflow.external_document_sharing_revoked", userId, revokedConsent);
    }
    storePreferences(tx, userId, next, now);
    return next;
  });
}

export async function grantExternalDocumentSharingConsent(
  userId: string,
  provider: ExternalLLMProvider,
  expectedAutomaticImports: boolean,
): Promise<WorkflowPreferences> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction((tx) => {
    const row = tx.select({ value: userPreferences.value }).from(userPreferences).where(and(
      eq(userPreferences.userId, userId),
      eq(userPreferences.key, WORKFLOW_PREFERENCE_KEY),
    )).limit(1).get();
    const current = parseWorkflowPreferences(row?.value, userId);
    if (current.analysisProvider !== provider) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Select this external analysis provider before granting document-sharing consent.",
      });
    }
    if (current.autoAnalyzeImports !== expectedAutomaticImports) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "The automatic-import setting changed during consent review. Refresh Settings and review it again.",
      });
    }
    if (hasActiveConsent(current, provider, userId)) return current;
    const now = new Date();
    const existing = current.externalDocumentSharingConsent;
    if (existing && existing.revokedAt === null) {
      writeConsentAudit(tx, "workflow.external_document_sharing_revoked", userId, revokeConsent(existing, userId, now));
    }
    const consent: ExternalDocumentSharingConsent = {
      id: nanoid(),
      version: 1,
      provider,
      scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
      actorUserId: userId,
      grantedAt: now.toISOString(),
      automaticImports: current.autoAnalyzeImports,
      revokedAt: null,
      revokedByUserId: null,
    };
    const next = parseWorkflowPreferences(JSON.stringify({ ...current, externalDocumentSharingConsent: consent }), userId);
    storePreferences(tx, userId, next, now);
    writeConsentAudit(tx, "workflow.external_document_sharing_granted", userId, consent);
    return next;
  });
}

export async function revokeExternalDocumentSharingConsent(
  userId: string,
  consentId: string,
): Promise<WorkflowPreferences> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction((tx) => {
    const row = tx.select({ value: userPreferences.value }).from(userPreferences).where(and(
      eq(userPreferences.userId, userId),
      eq(userPreferences.key, WORKFLOW_PREFERENCE_KEY),
    )).limit(1).get();
    const current = parseWorkflowPreferences(row?.value, userId);
    const consent = current.externalDocumentSharingConsent;
    if (!consent || consent.id !== consentId) {
      throw new TRPCError({ code: "CONFLICT", message: "The document-sharing consent changed. Refresh Settings and try again." });
    }
    if (consent.revokedAt !== null) return current;
    const now = new Date();
    const revokedConsent = revokeConsent(consent, userId, now);
    const next = parseWorkflowPreferences(JSON.stringify({ ...current, externalDocumentSharingConsent: revokedConsent }), userId);
    storePreferences(tx, userId, next, now);
    writeConsentAudit(tx, "workflow.external_document_sharing_revoked", userId, revokedConsent);
    return next;
  });
}
