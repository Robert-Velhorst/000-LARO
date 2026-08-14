import { z } from "zod";
import { nanoid } from "nanoid";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { assertCaseOwnership } from "../_core/authz";
import { enforceRateLimit, RATE_LIMITS } from "../rateLimit";
import { createAuditLog, AUDIT_ACTIONS } from "../audit";
import { createNotification } from "../notifications";
import { getFlag } from "../featureFlags";
import { assertNotEmergencyStopped } from "../systemState";
import { assertOutreachTransition } from "../stateMachines";
import { cases as casesTable, outreachStatus, lawyers } from '../schema';
import { eq, and, inArray } from "drizzle-orm";
import { findCaseLawyersWithOfficialDirectory } from "../matching";
import { getWorkflowPreferences } from "../workflowPreferences";

// Phase 026 — outreach review/approval states.
const OUTREACH_PENDING = "PendingApproval";
const OUTREACH_APPROVED = "Approved";
const OUTREACH_REJECTED = "Rejected";

async function prepareOutreachDraftRows(caseId: string, maxResults: number, userId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  let matches: Array<{ id: string; name: string }>;
  let directoryStatus = "not_applicable";
  try {
    const result = await findCaseLawyersWithOfficialDirectory(caseId, { maxResults, sortBy: "score" });
    matches = result.lawyers;
    directoryStatus = result.directory.status;
  } catch (error) {
    return { created: 0, candidates: 0, reason: error instanceof Error ? error.message : "No matches" };
  }

  let created = 0;
  const preferences = await getWorkflowPreferences(userId);
  const initialStatus = preferences.messageApprovalMode === "automatic"
    ? OUTREACH_APPROVED
    : OUTREACH_PENDING;
  for (const match of matches) {
    const result = await db.insert(outreachStatus).values({
      id: nanoid(),
      caseId,
      lawyerId: match.id,
      status: initialStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any).onConflictDoNothing();
    if ((result as any)?.changes ?? 1) created += 1;
  }
  let automaticallyApproved = initialStatus === OUTREACH_APPROVED ? created : 0;
  if (initialStatus === OUTREACH_APPROVED) {
    const upgraded = await db
      .update(outreachStatus)
      .set({ status: OUTREACH_APPROVED, updatedAt: new Date() })
      .where(and(eq(outreachStatus.caseId, caseId), eq(outreachStatus.status, OUTREACH_PENDING)));
    automaticallyApproved += Number(upgraded.changes || 0);
  }
  return {
    created,
    candidates: matches.length,
    directoryStatus,
    approvalMode: preferences.messageApprovalMode,
    automaticallyApproved,
  };
}

export const workflowRouter = router({
  /**
   * Move a case into the "Outreach" stage.
   *
   * Phases 008/017/018/019:
   *  - protected + case-ownership (008),
   *  - idempotent: if the case is already in Outreach we do NOT re-write or
   *    re-audit, and report `alreadyInitiated` (017),
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

      const existing = await db
        .select({ status: casesTable.status })
        .from(casesTable)
        .where(eq(casesTable.id, input.caseId))
        .limit(1);

      const alreadyInitiated = existing[0]?.status === "Outreach";
      if (!alreadyInitiated) {
        await db.update(casesTable)
          .set({ status: "Outreach", updatedAt: new Date() })
          .where(eq(casesTable.id, input.caseId));
      }

      const drafts = await prepareOutreachDraftRows(input.caseId, input.maxResults, ctx.user.id);

      await createAuditLog({
        userId: ctx.user.id,
        action: AUDIT_ACTIONS.OUTREACH_INITIATED,
        entityType: "case",
        entityId: input.caseId,
        details: { from: existing[0]?.status ?? null, to: "Outreach", draftsPrepared: drafts.candidates, approvalMode: drafts.approvalMode },
      });

      return { success: true, alreadyInitiated, ...drafts } as const;
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
    .input(z.object({ outreachId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await assertNotEmergencyStopped(); // Phase 104 — approval also halts under stop
      return setDraftStatus(ctx.user.id, input.outreachId, OUTREACH_APPROVED);
    }),

  approveDrafts: protectedProcedure
    .input(z.object({
      outreachIds: z.array(z.string().min(1)).min(1).max(50)
        .refine((ids) => new Set(ids).size === ids.length, "Duplicate outreach draft IDs are not allowed"),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertNotEmergencyStopped();
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const ids = input.outreachIds;
      const rows = await db.select({ id: outreachStatus.id, caseId: outreachStatus.caseId, status: outreachStatus.status })
        .from(outreachStatus)
        .where(inArray(outreachStatus.id, ids));
      if (rows.length !== ids.length) throw new Error("One or more outreach drafts were not found");
      for (const row of rows) {
        if (!row.caseId) throw new Error("Outreach draft is not linked to a case");
        await assertCaseOwnership(row.caseId, ctx.user.id);
        assertOutreachTransition(row.status ?? null, OUTREACH_APPROVED);
      }
      const results = [];
      for (const outreachId of ids) {
        results.push(await setDraftStatus(ctx.user.id, outreachId, OUTREACH_APPROVED));
      }
      return { success: true as const, approved: results.length, sent: false as const };
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
      const { LEGAL_DISCLAIMER } = await import("../../shared/const");
      const sendEnabled = await getFlag("outreach.send.enabled");

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
        disclaimer: LEGAL_DISCLAIMER,
      };
    }),
});

async function setDraftStatus(userId: string, outreachId: string, newStatus: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const row = (
    await db.select().from(outreachStatus).where(eq(outreachStatus.id, outreachId)).limit(1)
  )[0];
  if (!row || !row.caseId) throw new Error("Outreach draft not found");

  // Ownership: the draft's case must belong to the user.
  await assertCaseOwnership(row.caseId, userId);

  // Phase 059: enforce the outreach state machine (PendingApproval -> Approved/Rejected).
  assertOutreachTransition(row.status ?? null, newStatus);

  await db
    .update(outreachStatus)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(outreachStatus.id, outreachId));

  await createAuditLog({
    userId,
    action: AUDIT_ACTIONS.OUTREACH_STATUS_CHANGED,
    entityType: "outreach",
    entityId: outreachId,
    details: { from: row.status, to: newStatus },
  });

  await createNotification({ // Phase 027
    userId,
    title: newStatus === "Approved" ? "Outreach draft approved" : "Outreach draft rejected",
    body:
      newStatus === "Approved"
        ? "The draft is marked ready to send. No message has been sent yet."
        : "The draft was rejected and will not be sent.",
  });

  // Approving marks the draft ready-to-send; actual transmission is a later
  // phase and additionally gated by the `outreach.send.enabled` feature flag
  // (default OFF). No lawyer is contacted here regardless.
  const sendEnabled = await getFlag("outreach.send.enabled");
  return { success: true, status: newStatus, sent: false as const, sendEnabled };
}
