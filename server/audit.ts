import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { and, desc, eq } from "drizzle-orm";
import { auditLogs, InsertAuditLog } from "./schema";
import { getDb } from "./db";

export interface AuditLogInput {
  userId?: string;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  /** Stable operation key for retry-safe mandatory events. Never put a secret here. */
  idempotencyKey?: string;
}

const MANDATORY_AUDIT_ACTIONS = new Set([
  "case.clarification_answered",
  "case.deleted",
  "case.share_invited",
  "case.share_accepted",
  "case.share_updated",
  "case.share_revoked",
  "email.response_received",
  "emergency_stop.engaged",
  "emergency_stop.released",
  "feature_flag.changed",
  "gdpr.consent_updated",
  "gdpr.delete",
  "gdpr.erasure_revocation_pending",
  "gdpr.export",
  "integration.hai_token_created",
  "integration.hai_grant_updated",
  "integration.hai_token_revoked",
  "outreach.follow_up",
  "outreach.initiated",
  "outreach.status_changed",
  "outreach.dispatch_resolved",
  "outreach.directory_reviewed",
  "outreach.directory_batch_reviewed",
  "outreach.targets_matched",
  "outreach.target_match_status_changed",
  "legal_source.public_research_recorded",
  "legal_draft.recipient_reviewed",
  "legal_draft.reviewed",
  "legal_draft.downloaded",
  "provider.connected",
  "provider.credentials_invalidated",
  "provider.credentials_refreshed",
  "provider.disconnected",
  "provider.disconnect_revoked",
  "retention.sweep",
  "workflow.external_document_sharing_granted",
  "workflow.external_document_sharing_revoked",
]);

const REDACTED_SECRET = "[REDACTED_SECRET]";
const REDACTED_CONTENT = "[REDACTED_CONTENT]";
const SECRET_DETAIL_KEYS = new Set([
  "password", "passwordhash", "passphrase", "secret", "clientsecret", "authorization", "cookie",
  "token", "tokenhash", "accesstoken", "refreshtoken", "apikey", "credential", "credentials",
  "privatekey", "encryptionkey", "jwt", "oauthcode", "authcode", "codeverifier",
]);
const CONTENT_DETAIL_KEYS = new Set([
  "actor", "body", "clientemail", "clientname", "email", "filename", "name", "query",
  "reference", "references", "reasons", "response", "sourcepath", "subject",
]);
const SECRET_DETAIL_SUFFIXES = ["apikey", "authorization", "cookie", "credential", "encryptionkey", "password", "privatekey", "secret", "token"];
const CONTENT_DETAIL_SUFFIXES = ["body", "content", "description", "filename", "instruction", "message", "note", "path", "prompt", "quote", "quotes", "summary", "text", "title"];
const AUDIT_REASON_TEXT_ALLOWLIST = new Set(["inbox.reassigned"]);

function normalizedDetailKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function hasSensitiveSuffix(key: string, suffixes: string[]): boolean {
  return suffixes.some((suffix) => key.endsWith(suffix));
}

