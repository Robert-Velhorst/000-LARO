/**
 * Phase 011/026/017 — the REAL outreach send path.
 *
 * This actually transmits an approved outreach message to a lawyer, but every
 * safety gate the project promised stays in force:
 *   - `outreach.send.enabled` feature flag (default OFF) — no send unless an
 *     operator explicitly enables it,
 *   - emergency stop (Phase 104) — a global halt overrides everything,
 *   - the draft MUST be in `Approved` state (human approval gate, Phase 026),
 *   - ownership is enforced,
 *   - IDEMPOTENCY (Phase 017): a per-outreach guard + the `Sent` state prevent
 *     double-sending under retries/races,
 *   - if no email provider is configured the send FAILS HONESTLY
 *     (PROVIDER_NOT_CONFIGURED) — it is never marked Sent without real delivery.
 *
 * The email sender is injectable so tests exercise the full path with a fake
 * provider and never contact a real lawyer.
 */
import { getDb } from "./db";
import {
  auditLogs,
  outreachStatus,
  cases as casesTable,
  lawyers as lawyersTable,
  systemConfig,
} from "./schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getFlag } from "./featureFlags";
import { assertNotEmergencyStopped } from "./systemState";
import { assertOutreachTransition } from "./stateMachines";
import { createAuditLog, AUDIT_ACTIONS } from "./audit";
import { assertCaseOwnership } from "./_core/authz";
import { createNotification } from "./notifications";

export interface SendResult {
  outreachId: string;
  sent: boolean;
  alreadySent?: boolean;
  provider?: string;
  to?: string;
}

export type EmailSender = (email: { to: string; subject: string; text: string }) => Promise<{ delivered: boolean; provider: string }>;

const SENT_GUARD_PREFIX = "sent:";

export type UncertainDispatchOutcome = "delivered" | "not_delivered";

export interface UncertainDispatchRecord {
  outreachId: string;
  caseId: string | null;
  caseType: string | null;
  lawyerName: string | null;
  outreachStatus: string | null;
  dispatchState: string;
  detectedAt: Date | null;
}

function readDispatchGuard(db: any, guardKey: string): string | null {
  const [guard] = db
    .select({ value: systemConfig.configValue })
    .from(systemConfig)
    .where(eq(systemConfig.configKey, guardKey))
    .all();
  return guard?.value ?? null;
}

