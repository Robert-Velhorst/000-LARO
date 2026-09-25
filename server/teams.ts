import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { AUDIT_ACTIONS, writeAuditLogOrThrow } from "./audit";
import { getDb } from "./db";
import { caseShares, cases, users } from "./schema";
import { findUserByEmailIdentity } from "./emailIdentity";

export const CASE_SHARE_ROLES = ["read_only", "collaborator"] as const;
export type CaseShareRole = (typeof CASE_SHARE_ROLES)[number];

export const CASE_SHARE_CAPABILITIES = [
  "case.read",
  "case.edit",
  "outreach.approve",
  "outreach.send",
] as const;
export type CaseShareCapability = (typeof CASE_SHARE_CAPABILITIES)[number];

const CAPABILITY_SET = new Set<string>(CASE_SHARE_CAPABILITIES);

/** Least-privilege defaults. External approval and sending are never implicit. */
export function normalizeShareCapabilities(
  role: CaseShareRole,
  requested: readonly string[] = [],
): CaseShareCapability[] {
  const result = new Set<CaseShareCapability>(["case.read"]);
  if (role === "collaborator") result.add("case.edit");
  if (role === "collaborator") {
    for (const capability of requested) {
      if (CAPABILITY_SET.has(capability)) result.add(capability as CaseShareCapability);
    }
  }
  // A sender must also be able to approve the exact message snapshot.
  if (result.has("outreach.send")) result.add("outreach.approve");
  return CASE_SHARE_CAPABILITIES.filter((capability) => result.has(capability));
}

export function parseShareCapabilities(value: string | null): CaseShareCapability[] {
  try {
    const parsed = JSON.parse(value || "[]");
    if (!Array.isArray(parsed)) return [];
    return CASE_SHARE_CAPABILITIES.filter((capability) => parsed.includes(capability));
  } catch {
    return [];
  }
}

async function assertOwner(caseId: string, ownerId: string, db: any) {
  const row = (await db
    .select({ id: cases.id, ownerId: cases.userId })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.userId, ownerId)))
    .limit(1))[0];
  if (!row) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Case not found or you are not its owner" });
  }
  return row;
}

export async function getCaseAuthorization(caseId: string, userId: string): Promise<{
  ownerId: string;
  role: "owner" | CaseShareRole;
  capabilities: CaseShareCapability[];
} | null> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  const caseRow = (await db
    .select({ ownerId: cases.userId })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1))[0];
  if (!caseRow) return null;
  if (caseRow.ownerId === userId) {
    return { ownerId: caseRow.ownerId, role: "owner", capabilities: [...CASE_SHARE_CAPABILITIES] };
  }
  const share = (await db
    .select({ role: caseShares.role, capabilities: caseShares.capabilities })
    .from(caseShares)
    .where(and(
      eq(caseShares.caseId, caseId),
      eq(caseShares.memberId, userId),
      eq(caseShares.status, "accepted"),
    ))
    .limit(1))[0];
  if (!share || !CASE_SHARE_ROLES.includes(share.role as CaseShareRole)) return null;
  const capabilities = parseShareCapabilities(share.capabilities);
  if (!capabilities.includes("case.read")) return null;
  return {
    ownerId: caseRow.ownerId,
    role: share.role as CaseShareRole,
    capabilities,
  };
}

export async function listCaseShares(ownerId: string, caseId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await assertOwner(caseId, ownerId, db);
  const rows = await db
    .select({
      id: caseShares.id,
      caseId: caseShares.caseId,
      memberId: caseShares.memberId,
      email: users.email,
      name: users.name,
      role: caseShares.role,
      capabilities: caseShares.capabilities,
      status: caseShares.status,
      invitedAt: caseShares.invitedAt,
      acceptedAt: caseShares.acceptedAt,
      revokedAt: caseShares.revokedAt,
      updatedAt: caseShares.updatedAt,
    })
    .from(caseShares)
    .innerJoin(users, eq(caseShares.memberId, users.id))
    .where(and(eq(caseShares.caseId, caseId), eq(caseShares.ownerId, ownerId)));
  return rows.map((row) => ({ ...row, capabilities: parseShareCapabilities(row.capabilities) }));
}

export async function listIncomingInvitations(memberId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db
    .select({
      id: caseShares.id,
      caseId: caseShares.caseId,
      ownerId: caseShares.ownerId,
      caseName: cases.clientName,
      role: caseShares.role,
      capabilities: caseShares.capabilities,
      status: caseShares.status,
      invitedAt: caseShares.invitedAt,
    })
    .from(caseShares)
    .innerJoin(cases, eq(caseShares.caseId, cases.id))
    .where(and(eq(caseShares.memberId, memberId), eq(caseShares.status, "pending")));
  return rows.map((row) => ({ ...row, capabilities: parseShareCapabilities(row.capabilities) }));
}

