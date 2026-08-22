import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { assertCaseOwnership } from "../_core/authz";
import { enforceRateLimit, RATE_LIMITS } from "../rateLimit";
import { createAuditLog, AUDIT_ACTIONS, writeAuditLogOrThrow } from "../audit";
import { createNotification } from "../notifications";
import { getFlag } from "../featureFlags";
import { assertNotEmergencyStopped } from "../systemState";
import { assertOutreachTransition } from "../stateMachines";
import { cases as casesTable, outreachStatus, lawyers } from '../schema';
import { eq, and, inArray, isNull } from "drizzle-orm";
import { findCaseLawyersWithOfficialDirectory } from "../matching";
import { getWorkflowPreferences } from "../workflowPreferences";
import { approveOutreachMessage, buildOutreachMessage, readApprovedOutreachMessage, readOutreachMetadata } from "../outreachApproval";
import { compareAndSetCaseStatusInTransaction } from "../caseTransitions";

// Phase 026 — outreach review/approval states.
const OUTREACH_PENDING = "PendingApproval";
const OUTREACH_APPROVED = "Approved";
const OUTREACH_REJECTED = "Rejected";

async function discoverOutreachDraftRows(caseId: string, maxResults: number, userId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  let matches: Array<{ id: string; name: string }>;
  let directoryStatus = "not_applicable";
  try {
    const result = await findCaseLawyersWithOfficialDirectory(caseId, { maxResults, sortBy: "score" });
    matches = result.lawyers;
    directoryStatus = result.directory.status;
  } catch (error) {
    return {
      matches: [],
      directoryStatus,
      approvalMode: (await getWorkflowPreferences(userId)).messageApprovalMode,
      reason: error instanceof Error ? error.message : "No matches",
    };
  }

  const preferences = await getWorkflowPreferences(userId);
  return {
    matches,
    directoryStatus,
    approvalMode: preferences.messageApprovalMode,
    reason: matches.length === 0 ? "No matching lawyers are available for an outreach draft." : undefined,
  };
}

