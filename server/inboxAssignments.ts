import { createHash, randomUUID } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "./db";
import { auditLogs, cases, documentAnalyses, documentInbox, evidence } from "./schema";
import { getOwnedInboxItem, readInboxOriginal } from "./documentInbox";
import { writeAuditLogOrThrow } from "./audit";

type Reader = Pick<Awaited<ReturnType<typeof getDb>>, "select">;
function readAssignment(db: Reader, userId: string, inboxId: string) {
  const row = db.select({ id: evidence.id, caseId: evidence.caseId, title: cases.clientName, metadata: evidence.metadata })
    .from(documentInbox).innerJoin(evidence, and(eq(evidence.id, documentInbox.evidenceId), eq(evidence.userId, userId)))
    .innerJoin(cases, and(eq(cases.id, evidence.caseId), eq(cases.userId, userId)))
    .where(and(eq(documentInbox.id, inboxId), eq(documentInbox.userId, userId))).get();
  if (!row) return null;
  return { ...row, version: createHash("sha256").update(JSON.stringify([row.id, row.caseId, row.metadata])).digest("hex") };
}

export async function getInboxAssignment(userId: string, id: string) {
  await getOwnedInboxItem(userId, id);
  const row = readAssignment(await getDb(), userId, id);
  return row ? { caseId: row.caseId, title: row.title, version: row.version } : null;
}

export async function reassignInboxDocument(userId: string, input: {
  id: string; caseId: string; expectedVersion: string; reason: string;
}) {
  const { row: original } = await readInboxOriginal(userId, input.id);
  const db = await getDb();
  return db.transaction((tx) => {
    const current = readAssignment(tx, userId, input.id);
    if (!current) throw new TRPCError({ code: "CONFLICT", message: "Document is no longer assigned; refresh the inbox" });
    if (current.version !== input.expectedVersion || current.id !== original.evidenceId) {
      throw new TRPCError({ code: "CONFLICT", message: "Dossier assignment changed; refresh before correcting it" });
    }
    const target = tx.select({ id: cases.id, title: cases.clientName }).from(cases)
      .where(and(eq(cases.id, input.caseId), eq(cases.userId, userId))).get();
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });
    if (current.caseId === target.id) return { caseId: current.caseId, evidenceId: current.id, changed: false };
    let metadata: Record<string, unknown>;
    try { metadata = z.record(z.unknown()).parse(JSON.parse(current.metadata || "{}")); }
    catch { throw new TRPCError({ code: "CONFLICT", message: "Source metadata is unreadable; correction was not applied" }); }
    const now = new Date();
    // Keep the evidence identity and every analysis version. Case-specific actions
    // and their historical source snapshots are deliberately not moved.
    tx.update(evidence).set({ caseId: target.id, metadata: JSON.stringify({ ...metadata, dossierAssignmentRevision: randomUUID() }), updatedAt: now })
      .where(and(eq(evidence.id, current.id), eq(evidence.userId, userId))).run();
    tx.update(documentAnalyses).set({ caseId: target.id })
      .where(and(eq(documentAnalyses.evidenceId, current.id), eq(documentAnalyses.userId, userId))).run();
    tx.update(documentInbox).set({ decision: "corrected", reason: input.reason, updatedAt: now })
      .where(and(eq(documentInbox.id, input.id), eq(documentInbox.userId, userId))).run();
    for (const caseId of [current.caseId, target.id]) tx.update(cases).set({ updatedAt: now }).where(and(eq(cases.id, caseId), eq(cases.userId, userId))).run();
    writeAuditLogOrThrow(tx, { userId, action: "inbox.reassigned", entityType: "document_inbox", entityId: input.id,
      details: { from: { caseId: current.caseId, title: current.title }, to: { caseId: target.id, title: target.title },
        reason: input.reason, evidenceId: current.id, contentHash: original.contentHash, previousVersion: current.version,
        version: readAssignment(tx, userId, input.id)!.version, source: "owner", recordedAt: now.toISOString() } });
    return { caseId: target.id, evidenceId: current.id, changed: true };
  });
}

const historySchema = z.object({ from: z.object({ caseId: z.string(), title: z.string().nullable() }),
  to: z.object({ caseId: z.string(), title: z.string().nullable() }), reason: z.string(), recordedAt: z.string() });

export async function inboxAssignmentHistory(userId: string, id: string, offset: number) {
  await getOwnedInboxItem(userId, id);
  const db = await getDb();
  const rows = db.select().from(auditLogs).where(and(eq(auditLogs.userId, userId), eq(auditLogs.entityId, id),
    eq(auditLogs.entityType, "document_inbox"), eq(auditLogs.action, "inbox.reassigned")))
    .orderBy(desc(auditLogs.createdAt), desc(sql`${auditLogs}.rowid`)).limit(11).offset(offset).all();
  return { items: rows.slice(0, 10).map((row) => {
    try { return { id: row.id, ...historySchema.parse(JSON.parse(row.details || "{}")), readable: true }; }
    catch { return { id: row.id, from: null, to: null, reason: "Historical correction is unreadable", recordedAt: row.createdAt?.toISOString() || "", readable: false }; }
  }), hasMore: rows.length > 10 };
}
