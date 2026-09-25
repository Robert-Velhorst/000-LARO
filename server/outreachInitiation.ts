import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { AUDIT_ACTIONS, writeAuditLogOrThrow } from "./audit";
import { compareAndSetCaseStatusInTransaction } from "./caseTransitions";
import { getDb } from "./db";
import { findCaseLawyersWithOfficialDirectory } from "./matching";
import { cases, outreachStatus } from "./schema";
import { assertCaseTransition, isValidOutreachState } from "./stateMachines";
import { getWorkflowPreferences } from "./workflowPreferences";

const OUTREACH_PENDING = "PendingApproval";

type OutreachCandidate = {
  id: string;
  name: string;
};

type OutreachPlan = {
  matches: OutreachCandidate[];
  directoryStatus: string;
  approvalMode: string;
  reason?: string;
};

export type OutreachInitiationResult = {
  success: boolean;
  alreadyInitiated: boolean;
  statusChanged: boolean;
  created: number;
  candidates: number;
  directoryStatus: string;
  approvalMode: string;
  automaticallyApproved: 0;
  reason?: string;
};

function initiationConflict(message = "Case status changed before outreach initiation could be saved"): TRPCError {
  return new TRPCError({ code: "CONFLICT", message });
}

function assertReviewLifecycle(rows: Array<{ status: string | null }>): void {
  const invalid = rows.find((row) => !row.status || !isValidOutreachState(row.status));
  if (invalid) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "Existing outreach data must be reviewed before outreach can be initiated again.",
    });
  }
}

async function discoverOutreachPlan(caseId: string, maxResults: number, userId: string): Promise<OutreachPlan> {
  let matches: OutreachCandidate[] = [];
  let directoryStatus = "not_applicable";
  let reason: string | undefined;
  try {
    const result = await findCaseLawyersWithOfficialDirectory(caseId, { maxResults, sortBy: "score" });
    directoryStatus = result.directory.status;
    if (directoryStatus === "unavailable") {
      reason = result.directory.reason
        ?? result.directory.errors[0]
        ?? "The lawyer directory was unavailable; outreach was not initiated.";
    } else {
      const unique = new Map<string, OutreachCandidate>();
      for (const lawyer of result.lawyers) {
        if (lawyer.id && !unique.has(lawyer.id)) unique.set(lawyer.id, { id: lawyer.id, name: lawyer.name });
      }
      matches = [...unique.values()];
      if (matches.length === 0) reason = "No matching lawyers are available for an outreach draft.";
    }
  } catch (error) {
    reason = error instanceof Error ? error.message : "Lawyer matching could not be completed.";
  }

  const preferences = await getWorkflowPreferences(userId);
  return {
    matches,
    directoryStatus,
    approvalMode: preferences.messageApprovalMode,
    reason,
  };
}

