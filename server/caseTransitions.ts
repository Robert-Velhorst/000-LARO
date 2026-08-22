import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { assertCaseOwnership } from "./_core/authz";
import { getDb } from "./db";
import { cases } from "./schema";
import { assertCaseTransition } from "./stateMachines";

type CaseStatus = string | null;

interface CompareAndSetCaseStatusOptions {
  caseId: string;
  ownerId: string;
  expectedStatus: CaseStatus;
  nextStatus: string;
  changes?: {
    caseSummary?: string | null;
    urgency?: string | null;
    legalAreas?: string | null;
  };
  updatedAt?: Date;
}

interface TransitionOwnedCaseStatusOptions {
  caseId: string;
  actorUserId: string;
  nextStatus: string;
  changes?: CompareAndSetCaseStatusOptions["changes"];
  updatedAt?: Date;
}

function transitionConflict(): TRPCError {
  return new TRPCError({
    code: "CONFLICT",
    message: "Case status changed before this transition could be saved",
  });
}

export function compareAndSetCaseStatusInTransaction(
  db: any,
  options: CompareAndSetCaseStatusOptions,
): { previousStatus: CaseStatus; status: string } {
  assertCaseTransition(options.expectedStatus, options.nextStatus);
  const expectedStatus = options.expectedStatus == null
    ? isNull(cases.status)
    : eq(cases.status, options.expectedStatus);
  const result = db
    .update(cases)
    .set({
      ...(options.changes ?? {}),
      status: options.nextStatus,
      updatedAt: options.updatedAt ?? new Date(),
    })
    .where(and(
      eq(cases.id, options.caseId),
      eq(cases.userId, options.ownerId),
      expectedStatus,
    ))
    .run();

  if (Number(result?.changes ?? 0) !== 1) {
    throw transitionConflict();
  }
  return { previousStatus: options.expectedStatus, status: options.nextStatus };
}

export async function compareAndSetCaseStatus(
  db: any,
  options: CompareAndSetCaseStatusOptions,
): Promise<{ previousStatus: CaseStatus; status: string }> {
  return compareAndSetCaseStatusInTransaction(db, options);
}

export async function transitionOwnedCaseStatus(
  options: TransitionOwnedCaseStatusOptions,
): Promise<{ previousStatus: CaseStatus; status: string }> {
  await assertCaseOwnership(options.caseId, options.actorUserId);
  const db = await getDb();
  if (!db) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  }
  const [snapshot] = await db
    .select({ ownerId: cases.userId, status: cases.status })
    .from(cases)
    .where(eq(cases.id, options.caseId))
    .limit(1);
  if (!snapshot) {
    throw transitionConflict();
  }
  return compareAndSetCaseStatus(db, {
    caseId: options.caseId,
    ownerId: snapshot.ownerId,
    expectedStatus: snapshot.status,
    nextStatus: options.nextStatus,
    changes: options.changes,
    updatedAt: options.updatedAt,
  });
}
