/**
 * Canonical persisted notification writer.
 *
 * A notification is only reported as created after its row is durable. The
 * per-owner deduplication key lives on that same row, so persistence and the
 * decision to suppress a retry cannot diverge.
 */
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import {
  buildNotificationDestination,
  type NotificationContext,
  type NotificationKind,
} from "../shared/notifications";
import { getDb } from "./db";
import { cases, evidence, lawyers, notifications, outreachStatus, users } from "./schema";
import { emitRealtimeNotification } from "./realtime";

const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 4_000;
const MAX_ID_LENGTH = 255;
const MAX_DEDUP_KEY_LENGTH = 500;
const MAX_METADATA_LENGTH = 16_000;

export interface CreateNotificationInput extends NotificationContext {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
  dedupKey?: string;
}

export type NotificationWriteResult =
  | { outcome: "created"; persisted: true; id: string }
  | { outcome: "already-exists"; persisted: true; id: string }
  | {
    outcome: "failure";
    persisted: false;
    reason: "invalid-input" | "invalid-context" | "database-unavailable" | "storage-error";
    retryable: boolean;
  };

function validIdentifier(value: string | null | undefined, required = false): boolean {
  if (value == null) return !required;
  return value.length > 0 && value.length <= MAX_ID_LENGTH && value.trim() === value;
}

function serializeMetadata(value: Record<string, unknown> | undefined): string | null | undefined {
  if (value === undefined) return null;
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= MAX_METADATA_LENGTH ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function validateInput(params: CreateNotificationInput): {
  title: string;
  body: string | null;
  metadata: string | null;
  dedupKey: string | null;
} | null {
  const title = params.title.trim();
  const body = params.body?.trim() || null;
  const metadata = serializeMetadata(params.metadata);
  const dedupKey = params.dedupKey ?? null;
  if (
    !validIdentifier(params.userId, true)
    || !validIdentifier(params.caseId)
    || !validIdentifier(params.lawyerId)
    || !validIdentifier(params.evidenceFileId)
    || title.length === 0
    || title.length > MAX_TITLE_LENGTH
    || (body?.length ?? 0) > MAX_BODY_LENGTH
    || metadata === undefined
    || (dedupKey !== null && (dedupKey.length === 0 || dedupKey.length > MAX_DEDUP_KEY_LENGTH || dedupKey.trim() !== dedupKey))
  ) return null;
  return { title, body, metadata, dedupKey };
}

function contextIsValid(tx: any, params: CreateNotificationInput): boolean {
  const user = tx.select({ id: users.id }).from(users).where(eq(users.id, params.userId)).get();
  if (!user) return false;

  const ownedCase = params.caseId
    ? tx.select({ id: cases.id }).from(cases).where(and(eq(cases.id, params.caseId), eq(cases.userId, params.userId))).get()
    : null;
  if (params.caseId && !ownedCase) return false;

  if (params.evidenceFileId) {
    if (!params.caseId) return false;
    const ownedEvidence = tx.select({ id: evidence.id }).from(evidence).where(and(
      eq(evidence.id, params.evidenceFileId),
      eq(evidence.userId, params.userId),
      eq(evidence.caseId, params.caseId),
    )).get();
    if (!ownedEvidence) return false;
  }

  if (params.lawyerId) {
    if (!params.caseId) return false;
    const lawyer = tx.select({ id: lawyers.id }).from(lawyers).where(eq(lawyers.id, params.lawyerId)).get();
    const caseLawyer = tx.select({ id: outreachStatus.id }).from(outreachStatus).where(and(
      eq(outreachStatus.caseId, params.caseId),
      eq(outreachStatus.lawyerId, params.lawyerId),
    )).get();
    if (!lawyer || !caseLawyer) return false;
  }

  switch (params.kind) {
    case "lawyer_response":
    case "new_match":
      return Boolean(params.caseId && params.lawyerId);
    case "case_status_change":
    case "deadline_reminder":
      return Boolean(params.caseId);
    case "evidence_uploaded":
      return Boolean(params.caseId && params.evidenceFileId);
    case "system_announcement":
      return !params.caseId && !params.lawyerId && !params.evidenceFileId;
  }
}

export async function createNotification(params: CreateNotificationInput): Promise<NotificationWriteResult> {
  const normalized = validateInput(params);
  if (!normalized) {
    return { outcome: "failure", persisted: false, reason: "invalid-input", retryable: false };
  }

  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch (error) {
    console.error("[Notifications] Database initialization failed:", error);
    return { outcome: "failure", persisted: false, reason: "database-unavailable", retryable: true };
  }
  if (!db) return { outcome: "failure", persisted: false, reason: "database-unavailable", retryable: true };

  try {
    const result = db.transaction((tx: any): NotificationWriteResult => {
      if (!contextIsValid(tx, params)) {
        return { outcome: "failure", persisted: false, reason: "invalid-context", retryable: false };
      }
      const id = nanoid();
      const actionUrl = buildNotificationDestination(params.kind, params);
      const insert = tx.insert(notifications).values({
        id,
        userId: params.userId,
        kind: params.kind,
        title: normalized.title,
        body: normalized.body,
        actionUrl,
        metadata: normalized.metadata,
        caseId: params.caseId ?? null,
        lawyerId: params.lawyerId ?? null,
        evidenceFileId: params.evidenceFileId ?? null,
        dedupKey: normalized.dedupKey,
        read: false,
        createdAt: new Date(),
      }).onConflictDoNothing().run();

      if (Number(insert.changes || 0) === 1) {
        return { outcome: "created", persisted: true, id };
      }
      if (normalized.dedupKey) {
        const existing = tx.select({ id: notifications.id }).from(notifications).where(and(
          eq(notifications.userId, params.userId),
          eq(notifications.dedupKey, normalized.dedupKey),
        )).get();
        if (existing) return { outcome: "already-exists", persisted: true, id: existing.id };
      }
      return { outcome: "failure", persisted: false, reason: "storage-error", retryable: true };
    });

    if (result.outcome === "created") {
      emitRealtimeNotification(params.userId, { title: normalized.title, message: normalized.body ?? undefined });
    }
    return result;
  } catch (error) {
    console.error("[Notifications] Durable insert failed:", error);
    return { outcome: "failure", persisted: false, reason: "storage-error", retryable: true };
  }
}