export async function inviteCaseMember(input: {
  ownerId: string;
  caseId: string;
  email: string;
  role: CaseShareRole;
  capabilities?: readonly string[];
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await assertOwner(input.caseId, input.ownerId, db);
  const target = await findUserByEmailIdentity(db, input.email);
  if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "No user with that email." });
  if (target.id === input.ownerId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A case owner cannot invite themselves." });
  }

  const now = new Date();
  const capabilities = normalizeShareCapabilities(input.role, input.capabilities);
  const id = nanoid();
  db.transaction((tx: any) => {
    tx.insert(caseShares).values({
      id,
      caseId: input.caseId,
      ownerId: input.ownerId,
      memberId: target.id,
      role: input.role,
      capabilities: JSON.stringify(capabilities),
      status: "pending",
      invitedAt: now,
      acceptedAt: null,
      revokedAt: null,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [caseShares.caseId, caseShares.memberId],
      set: {
        ownerId: input.ownerId,
        role: input.role,
        capabilities: JSON.stringify(capabilities),
        status: "pending",
        invitedAt: now,
        acceptedAt: null,
        revokedAt: null,
        updatedAt: now,
      },
    }).run();
    const current = tx.select({ id: caseShares.id })
      .from(caseShares)
      .where(and(eq(caseShares.caseId, input.caseId), eq(caseShares.memberId, target.id)))
      .get();
    writeAuditLogOrThrow(tx, {
      userId: input.ownerId,
      action: AUDIT_ACTIONS.CASE_SHARE_INVITED,
      entityType: "case_share",
      entityId: current?.id ?? id,
      details: { caseId: input.caseId, memberId: target.id, role: input.role, capabilities },
    });
  });
  return (await listCaseShares(input.ownerId, input.caseId)).find((share) => share.memberId === target.id)!;
}

export async function acceptCaseInvitation(memberId: string, shareId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const share = (await db.select().from(caseShares).where(and(
    eq(caseShares.id, shareId),
    eq(caseShares.memberId, memberId),
    eq(caseShares.status, "pending"),
  )).limit(1))[0];
  if (!share) throw new TRPCError({ code: "NOT_FOUND", message: "Pending invitation not found." });
  const now = new Date();
  db.transaction((tx: any) => {
    const result = tx.update(caseShares).set({ status: "accepted", acceptedAt: now, revokedAt: null, updatedAt: now })
      .where(and(eq(caseShares.id, shareId), eq(caseShares.memberId, memberId), eq(caseShares.status, "pending"))).run();
    if (Number(result.changes || 0) !== 1) {
      throw new TRPCError({ code: "CONFLICT", message: "The invitation changed before it was accepted." });
    }
    writeAuditLogOrThrow(tx, {
      userId: memberId,
      action: AUDIT_ACTIONS.CASE_SHARE_ACCEPTED,
      entityType: "case_share",
      entityId: shareId,
      details: { caseId: share.caseId, ownerId: share.ownerId },
    });
  });
  return { id: shareId, status: "accepted" as const };
}

export async function updateCaseShare(input: {
  ownerId: string;
  shareId: string;
  role: CaseShareRole;
  capabilities?: readonly string[];
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const share = (await db.select().from(caseShares).where(and(
    eq(caseShares.id, input.shareId),
    eq(caseShares.ownerId, input.ownerId),
  )).limit(1))[0];
  if (!share) throw new TRPCError({ code: "NOT_FOUND", message: "Case share not found." });
  await assertOwner(share.caseId, input.ownerId, db);
  const capabilities = normalizeShareCapabilities(input.role, input.capabilities);
  const now = new Date();
  db.transaction((tx: any) => {
    const result = tx.update(caseShares).set({
      role: input.role,
      capabilities: JSON.stringify(capabilities),
      updatedAt: now,
    }).where(and(eq(caseShares.id, input.shareId), eq(caseShares.ownerId, input.ownerId))).run();
    if (Number(result.changes || 0) !== 1) throw new TRPCError({ code: "CONFLICT", message: "Case share changed." });
    writeAuditLogOrThrow(tx, {
      userId: input.ownerId,
      action: AUDIT_ACTIONS.CASE_SHARE_UPDATED,
      entityType: "case_share",
      entityId: input.shareId,
      details: { caseId: share.caseId, memberId: share.memberId, role: input.role, capabilities },
    });
  });
  return { id: input.shareId, role: input.role, capabilities };
}

export async function revokeCaseShare(ownerId: string, shareId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const share = (await db.select().from(caseShares).where(and(
    eq(caseShares.id, shareId),
    eq(caseShares.ownerId, ownerId),
  )).limit(1))[0];
  if (!share) throw new TRPCError({ code: "NOT_FOUND", message: "Case share not found." });
  await assertOwner(share.caseId, ownerId, db);
  const now = new Date();
  db.transaction((tx: any) => {
    const result = tx.update(caseShares).set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(caseShares.id, shareId), eq(caseShares.ownerId, ownerId))).run();
    if (Number(result.changes || 0) !== 1) throw new TRPCError({ code: "CONFLICT", message: "Case share changed." });
    writeAuditLogOrThrow(tx, {
      userId: ownerId,
      action: AUDIT_ACTIONS.CASE_SHARE_REVOKED,
      entityType: "case_share",
      entityId: shareId,
      details: { caseId: share.caseId, memberId: share.memberId },
    });
  });
  return { id: shareId, status: "revoked" as const };
}
