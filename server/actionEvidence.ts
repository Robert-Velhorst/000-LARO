import { createHash } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { cases, deadlines, evidence, caseActionEvidence as links } from "./schema";
import { latestRows } from "./actionProposals";
import { writeAuditLogOrThrow } from "./audit";

const quoteSchema = z.object({ id: z.string().min(1), quote: z.string().min(1).refine((value) => value.trim().length > 0),
  lineStart: z.number().int().positive(), lineEnd: z.number().int().positive() })
  .refine((value) => value.lineEnd >= value.lineStart);
const snapshotSchema = z.object({ evidenceId: z.string(), title: z.string(), analysisId: z.string(),
  contentHash: z.string(), analysisFingerprint: z.string(), quotes: z.array(quoteSchema).min(1).max(10) });
type Db = Awaited<ReturnType<typeof getDb>>;
type Reader = Pick<Db, "select">;
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");

function ownedAction(db: Reader, userId: string, actionId: string) {
  const row = db.select({ caseId: deadlines.caseId }).from(deadlines)
    .innerJoin(cases, and(eq(cases.id, deadlines.caseId), eq(cases.userId, userId)))
    .where(and(eq(deadlines.id, actionId), eq(deadlines.userId, userId))).get();
  if (!row?.caseId) throw new TRPCError({ code: "NOT_FOUND", message: "Action not found" });
  return row.caseId;
}

function readPassages(db: Reader, userId: string, caseId: string, evidenceId: string) {
  const row = latestRows(db, userId, caseId, evidenceId, 0, 1)[0];
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Analyzed source not found in this case" });
  let parsed;
  try { parsed = z.object({ citations: z.array(quoteSchema).max(10000) }).parse(JSON.parse(row.analysis.result)); }
  catch { throw new TRPCError({ code: "CONFLICT", message: "Source analysis has no valid passages; reanalyze the document" }); }
  if (new Set(parsed.citations.map((item) => item.id)).size !== parsed.citations.length) {
    throw new TRPCError({ code: "CONFLICT", message: "Source analysis contains ambiguous citation identifiers" });
  }
  return { evidenceId, title: row.title || "Source document", analysisId: row.analysis.id,
    contentHash: row.analysis.contentHash, analysisFingerprint: fingerprint(row.analysis.result), quotes: parsed.citations };
}

export async function actionEvidenceSources(userId: string, actionId: string, offset: number) {
  const db = await getDb(); const caseId = ownedAction(db, userId, actionId);
  const rows = latestRows(db, userId, caseId, undefined, offset, 11);
  return { items: rows.slice(0, 10).map((row) => ({ evidenceId: row.analysis.evidenceId, title: row.title || "Source document" })), hasMore: rows.length > 10 };
}

export async function actionEvidencePassages(userId: string, input: { actionId: string; evidenceId: string; offset: number }) {
  const db = await getDb(); const caseId = ownedAction(db, userId, input.actionId);
  const { quotes, ...source } = readPassages(db, userId, caseId, input.evidenceId);
  return { ...source, items: quotes.slice(input.offset, input.offset + 30), hasMore: quotes.length > input.offset + 30 };
}

export async function listActionEvidence(userId: string, actionId: string, offset: number) {
  const db = await getDb(); const caseId = ownedAction(db, userId, actionId);
  const rows = db.select({ link: links, availableId: evidence.id }).from(links)
    .leftJoin(evidence, and(eq(evidence.id, links.evidenceId), eq(evidence.userId, userId), eq(evidence.caseId, caseId)))
    .where(and(eq(links.userId, userId), eq(links.actionId, actionId), eq(links.caseId, caseId)))
    .orderBy(desc(links.createdAt), desc(links.id)).limit(26).offset(offset).all();
  return { items: rows.slice(0, 25).map(({ link, availableId }) => ({ id: link.id, relation: link.relation,
    state: link.state, note: link.note, createdAt: link.createdAt, updatedAt: link.updatedAt,
    snapshot: snapshotSchema.parse(JSON.parse(link.snapshot)), sourceAvailable: Boolean(availableId) })), hasMore: rows.length > 25 };
}

export async function linkActionEvidence(userId: string, input: { actionId: string; evidenceId: string; analysisId: string;
  contentHash: string; analysisFingerprint: string; citationIds: string[]; relation: "supports" | "contradicts"; note: string }) {
  const db = await getDb();
  return db.transaction((tx) => {
    const caseId = ownedAction(tx, userId, input.actionId);
    const source = readPassages(tx, userId, caseId, input.evidenceId);
    if (source.analysisId !== input.analysisId || source.contentHash !== input.contentHash || source.analysisFingerprint !== input.analysisFingerprint) {
      throw new TRPCError({ code: "CONFLICT", message: "Source analysis changed; select its current passages again" });
    }
    const byId = new Map(source.quotes.map((quote) => [quote.id, quote]));
    const ids = [...new Set(input.citationIds)].sort();
    if (ids.some((id) => !byId.has(id))) throw new TRPCError({ code: "BAD_REQUEST", message: "Unknown source passage" });
    const snapshot = snapshotSchema.parse({ ...source, quotes: ids.map((id) => byId.get(id)!) });
    const id = fingerprint(JSON.stringify([userId, input.actionId, snapshot, input.relation, input.note]));
    const existing = tx.select({ id: links.id }).from(links).where(eq(links.id, id)).get();
    // Retrying a link does not restore a deliberately withdrawn assessment.
    if (existing) return { id };
    const now = new Date();
    tx.insert(links).values({ id, userId, caseId, actionId: input.actionId, evidenceId: input.evidenceId,
      relation: input.relation, state: "active", note: input.note, snapshot: JSON.stringify(snapshot), createdAt: now, updatedAt: now }).run();
    writeAuditLogOrThrow(tx, { userId, action: "case.action_evidence_linked", entityType: "case_action_evidence", entityId: id,
      details: { caseId, actionId: input.actionId, evidenceId: input.evidenceId, relation: input.relation,
        analysisId: input.analysisId, contentHash: input.contentHash, assessmentOrigin: "user", completionChanged: false } });
    return { id };
  });
}

export async function setActionEvidenceState(userId: string, input: { id: string; state: "active" | "withdrawn" }) {
  const db = await getDb();
  return db.transaction((tx) => {
    const row = tx.select().from(links).where(and(eq(links.id, input.id), eq(links.userId, userId))).get();
    if (!row || ownedAction(tx, userId, row.actionId) !== row.caseId) throw new TRPCError({ code: "NOT_FOUND", message: "Evidence link not found" });
    if (row.state === input.state) return { id: row.id, state: row.state };
    tx.update(links).set({ state: input.state, updatedAt: new Date() }).where(eq(links.id, row.id)).run();
    writeAuditLogOrThrow(tx, { userId, action: input.state === "active" ? "case.action_evidence_restored" : "case.action_evidence_withdrawn",
      entityType: "case_action_evidence", entityId: row.id, details: { caseId: row.caseId, actionId: row.actionId, previousState: row.state, state: input.state } });
    return { id: row.id, state: input.state };
  });
}
