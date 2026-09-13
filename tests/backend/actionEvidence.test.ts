import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

(sqliteAvailable ? describe : describe.skip)("action execution evidence", () => {
  let app: TestApp;
  const owner = { id: "EXECUTION_OWNER", email: "execution@example.test", role: "user" };
  const other = { id: "EXECUTION_OTHER", email: "execution-other@example.test", role: "user" };
  let sequence = 0;
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
  });
  afterAll(() => app?.cleanup());
  async function fixture() {
    const caller = app.makeCaller(owner);
    const item = await caller.documentInbox.upload({ fileName: "delivery.txt", mimeType: "text/plain",
      base64: Buffer.from(`Zaaknummer: EXECUTION-2026-${++sequence}\nOp 2026-09-04 schreef de gemeente: het besluit is verzonden.\nDe bewoner zegt dat het besluit niet is ontvangen.`).toString("base64") });
    const filed = await caller.documentInbox.process({ id: item.id });
    const action = await caller.caseManagement.addDeadline({ caseId: filed.caseId!, title: "Besluit toezenden", dueDate: null });
    return { caller, actionId: action.id, caseId: filed.caseId!, evidenceId: filed.evidenceId! };
  }
  async function selection(f: Awaited<ReturnType<typeof fixture>>) {
    const passage = await f.caller.actionEvidence.passages({ actionId: f.actionId, evidenceId: f.evidenceId });
    return { actionId: f.actionId, evidenceId: f.evidenceId, analysisId: passage.analysisId,
      contentHash: passage.contentHash, analysisFingerprint: passage.analysisFingerprint,
      citationIds: [passage.items.find((item) => item.quote.includes("verzonden"))!.id], relation: "supports" as const,
      note: "De brief vermeldt verzending; ontvangst is niet bevestigd." };
  }
  it("links exact versioned passages idempotently without marking execution as completed", async () => {
    const f = await fixture();
    expect((await f.caller.actionEvidence.sources({ actionId: f.actionId })).items.map((r) => r.evidenceId)).toContain(f.evidenceId);
    const input = await selection(f);
    const first = await f.caller.actionEvidence.link(input);
    expect(await f.caller.actionEvidence.link(input)).toEqual(first);
    const result = await f.caller.actionEvidence.list({ actionId: f.actionId });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ relation: "supports", state: "active", note: input.note,
      sourceAvailable: true, snapshot: { contentHash: input.contentHash, quotes: [expect.objectContaining({ id: input.citationIds[0] })] } });
    expect((await f.caller.caseManagement.getUpcomingDeadlines({ caseId: f.caseId }))[0].completed).toBe(false);
    const logs = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.entityId, first.id));
    expect(logs.filter((r: any) => r.action === "case.action_evidence_linked")).toHaveLength(1);
  });
  it("rejects foreign owners, cross-case sources, forged citations and stale analysis", async () => {
    const f = await fixture(); const input = await selection(f); const unrelated = await fixture();
    await expect(app.makeCaller(other).actionEvidence.list({ actionId: f.actionId })).rejects.toThrow();
    await expect(app.makeCaller(other).actionEvidence.link(input)).rejects.toThrow();
    await expect(f.caller.actionEvidence.passages({ actionId: f.actionId, evidenceId: unrelated.evidenceId })).rejects.toThrow();
    await expect(f.caller.actionEvidence.link({ ...input, citationIds: ["forged"] })).rejects.toThrow();
    await expect(f.caller.actionEvidence.link({ ...input, citationIds: [] })).rejects.toThrow();
    await expect(f.caller.actionEvidence.link({ ...input, note: " " })).rejects.toThrow();
    await app.db.update(app.schema.documentAnalyses).set({ contentHash: "changed" }).where(eq(app.schema.documentAnalyses.id, input.analysisId));
    await expect(f.caller.actionEvidence.link(input)).rejects.toThrow(/changed/i);
    expect((await f.caller.actionEvidence.list({ actionId: f.actionId })).items).toHaveLength(0);
  });
  it("retains supporting and contradicting assessments through withdrawal, reanalysis, deletion and export", async () => {
    const f = await fixture(); const input = await selection(f);
    const linked = await f.caller.actionEvidence.link(input);
    await f.caller.actionEvidence.link({ ...input, relation: "contradicts", note: "De bewoner betwist ontvangst." });
    await expect(app.makeCaller(other).actionEvidence.setState({ id: linked.id, state: "withdrawn" })).rejects.toThrow();
    await f.caller.actionEvidence.setState({ id: linked.id, state: "withdrawn" });
    await f.caller.actionEvidence.setState({ id: linked.id, state: "withdrawn" });
    expect((await f.caller.actionEvidence.list({ actionId: f.actionId })).items.find((r) => r.id === linked.id)?.state).toBe("withdrawn");
    await f.caller.actionEvidence.setState({ id: linked.id, state: "active" });
    const before = await f.caller.actionEvidence.list({ actionId: f.actionId });
    await app.db.update(app.schema.documentAnalyses).set({ result: "{}" }).where(eq(app.schema.documentAnalyses.id, input.analysisId));
    expect(await f.caller.actionEvidence.list({ actionId: f.actionId })).toEqual(before);
    await app.db.delete(app.schema.evidence).where(eq(app.schema.evidence.id, f.evidenceId));
    const after = await f.caller.actionEvidence.list({ actionId: f.actionId });
    expect(after.items).toHaveLength(2);
    expect(after.items.every((r) => !r.sourceAvailable && r.snapshot.quotes.length)).toBe(true);
    const { exportUserData } = await import("../../server/gdpr");
    expect((await exportUserData(owner.id)).case_action_evidence.some((r: any) => r.id === linked.id)).toBe(true);
    const logs = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.entityId, linked.id));
    expect(logs.filter((r: any) => r.action === "case.action_evidence_withdrawn")).toHaveLength(1);
  });

  it("rejects changed passages even when the analysis ID and content hash stay the same", async () => {
    const f = await fixture(); const input = await selection(f);
    const row = await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.id, input.analysisId)).get();
    const result = JSON.parse(row.result);
    result.citations.find((quote: any) => quote.id === input.citationIds[0]).quote = "Different passage after reanalysis.";
    await app.db.update(app.schema.documentAnalyses).set({ result: JSON.stringify(result) }).where(eq(app.schema.documentAnalyses.id, input.analysisId));
    await expect(f.caller.actionEvidence.link(input)).rejects.toThrow(/changed/i);
    expect((await f.caller.actionEvidence.list({ actionId: f.actionId })).items).toHaveLength(0);
  });

  it("paginates source documents, exact passages and linked assessments", async () => {
    const f = await fixture();
    const original = await app.db.select().from(app.schema.evidence).where(eq(app.schema.evidence.id, f.evidenceId)).get();
    const analysis = await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.evidenceId, f.evidenceId)).get();
    const result = JSON.parse(analysis.result);
    result.citations = Array.from({ length: 35 }, (_, i) => ({ id: `line-${i}`, quote: `  Passage ${i}.  `, lineStart: i + 1, lineEnd: i + 1 }));
    await app.db.update(app.schema.documentAnalyses).set({ result: JSON.stringify(result) }).where(eq(app.schema.documentAnalyses.id, analysis.id));
    for (let i = 0; i < 10; i++) {
      const evidenceId = `${f.evidenceId}-page-${i}`;
      await app.db.insert(app.schema.evidence).values({ ...original, id: evidenceId });
      await app.db.insert(app.schema.documentAnalyses).values({ ...analysis, id: `${analysis.id}-page-${i}`, evidenceId });
    }
    const first = await f.caller.actionEvidence.sources({ actionId: f.actionId });
    const last = await f.caller.actionEvidence.sources({ actionId: f.actionId, offset: 10 });
    expect(first.items).toHaveLength(10); expect(first.hasMore).toBe(true);
    expect(last.items).toHaveLength(1); expect(last.hasMore).toBe(false);
    expect(new Set([...first.items, ...last.items].map((r: any) => r.evidenceId)).size).toBe(11);
    const page = await f.caller.actionEvidence.passages({ actionId: f.actionId, evidenceId: f.evidenceId });
    expect(page.items).toHaveLength(30); expect(page.hasMore).toBe(true);
    expect(page.items[0].quote).toBe("  Passage 0.  ");
    const tail = await f.caller.actionEvidence.passages({ actionId: f.actionId, evidenceId: f.evidenceId, offset: 30 });
    expect(tail.items).toHaveLength(5); expect(tail.hasMore).toBe(false);
    for (let i = 0; i < 26; i++) await f.caller.actionEvidence.link({ actionId: f.actionId, evidenceId: f.evidenceId,
      analysisId: page.analysisId, contentHash: page.contentHash, analysisFingerprint: page.analysisFingerprint,
      citationIds: [page.items[0].id], relation: "supports", note: `Distinct assessment ${i}` });
    const links = await f.caller.actionEvidence.list({ actionId: f.actionId });
    const more = await f.caller.actionEvidence.list({ actionId: f.actionId, offset: 25 });
    expect(links.items).toHaveLength(25); expect(links.hasMore).toBe(true);
    expect(more.items).toHaveLength(1); expect(more.hasMore).toBe(false);
    expect(new Set([...links.items, ...more.items].map((r: any) => r.id)).size).toBe(26);
    expect(links.items[0].snapshot.quotes[0].quote).toBe("  Passage 0.  ");
  });

  it("preserves withdrawn records and their exact snapshot across a database reopen", async () => {
    const f = await fixture(); const input = await selection(f);
    const link = await f.caller.actionEvidence.link(input);
    await f.caller.actionEvidence.setState({ id: link.id, state: "withdrawn" });
    await f.caller.actionEvidence.link(input);
    const before = await f.caller.actionEvidence.list({ actionId: f.actionId });
    expect(before.items[0].state).toBe("withdrawn");
    const { closeDatabaseForMaintenance, getDb } = await import("../../server/db");
    closeDatabaseForMaintenance(); await getDb();
    expect(await f.caller.actionEvidence.list({ actionId: f.actionId })).toEqual(before);
  });
});