function claimDispatch(db: any, guardKey: string, dispatchId: string): boolean {
  return db.transaction((tx: any) => {
    const result = tx
      .insert(systemConfig)
      .values({
        configKey: guardKey,
        configValue: `dispatching:${dispatchId}`,
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
    return Number(result.changes || 0) === 1;
  });
}

function releaseUndeliveredClaim(db: any, guardKey: string, dispatchState: string): void {
  db.delete(systemConfig)
    .where(and(
      eq(systemConfig.configKey, guardKey),
      eq(systemConfig.configValue, dispatchState),
    ))
    .run();
}

function markDispatchUncertain(db: any, guardKey: string, dispatchState: string): void {
  db.update(systemConfig)
    .set({ configValue: `uncertain:${dispatchState.slice("dispatching:".length)}`, updatedAt: new Date() })
    .where(and(
      eq(systemConfig.configKey, guardKey),
      eq(systemConfig.configValue, dispatchState),
    ))
    .run();
}

const defaultSender: EmailSender = async (email) => {
  const { sendSystemEmail } = await import("./systemEmail");
  const r = await sendSystemEmail({ to: email.to, subject: email.subject, text: email.text } as any);
  return { delivered: !!r.delivered, provider: r.provider };
};

export async function listUncertainOutreachDispatches(): Promise<UncertainDispatchRecord[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const guards = await db
    .select({ key: systemConfig.configKey, value: systemConfig.configValue, updatedAt: systemConfig.updatedAt })
    .from(systemConfig)
    .where(and(
      like(systemConfig.configKey, `${SENT_GUARD_PREFIX}%`),
      like(systemConfig.configValue, "uncertain:%"),
    ));
  const outreachIds = guards.map((guard) => guard.key.slice(SENT_GUARD_PREFIX.length));
  if (outreachIds.length === 0) return [];

  const outreachRows = await db
    .select()
    .from(outreachStatus)
    .where(inArray(outreachStatus.id, outreachIds));
  const caseIds = [...new Set(outreachRows.flatMap((row) => row.caseId ? [row.caseId] : []))];
  const lawyerIds = [...new Set(outreachRows.flatMap((row) => row.lawyerId ? [row.lawyerId] : []))];
  const caseRows = caseIds.length > 0
    ? await db.select({ id: casesTable.id, caseType: casesTable.caseType }).from(casesTable).where(inArray(casesTable.id, caseIds))
    : [];
  const lawyerRows = lawyerIds.length > 0
    ? await db.select({ id: lawyersTable.id, name: lawyersTable.name }).from(lawyersTable).where(inArray(lawyersTable.id, lawyerIds))
    : [];
  const outreachById = new Map(outreachRows.map((row) => [row.id, row]));
  const caseTypeById = new Map(caseRows.map((row) => [row.id, row.caseType]));
  const lawyerNameById = new Map(lawyerRows.map((row) => [row.id, row.name]));

  return guards.map((guard) => {
    const outreachId = guard.key.slice(SENT_GUARD_PREFIX.length);
    const row = outreachById.get(outreachId);
    return {
      outreachId,
      caseId: row?.caseId ?? null,
      caseType: row?.caseId ? caseTypeById.get(row.caseId) ?? null : null,
      lawyerName: row?.lawyerId ? lawyerNameById.get(row.lawyerId) ?? null : null,
      outreachStatus: row?.status ?? null,
      dispatchState: guard.value || "uncertain:unknown",
      detectedAt: guard.updatedAt ?? null,
    };
  });
}

export async function resolveUncertainOutreachDispatch(options: {
  operatorUserId: string;
  outreachId: string;
  outcome: UncertainDispatchOutcome;
  note: string;
  providerReference?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const guardKey = `${SENT_GUARD_PREFIX}${options.outreachId}`;
  const guardState = readDispatchGuard(db, guardKey);
  if (!guardState?.startsWith("uncertain:")) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "CONFLICT", message: "This outreach has no uncertain delivery to resolve." });
  }

  const [row] = await db.select().from(outreachStatus).where(eq(outreachStatus.id, options.outreachId)).limit(1);
  if (!row) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "NOT_FOUND", message: "Outreach record not found." });
  }
  if (options.outcome === "delivered" && !["Approved", "Sent"].includes(row.status || "")) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "CONFLICT", message: `Cannot confirm delivery from outreach state ${row.status || "unknown"}.` });
  }

  const resolvedAt = new Date();
  db.transaction((tx: any) => {
    const guardMutation = options.outcome === "delivered"
      ? tx.update(systemConfig)
        .set({ configValue: "sent", updatedAt: resolvedAt })
        .where(and(eq(systemConfig.configKey, guardKey), eq(systemConfig.configValue, guardState)))
        .run()
      : tx.delete(systemConfig)
        .where(and(eq(systemConfig.configKey, guardKey), eq(systemConfig.configValue, guardState)))
        .run();
    if (Number(guardMutation.changes || 0) !== 1) {
      throw new Error("Outreach dispatch state changed before recovery was finalized");
    }

    if (options.outcome === "delivered" && row.status === "Approved") {
      assertOutreachTransition("Approved", "Sent");
      tx.update(outreachStatus).set({
        status: "Sent",
        initialContact: row.initialContact ?? resolvedAt,
        lastContact: resolvedAt,
        updatedAt: resolvedAt,
      }).where(eq(outreachStatus.id, options.outreachId)).run();
      tx.insert(auditLogs).values({
        id: nanoid(),
        userId: options.operatorUserId,
        action: AUDIT_ACTIONS.OUTREACH_STATUS_CHANGED,
        entityType: "outreach",
        entityId: options.outreachId,
        details: JSON.stringify({ from: "Approved", to: "Sent", provider: "operator-verified", recovery: true }),
        createdAt: resolvedAt,
      }).run();
    }

    tx.insert(auditLogs).values({
      id: nanoid(),
      userId: options.operatorUserId,
      action: AUDIT_ACTIONS.OUTREACH_DISPATCH_RESOLVED,
      entityType: "outreach",
      entityId: options.outreachId,
      details: JSON.stringify({
        outcome: options.outcome,
        providerVerified: true,
        providerReference: options.providerReference?.trim() || null,
        note: options.note.trim(),
        previousDispatchState: guardState,
      }),
      createdAt: resolvedAt,
    }).run();
  });

  return {
    outreachId: options.outreachId,
    outcome: options.outcome,
    canRetry: options.outcome === "not_delivered",
    status: options.outcome === "delivered" ? "Sent" : row.status,
  };
}

