import { TRPCError } from "@trpc/server";
import { getCaseAuthorization, type CaseShareCapability } from "../teams";

function forbidden(): never {
  // Do not distinguish a missing case from a case the caller cannot access.
  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Case not found or you do not have access to it",
  });
}

/** Require an accepted per-case share (or ownership) with a named capability. */
export async function assertCaseCapability(
  caseId: string,
  userId: string,
  capability: CaseShareCapability,
): Promise<void> {
  const authorization = await getCaseAuthorization(caseId, userId);
  if (!authorization?.capabilities.includes(capability)) forbidden();
}

/** Read boundary used by case-scoped queries and exports. */
export async function assertCaseAccess(caseId: string, userId: string): Promise<void> {
  await assertCaseCapability(caseId, userId, "case.read");
}

/** Strict owner boundary for sharing, deletion, and owner-only settings. */
export async function assertCaseOwner(caseId: string, userId: string): Promise<void> {
  const authorization = await getCaseAuthorization(caseId, userId);
  if (authorization?.role !== "owner") forbidden();
}

/**
 * Backward-compatible guard for existing mutation paths.
 *
 * Historically this function also allowed every global teammate. It now
 * requires a per-case accepted `case.edit` grant. Read-only procedures should
 * call `assertCaseAccess` explicitly.
 */
export async function assertCaseOwnership(caseId: string, userId: string): Promise<void> {
  await assertCaseCapability(caseId, userId, "case.edit");
}
