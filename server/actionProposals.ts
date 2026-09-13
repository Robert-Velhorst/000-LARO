import { createHash, randomUUID } from "crypto";
import { and, desc, eq, gt, inArray, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { cases, documentAnalyses, evidence, deadlines, caseActionProposals as decisions } from "./schema";
import { writeAuditLogOrThrow } from "./audit";

const citationSchema = z.object({ id: z.string(), quote: z.string().min(1), lineStart: z.number().int().positive(), lineEnd: z.number().int().positive() });
const findingSchema = z.object({ text: z.string().min(1), citations: z.array(z.string()).min(1) });
const analysisSchema = z.object({ citations: z.array(citationSchema).max(10000), obligations: z.array(findingSchema).max(10000),
  parties: z.array(findingSchema).default([]), dates: z.array(findingSchema).default([]),
  coverage: z.object({ complete: z.boolean() }), providerStatus: z.string(), analysisProvider: z.string().optional() });

export type ActionProposal = {
  id: string; title: string; source: { evidenceId: string; title: string; contentHash: string };
  quotes: Array<z.infer<typeof citationSchema>>; mentionedParties: string[]; dateMentions: string[];
  uncertainty: string[]; provider: string; state: "proposed" | "accepted" | "dismissed"; actionId: string | null;
};

export function deriveActionProposals(input: { evidenceId: string; title: string; contentHash: string; result: unknown }): { items: ActionProposal[]; warnings: string[] } {
  const parsed = analysisSchema.safeParse(input.result);
  if (!parsed.success) return { items: [], warnings: [`${input.title}: stored analysis could not be validated`] };
  const analysis = parsed.data;
  const citations = new Map(analysis.citations.map((citation) => [citation.id, citation]));
  const items = new Map<string, ActionProposal>();
  const warnings: string[] = [];
  for (const finding of analysis.obligations) {
    if (finding.citations.some((id) => !citations.has(id))) { warnings.push(`${input.title}: an obligation has missing source passages`); continue; }
    const quotes = [...new Set(finding.citations)].map((id) => citations.get(id)!).sort((a, b) => a.lineStart - b.lineStart || a.id.localeCompare(b.id));
    // Identity follows the source version and passages, not model paraphrasing.
    const id = createHash("sha256").update(JSON.stringify([input.evidenceId, input.contentHash, quotes])).digest("hex");
    const sourceText = quotes.map((quote) => quote.quote).join("\n");
    const inPassage = (item: z.infer<typeof findingSchema>) => item.citations.every((id) => citations.has(id)) && sourceText.includes(item.text);
    const uncertainty = ["Not a verified legal obligation or deadline"];
    if (!analysis.coverage.complete) uncertainty.push("Document analysis has incomplete coverage");
    if (!["complete", "not_requested"].includes(analysis.providerStatus)) uncertainty.push("Language-model analysis was not fully completed");
    if (/\b(niet|geen|never|not|niet meer|no longer)\b/i.test(sourceText)) uncertainty.push("Source contains negation; check whether an action is required");
    if (/\b(binnen|within)\b/i.test(sourceText)) uncertainty.push("Relative period requires a verified starting point");
    if (!items.has(id)) items.set(id, { id, title: finding.text.slice(0, 500), source: { evidenceId: input.evidenceId, title: input.title, contentHash: input.contentHash },
      quotes, mentionedParties: [...new Set(analysis.parties.filter(inPassage).map((item) => item.text))],
      dateMentions: [...new Set(analysis.dates.filter(inPassage).map((item) => item.text))], uncertainty,
      provider: analysis.analysisProvider || "local", state: "proposed", actionId: null });
  }
  return { items: [...items.values()], warnings: [...new Set(warnings)] };
}

type Db = Awaited<ReturnType<typeof getDb>>;
type Reader = Pick<Db, "select">;
function assertOwnedCase(db: Reader, userId: string, caseId: string) {
  if (!db.select({ id: cases.id }).from(cases).where(and(eq(cases.id, caseId), eq(cases.userId, userId))).get()) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });
  }
}
export function latestRows(db: Reader, userId: string, caseId: string, evidenceId?: string, offset = 0, limit = 11) {
  const newer = alias(documentAnalyses, "newer_action_analysis");
  return db.select({ analysis: documentAnalyses, title: evidence.title }).from(documentAnalyses)
    .innerJoin(evidence, and(eq(evidence.id, documentAnalyses.evidenceId), eq(evidence.userId, userId), eq(evidence.caseId, caseId)))
    .where(and(eq(documentAnalyses.userId, userId), eq(documentAnalyses.caseId, caseId), evidenceId ? eq(documentAnalyses.evidenceId, evidenceId) : undefined,
      notExists(db.select({ id: newer.id }).from(newer).where(and(eq(newer.evidenceId, documentAnalyses.evidenceId),
        eq(newer.userId, userId), eq(newer.caseId, caseId), or(gt(newer.updatedAt, documentAnalyses.updatedAt),
          and(eq(newer.updatedAt, documentAnalyses.updatedAt), gt(newer.id, documentAnalyses.id))))))))
    .orderBy(desc(documentAnalyses.updatedAt), desc(documentAnalyses.id)).limit(limit).offset(offset).all();
}
function deriveRow(row: ReturnType<typeof latestRows>[number]) {
  let result: unknown;
  try { result = JSON.parse(row.analysis.result); } catch { result = null; }
  return deriveActionProposals({ evidenceId: row.analysis.evidenceId, title: row.title || "Source document", contentHash: row.analysis.contentHash, result });
}