/**
 * Send one approved outreach draft. Honors every safety gate above.
 * `sender` is injectable (tests pass a fake); production uses systemEmail.
 */
export async function sendApprovedOutreach(
  userId: string,
  outreachId: string,
  sender: EmailSender = defaultSender,
): Promise<SendResult> {
  // Gate 1 — global emergency stop.
  await assertNotEmergencyStopped();

  // Gate 2 — feature flag (default OFF). Without it, nothing is ever sent.
  const enabled = await getFlag("outreach.send.enabled");
  if (!enabled) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "FORBIDDEN", message: "Sending is disabled (outreach.send.enabled=false). No message was sent." });
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const row = (await db.select().from(outreachStatus).where(eq(outreachStatus.id, outreachId)).limit(1))[0];
  if (!row || !row.caseId) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "NOT_FOUND", message: "Outreach draft not found." });
  }

  // Gate 3 — ownership.
  await assertCaseOwnership(row.caseId, userId);

  // Gate 4 — idempotency: already sent? Return without re-sending.
  const guardKey = `${SENT_GUARD_PREFIX}${outreachId}`;
  const existingGuard = readDispatchGuard(db, guardKey);
  if (row.status === "Sent" || existingGuard === "sent" || existingGuard === "true") {
    return { outreachId, sent: true, alreadySent: true };
  }
  if (existingGuard) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({
      code: "CONFLICT",
      message: existingGuard.startsWith("uncertain:")
        ? "Delivery outcome is uncertain. An operator must verify the provider before retrying."
        : "Delivery is already in progress. Wait for it to finish before retrying.",
    });
  }

  // Gate 5 — must be human-approved.
  if (row.status !== "Approved") {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "BAD_REQUEST", message: `Draft must be Approved before sending (current: ${row.status}).` });
  }

  // Resolve recipient (the matched lawyer's email).
  const lawyer = (await db.select().from(lawyersTable).where(eq(lawyersTable.id, row.lawyerId!)).limit(1))[0];
  const to = (lawyer as any)?.email;
  if (!to) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "BAD_REQUEST", message: "Matched lawyer has no email address; cannot send." });
  }

  const [caseRow] = await db.select().from(casesTable).where(eq(casesTable.id, row.caseId)).limit(1);
  const subject = `Legal assistance enquiry — ${(caseRow as any)?.caseType || "case"}`;
  const text =
    `Hello ${(lawyer as any)?.name || "there"},\n\n` +
    `A prospective client is seeking assistance with a ${(caseRow as any)?.caseType || "legal"} matter. ` +
    `They would like to know if you are able to help.\n\n` +
    `(Sent via LARO after explicit user approval. This is not legal advice.)`;

  // Transmit. If no provider is configured, delivered=false → fail honestly.
  const dispatchId = nanoid();
  const dispatchState = `dispatching:${dispatchId}`;
  if (!claimDispatch(db, guardKey, dispatchId)) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({
      code: "CONFLICT",
      message: "Delivery was claimed by another request. No duplicate message was sent.",
    });
  }

  let result: Awaited<ReturnType<EmailSender>>;
  try {
    result = await sender({ to, subject, text });
  } catch (error) {
    markDispatchUncertain(db, guardKey, dispatchState);
    throw error;
  }
  if (!result.delivered) {
    releaseUndeliveredClaim(db, guardKey, dispatchState);
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "No email provider is configured; nothing was sent. Configure SendGrid/SMTP." });
  }

  // Mark Sent (idempotently) + record.
  assertOutreachTransition(row.status ?? null, "Sent");
  const sentAt = new Date();
  try {
    db.transaction((tx: any) => {
      const guardUpdate = tx.update(systemConfig)
        .set({ configValue: "sent", updatedAt: sentAt })
        .where(and(
          eq(systemConfig.configKey, guardKey),
          eq(systemConfig.configValue, dispatchState),
        ))
        .run();
      if (Number(guardUpdate.changes || 0) !== 1) {
        throw new Error("Outreach dispatch reservation was lost before finalization");
      }

      tx.update(outreachStatus).set({
        status: "Sent",
        initialContact: row.initialContact ?? sentAt,
        lastContact: sentAt,
        updatedAt: sentAt,
      }).where(eq(outreachStatus.id, outreachId)).run();

      tx.insert(auditLogs).values({
        id: nanoid(),
        userId,
        action: AUDIT_ACTIONS.OUTREACH_STATUS_CHANGED,
        entityType: "outreach",
        entityId: outreachId,
        details: JSON.stringify({ from: "Approved", to: "Sent", provider: result.provider }),
        createdAt: sentAt,
      }).run();
    });
  } catch (error) {
    markDispatchUncertain(db, guardKey, dispatchState);
    throw error;
  }

  return { outreachId, sent: true, provider: result.provider, to };
}

