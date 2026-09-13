import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";
import { eq } from "drizzle-orm";

(sqliteAvailable ? describe : describe.skip)("source-backed action proposals", () => {
  let app: TestApp;
  let caseId: string;
  let evidenceId: string;
  const owner = { id: "PROPOSAL_OWNER", email: "proposal@example.test", role: "user" };
  const other = { id: "PROPOSAL_OTHER", email: "proposal-other@example.test", role: "user" };
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    const caller = app.makeCaller(owner);
    const upload = await caller.documentInbox.upload({ fileName: "decision.txt", mimeType: "text/plain", base64: Buffer.from(
      "Zaaknummer: PROPOSAL-2026-9911\nDe gemeente moet uiterlijk 2026-10-12 het besluit toezenden.\nBinnen 6 weken kunt u bezwaar maken.\nU hoeft niet te betalen."
    ).toString("base64") });
    await caller.documentInbox.process({ id: upload.id });
    const item = (await caller.documentInbox.list({ view: "all" })).items[0];
    caseId = item.caseId!; evidenceId = item.evidenceId!;
  });
  afterAll(() => app?.cleanup());

  it("automatically derives cited proposals but does not invent a verified due date or completed action", async () => {
    const caller = app.makeCaller(owner);
    const result = await caller.actionProposals.list({ caseId });
    expect(result.items.length).toBeGreaterThan(0);
    const proposal = result.items.find((item) => item.title.includes("toezenden"))!;
    expect(proposal.source.evidenceId).toBe(evidenceId);
    expect(proposal.quotes.some((quote) => quote.quote.includes("2026-10-12"))).toBe(true);
    expect(proposal.dateMentions).toContain("2026-10-12");
    expect(proposal.state).toBe("proposed");
    expect(proposal.uncertainty).toContain("Not a verified legal obligation or deadline");
    expect(await caller.caseManagement.getUpcomingDeadlines({ caseId })).toEqual([]);
  });

  it("accepts once, retains source proof, and audits acceptance without inferring a deadline", async () => {
    const caller = app.makeCaller(owner);
    const proposal = (await caller.actionProposals.list({ caseId })).items[0];
    const input = { caseId, evidenceId, proposalId: proposal.id, decision: "accept" as const };
    const first = await caller.actionProposals.decide(input);
    expect(await caller.actionProposals.decide(input)).toEqual(first);
    const actions = await caller.caseManagement.getUpcomingDeadlines({ caseId });
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ id: first.actionId, dueDate: null, completed: false });
    const proof = await caller.actionProposals.forAction({ actionId: first.actionId! });
    expect(proof?.source.evidenceId).toBe(evidenceId);
    expect(proof?.quotes.length).toBeGreaterThan(0);
    const logs = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.entityId, proposal.id));
    expect(logs.filter((item: any) => item.action === "case.action_proposal_accepted")).toHaveLength(1);
  });

  it("rejects another owner and stale or forged proposal identities", async () => {
    await expect(app.makeCaller(other).actionProposals.list({ caseId })).rejects.toThrow();
    await expect(app.makeCaller(owner).actionProposals.decide({ caseId, evidenceId, proposalId: "forged", decision: "accept" })).rejects.toThrow();
    const rows = await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.evidenceId, evidenceId));
    const proposal = (await app.makeCaller(owner).actionProposals.list({ caseId })).items[0];
    const original = rows[0].result;
    const modified = JSON.parse(original); modified.obligations = [];
    await app.db.update(app.schema.documentAnalyses).set({ result: JSON.stringify(modified) }).where(eq(app.schema.documentAnalyses.id, rows[0].id));
    await expect(app.makeCaller(owner).actionProposals.decide({ caseId, evidenceId, proposalId: proposal.id, decision: "accept" })).rejects.toThrow(/changed|available/i);
    await app.db.update(app.schema.documentAnalyses).set({ result: original }).where(eq(app.schema.documentAnalyses.id, rows[0].id));
  });

  it("keeps dismissal reversible and rejects findings with missing citations", async () => {
    const caller = app.makeCaller(owner);
    const proposal = (await caller.actionProposals.list({ caseId })).items.find((item) => item.state === "proposed")!;
    const input = { caseId, evidenceId, proposalId: proposal.id };
    await caller.actionProposals.decide({ ...input, decision: "dismiss" });
    expect((await caller.actionProposals.list({ caseId })).items.find((item) => item.id === proposal.id)?.state).toBe("dismissed");
    await caller.actionProposals.decide({ ...input, decision: "restore" });
    expect((await caller.actionProposals.list({ caseId })).items.find((item) => item.id === proposal.id)?.state).toBe("proposed");
    const { deriveActionProposals } = await import("../../server/actionProposals");
    const row = (await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.evidenceId, evidenceId)))[0];
    const result = JSON.parse(row.result); result.obligations = [{ text: "Invented payment", citations: ["missing"] }];
    expect(deriveActionProposals({ evidenceId, title: "decision.txt", contentHash: row.contentHash, result }).items).toEqual([]);
  });

  it("retains the accepted source snapshot through reanalysis and source deletion, with owner-only access and export", async () => {
    const caller = app.makeCaller(owner);
    const action = (await caller.caseManagement.getUpcomingDeadlines({ caseId }))[0];
    const before = await caller.actionProposals.forAction({ actionId: action.id });
    await expect(app.makeCaller(other).actionProposals.forAction({ actionId: action.id })).rejects.toThrow();
    await app.db.update(app.schema.documentAnalyses).set({ result: "{}" }).where(eq(app.schema.documentAnalyses.evidenceId, evidenceId));
    expect((await caller.actionProposals.list({ caseId })).warnings.length).toBeGreaterThan(0);
    expect(await caller.actionProposals.forAction({ actionId: action.id })).toEqual(before);
    await app.db.delete(app.schema.evidence).where(eq(app.schema.evidence.id, evidenceId));
    expect(await caller.actionProposals.forAction({ actionId: action.id })).toEqual({ ...before, sourceAvailable: false });
    const { exportUserData } = await import("../../server/gdpr");
    const exported = await exportUserData(owner.id);
    expect(exported.case_action_proposals.length).toBeGreaterThan(0);
    expect(exported.case_action_proposals.some((item: any) => item.snapshot.includes("2026-10-12"))).toBe(true);
  });
});