function redactAuditValue(value: unknown, key: string | undefined, depth: number, action?: string): unknown {
  const normalizedKey = key ? normalizedDetailKey(key) : "";
  if (SECRET_DETAIL_KEYS.has(normalizedKey) || hasSensitiveSuffix(normalizedKey, SECRET_DETAIL_SUFFIXES)) {
    return REDACTED_SECRET;
  }
  if (normalizedKey === "reason") {
    // Correction history intentionally retains its owner-entered rationale.
    // Elsewhere only bounded machine codes survive; arbitrary prose may quote
    // source material and is not suitable for the audit store.
    if (action && AUDIT_REASON_TEXT_ALLOWLIST.has(action)) return value;
    if (action === "source.item_failed" && typeof value === "string" && /^\[[a-z_]+\] /.test(value)) {
      return value;
    }
    if (typeof value === "string" && /^[a-z0-9_.:-]{1,100}$/i.test(value)) return value;
    return REDACTED_CONTENT;
  }
  if (CONTENT_DETAIL_KEYS.has(normalizedKey) || hasSensitiveSuffix(normalizedKey, CONTENT_DETAIL_SUFFIXES)) {
    return REDACTED_CONTENT;
  }
  if (depth >= 8) return "[TRUNCATED_DEPTH]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactAuditValue(item, key, depth + 1, action));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100)
      .map(([entryKey, entryValue]) => [entryKey, redactAuditValue(entryValue, entryKey, depth + 1, action)]));
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}[TRUNCATED]`;
  return value;
}

export function sanitizeAuditDetails(
  details: Record<string, any> | undefined,
  action?: string,
): Record<string, unknown> | undefined {
  return details ? redactAuditValue(details, undefined, 0, action) as Record<string, unknown> : undefined;
}

export function isMandatoryAuditAction(action: string): boolean {
  return MANDATORY_AUDIT_ACTIONS.has(action);
}

function auditEventId(log: AuditLogInput): string {
  if (!log.idempotencyKey) return nanoid();
  const digest = createHash("sha256")
    .update(`${log.action}\0${log.idempotencyKey}`)
    .digest("hex")
    .slice(0, 32);
  return `AUD-${digest}`;
}

function signalMandatoryAuditFailure(log: AuditLogInput, error: unknown): void {
  console.error("[Audit][MANDATORY] Durable audit write failed", {
    action: log.action,
    entityType: log.entityType ?? null,
    entityId: log.entityId ?? null,
    error: error instanceof Error ? error.message : "unknown audit storage failure",
  });
}

export function writeAuditLogOrThrow(db: any, log: AuditLogInput): string {
  const details = sanitizeAuditDetails(log.details, log.action);
  const auditLog: InsertAuditLog = {
    id: auditEventId(log),
    userId: log.userId,
    action: log.action,
    entityType: log.entityType,
    entityId: log.entityId,
    details: details ? JSON.stringify(details) : null,
    ipAddress: log.ipAddress,
    userAgent: log.userAgent,
    createdAt: new Date(),
  };
  try {
    const insert = log.idempotencyKey
      ? db.insert(auditLogs).values(auditLog).onConflictDoNothing().run()
      : db.insert(auditLogs).values(auditLog).run();
    if (log.idempotencyKey && Number(insert?.changes ?? 0) === 0) {
      const existing = db.select().from(auditLogs).where(eq(auditLogs.id, auditLog.id)).get();
      const sameEvent = existing && existing.userId === (auditLog.userId ?? null) &&
        existing.action === auditLog.action && existing.entityType === (auditLog.entityType ?? null) &&
        existing.entityId === (auditLog.entityId ?? null) && existing.details === (auditLog.details ?? null);
      if (!sameEvent) throw new Error("Audit idempotency key conflicts with a different event");
    }
    return auditLog.id;
  } catch (error) {
    if (isMandatoryAuditAction(log.action)) signalMandatoryAuditFailure(log, error);
    throw error;
  }
}

export async function createAuditLog(log: AuditLogInput): Promise<void> {
  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
    if (!db) throw new Error("Audit database not available");
  } catch (error) {
    if (isMandatoryAuditAction(log.action)) {
      signalMandatoryAuditFailure(log, error);
      throw error;
    }
    console.error("[Audit] Failed to create best-effort audit log:", error);
    return;
  }
  try {
    writeAuditLogOrThrow(db, log);
  } catch (error) {
    if (isMandatoryAuditAction(log.action)) throw error;
    console.error("[Audit] Failed to create best-effort audit log:", error);
  }
}

export async function getAuditLogs(options: {
  userId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  limit?: number;
}) {
  const db = await getDb();
  if (!db) {
    console.warn("[Audit] Cannot get audit logs: database not available");
    return [];
  }

  try {
    // Phase 019: actually apply the filters (previously ignored). Ownership is
    // enforced by callers passing the authenticated userId.
    const conditions = [];
    if (options.userId) conditions.push(eq(auditLogs.userId, options.userId));
    if (options.entityType) conditions.push(eq(auditLogs.entityType, options.entityType));
    if (options.entityId) conditions.push(eq(auditLogs.entityId, options.entityId));
    if (options.action) conditions.push(eq(auditLogs.action, options.action));

    const base = db.select().from(auditLogs);
    const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
    const results = await filtered
      .orderBy(desc(auditLogs.createdAt))
      .limit(options.limit || 100);

    return results.map((log) => ({
      ...log,
      details: log.details ? JSON.parse(log.details) : null,
    }));
  } catch (error) {
    console.error("[Audit] Failed to get audit logs:", error);
    return [];
  }
}

// Audit action constants
export const AUDIT_ACTIONS = {
  // Case actions
  CASE_CREATED: "case.created",
  CASE_UPDATED: "case.updated",
  CASE_DELETED: "case.deleted",
  CASE_CLARIFICATION_ANSWERED: "case.clarification_answered",
  CASE_STATUS_CHANGED: "case.status_changed",
  CASE_SHARE_INVITED: "case.share_invited",
  CASE_SHARE_ACCEPTED: "case.share_accepted",
  CASE_SHARE_UPDATED: "case.share_updated",
  CASE_SHARE_REVOKED: "case.share_revoked",
  
  // Lawyer actions
  LAWYER_CREATED: "lawyer.created",
  LAWYER_UPDATED: "lawyer.updated",
  LAWYER_DELETED: "lawyer.deleted",
  
  // Email actions
  EMAIL_SENT: "email.sent",
  EMAIL_RESPONSE_RECEIVED: "email.response_received",
  EMAIL_TEST_ATTEMPTED: "email.test_attempted",
  EMAIL_TEST_DENIED: "email.test_denied",
  EMAIL_TEST_RATE_LIMITED: "email.test_rate_limited",
  EMAIL_TEST_FAILED: "email.test_failed",
  EMAIL_TEST_DELIVERED: "email.test_delivered",

  // Provider connection actions
  PROVIDER_CONNECTED: "provider.connected",
  PROVIDER_CREDENTIALS_INVALIDATED: "provider.credentials_invalidated",
  PROVIDER_CREDENTIALS_REFRESHED: "provider.credentials_refreshed",
  PROVIDER_DISCONNECTED: "provider.disconnected",
  PROVIDER_DISCONNECT_REVOKED: "provider.disconnect_revoked",
  PROVIDER_DISCONNECT_FAILED: "provider.disconnect_failed",
  PROVIDER_ACCEPTANCE_RECORDED: "provider.acceptance_recorded",

  // Case-scoped public-source research
  PUBLIC_RESEARCH_RECORDED: "legal_source.public_research_recorded",

  // Immutable reviewed legal-draft snapshots
  LEGAL_DRAFT_RECIPIENT_REVIEWED: "legal_draft.recipient_reviewed",
  LEGAL_DRAFT_REVIEWED: "legal_draft.reviewed",
  LEGAL_DRAFT_DOWNLOADED: "legal_draft.downloaded",

  // Evidence actions
  EVIDENCE_EXPORTED: "evidence.exported",
  EVIDENCE_SCORED: "evidence.scored",
  EVIDENCE_SOURCE_OPENED: "evidence.source_opened",
  EVIDENCE_SCANNER_UPLOADED: "evidence.scanner_uploaded",
  
  // Outreach actions
  OUTREACH_INITIATED: "outreach.initiated",
  OUTREACH_FOLLOW_UP: "outreach.follow_up",
  OUTREACH_STATUS_CHANGED: "outreach.status_changed",
  OUTREACH_DISPATCH_RESOLVED: "outreach.dispatch_resolved",
  
  // System actions
  USER_LOGIN: "user.login",
  USER_LOGOUT: "user.logout",
  USER_PASSWORD_RESET: "user.password_reset",
  SETTINGS_CHANGED: "settings.changed",
  SCRAPER_RUN: "scraper.run",
} as const;