export type LawyerResponse = "Interested" | "Declined" | "NoResponse";

/** Record a response without triggering any automatic third-party contact. */
export async function recordOutreachResponse(
  userId: string,
  outreachId: string,
  response: LawyerResponse,
  notes?: string,
): Promise<{ outreachId: string; status: LawyerResponse; caseId: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const row = (await db.select().from(outreachStatus).where(eq(outreachStatus.id, outreachId)).limit(1))[0];
  if (!row?.caseId) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({ code: "NOT_FOUND", message: "Outreach record not found." });
  }

  await assertCaseOwnership(row.caseId, userId);
  assertOutreachTransition(row.status ?? null, response);

  const respondedAt = new Date();
  const sentAt = row.lastContact ?? row.initialContact ?? row.updatedAt ?? row.createdAt;
  const responseTimeHours = sentAt
    ? Math.max(0, (respondedAt.getTime() - sentAt.getTime()) / 3_600_000).toFixed(2)
    : null;

  await db.update(outreachStatus).set({
    status: response,
    response: notes?.trim() || null,
    responseReceived: response === "NoResponse" ? "No" : "Yes",
    responseTimeHours,
    lastContact: respondedAt,
    updatedAt: respondedAt,
  }).where(eq(outreachStatus.id, outreachId));

  if (response === "Interested") {
    await db.update(casesTable).set({ status: "Matched", updatedAt: respondedAt }).where(eq(casesTable.id, row.caseId));
  }

  await createAuditLog({
    userId,
    action: AUDIT_ACTIONS.EMAIL_RESPONSE_RECEIVED,
    entityType: "outreach",
    entityId: outreachId,
    details: { caseId: row.caseId, lawyerId: row.lawyerId, from: row.status, to: response, notes: notes?.trim() || null },
  });
  await createNotification({
    userId,
    title: response === "Interested" ? "Lawyer is interested" : response === "Declined" ? "Lawyer declined" : "No lawyer response",
    body: notes?.trim() || `Outreach status changed to ${response}.`,
  });

  return { outreachId, status: response, caseId: row.caseId };
}