function caseScopedProposals(db: Reader, userId: string, caseId: string, proposals: ActionProposal[]): ActionProposal[] {
  if (!proposals.length) return proposals;
  const legacy = db.select({ id: decisions.id }).from(decisions).where(and(eq(decisions.userId, userId),
    eq(decisions.caseId, caseId), inArray(decisions.id, proposals.map((item) => item.id)))).all();
  const legacyIds = new Set(legacy.map((item) => item.id));
  // Previously saved decisions retain their identity. New decisions are scoped
  // to the dossier so moving a source cannot overwrite another case's snapshot.
  return proposals.map((item) => ({ ...item, id: legacyIds.has(item.id) ? item.id
    : createHash("sha256").update(JSON.stringify(["case_action_proposal_v2", caseId, item.id])).digest("hex") }));
}

export async function listActionProposals(userId: string, caseId: string, offset: number) {
  const db = await getDb(); assertOwnedCase(db, userId, caseId);
  const rows = latestRows(db, userId, caseId, undefined, offset);
  const results = rows.slice(0, 10).map(deriveRow);
  const proposals = caseScopedProposals(db, userId, caseId, results.flatMap((result) => result.items));
  const saved = proposals.length ? db.select().from(decisions).where(and(eq(decisions.userId, userId), eq(decisions.caseId, caseId), inArray(decisions.id, proposals.map((item) => item.id)))).all() : [];
  const byId = new Map(saved.map((item) => [item.id, item]));
  return { items: proposals.map((item) => { const saved = byId.get(item.id); return { ...item,
    state: (saved?.state || "proposed") as ActionProposal["state"], actionId: saved?.actionId || null }; }),
    warnings: results.flatMap((result) => result.warnings), hasMore: rows.length > 10, documentsReviewed: Math.min(rows.length, 10) };
}

export async function decideActionProposal(userId: string, input: {
  caseId: string; evidenceId: string; proposalId: string; decision: "accept" | "dismiss" | "restore"; dueDate?: string | null;
}) {
  const db = await getDb();
  return db.transaction((tx) => {
    assertOwnedCase(tx, userId, input.caseId);
    const row = latestRows(tx, userId, input.caseId, input.evidenceId)[0];
    const proposal = row && caseScopedProposals(tx, userId, input.caseId, deriveRow(row).items).find((item) => item.id === input.proposalId);
    if (!proposal) throw new TRPCError({ code: "CONFLICT", message: "Source analysis changed or proposal is no longer available; reload proposals" });
    const existing = tx.select().from(decisions).where(and(eq(decisions.id, proposal.id), eq(decisions.userId, userId), eq(decisions.caseId, input.caseId))).get();
    if (existing?.state === "accepted") {
      if (input.decision !== "accept") throw new TRPCError({ code: "CONFLICT", message: "Accepted proposals are managed through the action list" });
      return { actionId: existing.actionId, state: "accepted" as const };
    }
    const state = input.decision === "accept" ? "accepted" : input.decision === "dismiss" ? "dismissed" : "proposed";
    if (existing?.state === state) return { actionId: existing.actionId, state };
    const now = new Date(); const actionId = state === "accepted" ? randomUUID() : null;
    if (actionId) {
      tx.insert(deadlines).values({ id: actionId, userId, caseId: input.caseId, title: proposal.title,
        description: `Source: ${proposal.source.title}\n${proposal.uncertainty.join(". ")}`,
        dueDate: input.dueDate ? new Date(input.dueDate) : null, completed: false, createdAt: now, updatedAt: now }).run();
      writeAuditLogOrThrow(tx, { userId, action: "case.action_created", entityType: "case_action", entityId: actionId,
        details: { caseId: input.caseId, proposalId: proposal.id, dueDate: input.dueDate || null, dueDateOrigin: input.dueDate ? "user_entered" : "none" } });
    }
    const values = { id: proposal.id, userId, caseId: input.caseId, evidenceId: input.evidenceId, actionId, state, snapshot: JSON.stringify(proposal), updatedAt: now };
    tx.insert(decisions).values({ ...values, createdAt: now }).onConflictDoUpdate({ target: decisions.id, set: values }).run();
    writeAuditLogOrThrow(tx, { userId, action: `case.action_proposal_${input.decision === "accept" ? "accepted" : input.decision === "dismiss" ? "dismissed" : "restored"}`,
      entityType: "case_action_proposal", entityId: proposal.id, details: { caseId: input.caseId, evidenceId: input.evidenceId, contentHash: proposal.source.contentHash, actionId } });
    return { actionId, state };
  });
}

export async function getActionSource(userId: string, actionId: string) {
  const db = await getDb();
  const action = db.select().from(deadlines).where(and(eq(deadlines.id, actionId), eq(deadlines.userId, userId))).get();
  if (!action?.caseId) throw new TRPCError({ code: "NOT_FOUND", message: "Action not found" });
  assertOwnedCase(db, userId, action.caseId);
  const saved = db.select().from(decisions).where(and(eq(decisions.actionId, actionId), eq(decisions.userId, userId), eq(decisions.caseId, action.caseId))).get();
  if (!saved) return null;
  const sourceAvailable = Boolean(saved.evidenceId && db.select({ id: evidence.id }).from(evidence).where(and(eq(evidence.id, saved.evidenceId), eq(evidence.userId, userId), eq(evidence.caseId, action.caseId))).get());
  return { ...JSON.parse(saved.snapshot) as ActionProposal, sourceAvailable };
}