function insertPendingDrafts(
  db: any,
  caseId: string,
  matches: OutreachCandidate[],
): number {
  const now = new Date();
  let created = 0;
  for (const match of matches) {
    const result = db.insert(outreachStatus).values({
      id: nanoid(),
      caseId,
      lawyerId: match.id,
      status: OUTREACH_PENDING,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({
      target: [outreachStatus.caseId, outreachStatus.lawyerId],
    }).run();
    if (Number(result?.changes ?? 0) === 1) created += 1;
  }
  return created;
}

function alreadyInitiatedResult(
  existingCount: number,
  approvalMode: string,
): OutreachInitiationResult {
  return {
    success: true,
    alreadyInitiated: true,
    statusChanged: false,
    created: 0,
    candidates: existingCount,
    directoryStatus: "not_requested_existing_initiation",
    approvalMode,
    automaticallyApproved: 0,
  };
}

/**
 * Atomically materialize reviewable outreach drafts and transition the case.
 * Matching is deliberately completed before the write transaction; the case is
 * then re-read and compare-and-set in that transaction so a stale discovery
 * result cannot overwrite a concurrent case transition.
 */
export async function initiateCaseOutreach(options: {
  caseId: string;
  userId: string;
  maxResults: number;
}): Promise<OutreachInitiationResult> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [snapshot] = await db.select({
    ownerId: cases.userId,
    status: cases.status,
  }).from(cases).where(and(
    eq(cases.id, options.caseId),
    eq(cases.userId, options.userId),
  )).limit(1);
  if (!snapshot) throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });

  // Reject Intake, Closed, and unknown source states before directory/provider
  // work. This is the same canonical guard used by every other case transition.
  assertCaseTransition(snapshot.status, "Outreach");

  const existingAtStart = await db.select({
    id: outreachStatus.id,
    status: outreachStatus.status,
  }).from(outreachStatus).where(eq(outreachStatus.caseId, options.caseId));
  if (snapshot.status === "Outreach" && existingAtStart.length > 0) {
    assertReviewLifecycle(existingAtStart);
    const preferences = await getWorkflowPreferences(options.userId);
    return alreadyInitiatedResult(existingAtStart.length, preferences.messageApprovalMode);
  }

  const plan = await discoverOutreachPlan(options.caseId, options.maxResults, options.userId);
  if (plan.matches.length === 0) {
    return {
      success: false,
      alreadyInitiated: snapshot.status === "Outreach",
      statusChanged: false,
      created: 0,
      candidates: 0,
      directoryStatus: plan.directoryStatus,
      approvalMode: plan.approvalMode,
      automaticallyApproved: 0,
      reason: plan.reason ?? "No matching lawyers are available for an outreach draft.",
    };
  }

  return db.transaction((tx: any): OutreachInitiationResult => {
    const current = tx.select({
      ownerId: cases.userId,
      status: cases.status,
    }).from(cases).where(and(
      eq(cases.id, options.caseId),
      eq(cases.userId, options.userId),
    )).get();
    if (!current) throw initiationConflict();

    const existing = tx.select({
      id: outreachStatus.id,
      lawyerId: outreachStatus.lawyerId,
      status: outreachStatus.status,
    }).from(outreachStatus).where(eq(outreachStatus.caseId, options.caseId)).all();

    // A concurrent identical request may have committed while discovery was in
    // progress. Treat that as an idempotent success and preserve every review
    // decision instead of creating or resetting a second draft set.
    if (current.status === "Outreach" && existing.length > 0) {
      assertReviewLifecycle(existing);
      return alreadyInitiatedResult(existing.length, plan.approvalMode);
    }
    if (current.status !== snapshot.status) throw initiationConflict();
    assertCaseTransition(current.status, "Outreach");

    const created = insertPendingDrafts(tx, options.caseId, plan.matches);
    const candidateIds = plan.matches.map((match) => match.id);
    const candidateRows = tx.select({
      status: outreachStatus.status,
    }).from(outreachStatus).where(and(
      eq(outreachStatus.caseId, options.caseId),
      inArray(outreachStatus.lawyerId, candidateIds),
    )).all();
    const reviewableDrafts = candidateRows.filter((row: { status: string | null }) => row.status === OUTREACH_PENDING).length;

    // A previous outreach round may already contain terminal/approved records
    // for every current candidate. Those records are never reset to Pending;
    // doing so would erase review history. With no new/pending work, keep the
    // case in its current state and report an honest no-op.
    if (reviewableDrafts === 0) {
      return {
        success: false,
        alreadyInitiated: false,
        statusChanged: false,
        created: 0,
        candidates: plan.matches.length,
        directoryStatus: plan.directoryStatus,
        approvalMode: plan.approvalMode,
        automaticallyApproved: 0,
        reason: "Matching lawyers already have outreach history; no new reviewable drafts were created.",
      };
    }

    const statusChanged = current.status !== "Outreach";
    compareAndSetCaseStatusInTransaction(tx, {
      caseId: options.caseId,
      ownerId: current.ownerId,
      expectedStatus: current.status,
      nextStatus: "Outreach",
      audit: {
        userId: options.userId,
        action: AUDIT_ACTIONS.OUTREACH_INITIATED,
        entityType: "case",
        entityId: options.caseId,
        details: {
          from: current.status,
          to: "Outreach",
          candidates: plan.matches.length,
          draftsPrepared: created,
          draftsReadyForReview: reviewableDrafts,
          statusChanged,
          approvalMode: plan.approvalMode,
        },
      },
    });

    return {
      success: true,
      alreadyInitiated: current.status === "Outreach",
      statusChanged,
      created,
      candidates: plan.matches.length,
      directoryStatus: plan.directoryStatus,
      approvalMode: plan.approvalMode,
      automaticallyApproved: 0,
    };
  });
}

export async function prepareOutreachDraftRows(caseId: string, maxResults: number, userId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const plan = await discoverOutreachPlan(caseId, maxResults, userId);
  const created = db.transaction((tx: any) => {
    const count = plan.matches.length > 0 ? insertPendingDrafts(tx, caseId, plan.matches) : 0;
    if (count > 0) writeAuditLogOrThrow(tx, {
      userId,
      action: AUDIT_ACTIONS.OUTREACH_INITIATED,
      entityType: "case",
      entityId: caseId,
      details: { draftsPrepared: count, approvalMode: plan.approvalMode },
    });
    return count;
  });
  return {
    created,
    candidates: plan.matches.length,
    directoryStatus: plan.directoryStatus,
    approvalMode: plan.approvalMode,
    automaticallyApproved: 0,
    reason: plan.reason,
  };
}