function insertOutreachDraftRows(db: any, caseId: string, matches: Array<{ id: string; name: string }>): number {
  let created = 0;
  for (const match of matches) {
    const result = db.insert(outreachStatus).values({
      id: nanoid(),
      caseId,
      lawyerId: match.id,
      status: OUTREACH_PENDING,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any).onConflictDoNothing().run();
    if (Number(result?.changes ?? 0) === 1) created += 1;
  }
  return created;
}

async function prepareOutreachDraftRows(caseId: string, maxResults: number, userId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const plan = await discoverOutreachDraftRows(caseId, maxResults, userId);
  const created = plan.matches.length > 0
    ? db.transaction((tx: any) => insertOutreachDraftRows(tx, caseId, plan.matches))
    : 0;
  return {
    created,
    candidates: plan.matches.length,
    directoryStatus: plan.directoryStatus,
    approvalMode: plan.approvalMode,
    automaticallyApproved: 0,
    reason: plan.reason,
  };
}

export const workflowRouter = router({
  /**
   * Move a case into the "Outreach" stage.
   *
   * Phases 008/017/018/019:
   *  - protected + case-ownership (008),
   *  - idempotent: existing drafts are not duplicated, and an already-Outreach
   *    case reports `alreadyInitiated` while still filling any missing drafts (017),
   *  - rate-limited per user (018),
   *  - audited (019).
   *
   * NOTE: this only advances the case status. It does NOT contact any lawyer —
   * the outreach draft, human-approval gate, and real send are Phase 026 and are
   * intentionally not wired here (safety boundary: no third party is contacted
   * without approval).
   */
  initiateOutreach: protectedProcedure
    .input(z.object({ caseId: z.string(), maxResults: z.number().int().min(1).max(25).optional().default(5) }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      await assertNotEmergencyStopped();
      enforceRateLimit(ctx, "outreach", RATE_LIMITS.caseCreate);

      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const plan = await discoverOutreachDraftRows(input.caseId, input.maxResults, ctx.user.id);
      const [snapshot] = await db
        .select({ ownerId: casesTable.userId, status: casesTable.status })
        .from(casesTable)
        .where(eq(casesTable.id, input.caseId))
        .limit(1);
      if (!snapshot) throw new Error("Case not found");
      const alreadyInitiated = snapshot.status === "Outreach";

      if (plan.matches.length === 0) {
        await createAuditLog({
          userId: ctx.user.id,
          action: AUDIT_ACTIONS.OUTREACH_INITIATED,
          entityType: "case",
          entityId: input.caseId,
          details: { from: snapshot.status, to: snapshot.status, draftsPrepared: 0, statusChanged: false, reason: plan.reason },
        });
        return {
          success: false,
          alreadyInitiated,
          statusChanged: false,
          created: 0,
          candidates: 0,
          directoryStatus: plan.directoryStatus,
          approvalMode: plan.approvalMode,
          automaticallyApproved: 0,
          reason: plan.reason,
        } as const;
      }

      let created = 0;
      db.transaction((tx: any) => {
        compareAndSetCaseStatusInTransaction(tx, {
          caseId: input.caseId,
          ownerId: snapshot.ownerId,
          expectedStatus: snapshot.status,
          nextStatus: "Outreach",
          audit: {
            userId: ctx.user.id,
            action: AUDIT_ACTIONS.OUTREACH_INITIATED,
            entityType: "case",
            entityId: input.caseId,
            details: { from: snapshot.status, to: "Outreach", draftsPrepared: plan.matches.length, approvalMode: plan.approvalMode },
          },
        });
        created = insertOutreachDraftRows(tx, input.caseId, plan.matches);
      });

      return {
        success: true,
        alreadyInitiated,
        statusChanged: !alreadyInitiated,
        created,
        candidates: plan.matches.length,
        directoryStatus: plan.directoryStatus,
        approvalMode: plan.approvalMode,
        automaticallyApproved: 0,
      } as const;
    }),

  /**
   * Phase 026 — prepare outreach DRAFTS for human review.
   *
   * Runs the real matching engine and creates one outreach_status row per top
   * matched lawyer in the `PendingApproval` state. This is idempotent: the
   * unique (caseId, lawyerId) index means re-running does not duplicate drafts.
   * NOTHING is sent — drafts must be explicitly approved (below) and, even then,
   * the actual transmission is a later phase. This enforces the safety boundary:
   * no lawyer is contacted without human approval.
   */
  prepareDrafts: protectedProcedure
    .input(z.object({ caseId: z.string(), maxResults: z.number().optional().default(5) }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      await assertNotEmergencyStopped(); // Phase 104 — operator kill switch
      enforceRateLimit(ctx, "outreach-prepare", RATE_LIMITS.aiAnalysis);
      const drafts = await prepareOutreachDraftRows(input.caseId, input.maxResults, ctx.user.id);

      await createAuditLog({
        userId: ctx.user.id,
        action: AUDIT_ACTIONS.OUTREACH_INITIATED,
        entityType: "case",
        entityId: input.caseId,
        details: { draftsPrepared: drafts.candidates, approvalMode: drafts.approvalMode },
      });

      return { success: true, ...drafts };
    }),

  /**
   * Phase 026 — the human review queue: outreach drafts awaiting approval,
   * scoped to the caller's cases. Optionally filtered to a single case.
   */
  reviewQueue: protectedProcedure
    .input(z.object({ caseId: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) return [] as any[];

      // The user's case ids (ownership boundary).
      const ownCases = await db
        .select({ id: casesTable.id, clientName: casesTable.clientName })
        .from(casesTable)
        .where(eq(casesTable.userId, ctx.user.id));
      const allowed = new Set(ownCases.map((c) => c.id));
      const caseIds = input?.caseId
        ? (allowed.has(input.caseId) ? [input.caseId] : [])
        : [...allowed];
      if (caseIds.length === 0) return [] as any[];

      const rows = await db
        .select({
          id: outreachStatus.id,
          caseId: outreachStatus.caseId,
          lawyerId: outreachStatus.lawyerId,
          status: outreachStatus.status,
          lawyerName: lawyers.name,
          lawyerEmail: lawyers.email,
        })
        .from(outreachStatus)
        .leftJoin(lawyers, eq(outreachStatus.lawyerId, lawyers.id))
        .where(and(inArray(outreachStatus.caseId, caseIds), eq(outreachStatus.status, OUTREACH_PENDING)));
      return rows;
    }),

  /** Phase 026 — approve a draft (marks ready; does NOT send). */
  approveDraft: protectedProcedure
    .input(z.object({ outreachId: z.string(), approvalHash: z.string().regex(/^[a-f0-9]{64}$/) }))
    .mutation(async ({ input, ctx }) => {
      await assertNotEmergencyStopped(); // Phase 104 — approval also halts under stop
      return setDraftStatus(ctx.user.id, input.outreachId, OUTREACH_APPROVED, input.approvalHash);
    }),

  approveDrafts: protectedProcedure
    .input(z.object({
      approvals: z.array(z.object({
        outreachId: z.string().min(1),
        approvalHash: z.string().regex(/^[a-f0-9]{64}$/),
      })).min(1).max(50)
        .refine((items) => new Set(items.map((item) => item.outreachId)).size === items.length, "Duplicate outreach draft IDs are not allowed"),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertNotEmergencyStopped();
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const prepared: PreparedDraftStatus[] = [];
      for (const approval of input.approvals) {
        prepared.push(await prepareDraftStatus(ctx.user.id, approval.outreachId, OUTREACH_APPROVED, approval.approvalHash));
      }
      db.transaction((tx: any) => {
        for (const draft of prepared) applyDraftStatusInTransaction(tx, ctx.user.id, draft);
      });
      for (const draft of prepared) await notifyDraftStatus(ctx.user.id, draft.newStatus);
      return { success: true as const, approved: prepared.length, sent: false as const };
    }),

  /** Phase 026 — reject a draft. */
  rejectDraft: protectedProcedure
    .input(z.object({ outreachId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      return setDraftStatus(ctx.user.id, input.outreachId, OUTREACH_REJECTED);
    }),

  /**
   * Phase 011/026/017 — the REAL send. Transmits an approved draft to the matched
   * lawyer, but only when: emergency stop is released, `outreach.send.enabled` is
   * ON (default OFF), the draft is Approved, the caller owns the case, a provider
   * is configured, and it has not already been sent (idempotent). Fails honestly
   * otherwise; nothing is sent implicitly.
   */
  sendApproved: protectedProcedure
    .input(z.object({ outreachId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { sendApprovedOutreach } = await import("../outreachSend");
      return sendApprovedOutreach(ctx.user.id, input.outreachId);
    }),

  /** Record an inbound outcome with ownership and state-transition checks. */
  recordResponse: protectedProcedure
    .input(z.object({
      outreachId: z.string().min(1),
      response: z.enum(["Interested", "Declined", "NoResponse"]),
      notes: z.string().trim().max(5_000).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { recordOutreachResponse } = await import("../outreachSend");
      return recordOutreachResponse(ctx.user.id, input.outreachId, input.response, input.notes);
    }),

  /**
   * Phase 062 — pre-action safety review.
   *
   * Returns everything a human must see and confirm BEFORE any outreach is sent:
   * who will be contacted, the case, the mandatory legal disclaimer, whether the
   * action is reversible, what remains manual, and whether sending is even
   * enabled (feature flag, default off). The UI must render this as a review
   * screen and require explicit confirmation; the backend never sends implicitly.
   */
  preSendReview: protectedProcedure
    .input(z.object({ outreachId: z.string() }))
    .query(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const row = (
        await db
          .select({
            id: outreachStatus.id,
            caseId: outreachStatus.caseId,
            status: outreachStatus.status,
            metadata: outreachStatus.metadata,
            lawyerName: lawyers.name,
            lawyerEmail: lawyers.email,
          })
          .from(outreachStatus)
          .leftJoin(lawyers, eq(outreachStatus.lawyerId, lawyers.id))
          .where(eq(outreachStatus.id, input.outreachId))
          .limit(1)
      )[0];
      if (!row || !row.caseId) throw new Error("Outreach draft not found");
      await assertCaseOwnership(row.caseId, ctx.user.id);

      const caseRow = (await db.select().from(casesTable).where(eq(casesTable.id, row.caseId)).limit(1))[0];
      const sendEnabled = await getFlag("outreach.send.enabled");
      const approvedMessage = readApprovedOutreachMessage(row.metadata, row.id, row.caseId);
      const message = approvedMessage ?? buildOutreachMessage({
        outreachId: row.id,
        caseId: row.caseId,
        caseType: caseRow?.caseType,
        lawyerName: row.lawyerName,
        lawyerEmail: row.lawyerEmail,
      });

      return {
        outreachId: row.id,
        recipient: { name: row.lawyerName, email: row.lawyerEmail },
        case: caseRow ? { id: caseRow.id, clientName: caseRow.clientName, status: caseRow.status } : null,
        currentStatus: row.status,
        // Safety facts the review screen must present:
        externalAction: true,
        reversible: false, // once sent, an email to a lawyer cannot be recalled
        requiresExplicitApproval: true,
        sendEnabled, // if false, sending is disabled by an operator flag
        whatRemainsManual: sendEnabled
          ? "You must approve this draft; sending is performed only after approval."
          : "Sending is currently disabled by the operator (outreach.send.enabled=false). Nothing can be sent.",
        disclaimer: message.disclaimer,
        message,
      };
    }),
});

interface PreparedDraftStatus {
  outreachId: string;
  previousStatus: string | null;
  newStatus: string;
  metadata: string | null;
  updatedAt: Date;
}

async function prepareDraftStatus(
  userId: string,
  outreachId: string,
  newStatus: string,
  expectedApprovalHash?: string,
): Promise<PreparedDraftStatus> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const row = (
    await db.select().from(outreachStatus).where(eq(outreachStatus.id, outreachId)).limit(1)
  )[0];
  if (!row || !row.caseId) throw new Error("Outreach draft not found");

  await assertCaseOwnership(row.caseId, userId);
  assertOutreachTransition(row.status ?? null, newStatus);
  const updatedAt = new Date();
  let metadata = row.metadata;
  if (newStatus === OUTREACH_APPROVED) {
    const [lawyer] = await db.select().from(lawyers).where(eq(lawyers.id, row.lawyerId!)).limit(1);
    const [caseRow] = await db.select().from(casesTable).where(eq(casesTable.id, row.caseId)).limit(1);
    const message = buildOutreachMessage({
      outreachId,
      caseId: row.caseId,
      caseType: caseRow?.caseType,
      lawyerName: lawyer?.name,
      lawyerEmail: lawyer?.email,
    });
    if (!expectedApprovalHash || expectedApprovalHash !== message.approvalHash) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "The outreach message changed after review. Review the current recipient and message before approving.",
      });
    }
    metadata = JSON.stringify({
      ...readOutreachMetadata(row.metadata),
      approvedMessage: approveOutreachMessage({
        outreachId,
        caseId: row.caseId,
        ...message,
        approvedBy: userId,
        approvedAt: updatedAt.toISOString(),
      }),
    });
  }

  return {
    outreachId,
    previousStatus: row.status ?? null,
    newStatus,
    metadata,
    updatedAt,
  };
}

function applyDraftStatusInTransaction(tx: any, userId: string, draft: PreparedDraftStatus) {
  const result = tx
    .update(outreachStatus)
    .set({ status: draft.newStatus, metadata: draft.metadata, updatedAt: draft.updatedAt })
    .where(and(
      eq(outreachStatus.id, draft.outreachId),
      draft.previousStatus == null
        ? isNull(outreachStatus.status)
        : eq(outreachStatus.status, draft.previousStatus),
    ))
    .run();
  if (Number(result.changes || 0) !== 1) {
    throw new TRPCError({ code: "CONFLICT", message: "The outreach draft changed before this action completed. Refresh and try again." });
  }
  writeAuditLogOrThrow(tx, {
    userId,
    action: AUDIT_ACTIONS.OUTREACH_STATUS_CHANGED,
    entityType: "outreach",
    entityId: draft.outreachId,
    details: { from: draft.previousStatus, to: draft.newStatus },
  });
}

async function notifyDraftStatus(userId: string, newStatus: string) {
  await createNotification({
    userId,
    title: newStatus === OUTREACH_APPROVED ? "Outreach draft approved" : "Outreach draft rejected",
    body:
      newStatus === OUTREACH_APPROVED
        ? "The draft is marked ready to send. No message has been sent yet."
        : "The draft was rejected and will not be sent.",
  });
}

async function setDraftStatus(userId: string, outreachId: string, newStatus: string, expectedApprovalHash?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const prepared = await prepareDraftStatus(userId, outreachId, newStatus, expectedApprovalHash);
  db.transaction((tx: any) => {
    applyDraftStatusInTransaction(tx, userId, prepared);
  });
  await notifyDraftStatus(userId, newStatus);

  // Approving marks the draft ready-to-send; actual transmission is a later
  // phase and additionally gated by the `outreach.send.enabled` feature flag
  // (default OFF). No lawyer is contacted here regardless.
  const sendEnabled = await getFlag("outreach.send.enabled");
  return { success: true, status: newStatus, sent: false as const, sendEnabled };
}
