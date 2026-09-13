import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

(sqliteAvailable ? describe : describe.skip)("inbox assignment corrections", () => {
  let app: TestApp;
  let owner: { id: string; email: string; role: string };
  let ownerSequence = 0;
  const other = { id: "CORRECTION_OTHER", email: "correction-other@example.test", role: "user" };
  let sequence = 0;
  const setup = async () => {
    const caller = app.makeCaller(owner);
    const source = `Zaaknummer: CORRECTION-2026-${++sequence}991\nOp 2026-09-01 moet de gemeente het besluit toezenden.`;
    const item = await caller.documentInbox.upload({ fileName: "source.txt", mimeType: "text/plain", base64: Buffer.from(source).toString("base64") });
    const filed = await caller.documentInbox.process({ id: item.id });
    const target = await caller.cases.create({ clientName: `Corrected dossier ${sequence}`, clientEmail: owner.email,
      caseType: "Other", caseSummary: "Separate owned situation", urgency: "Low" });
    return { caller, source, item, filed, target };
  };
  beforeAll(async () => { app = await bootTestApp(); await app.db.insert(app.schema.users).values(buildUser(other)); });
  beforeEach(async () => {
    owner = { id: `CORRECTION_OWNER_${++ownerSequence}`, email: `correction-${ownerSequence}@example.test`, role: "user" };
    await app.db.insert(app.schema.users).values(buildUser(owner));
  });
  afterAll(() => app?.cleanup());

  it("moves canonical evidence and analyses, preserves the original, and reverses with a fresh token", async () => {
    const { caller, source, item, filed, target } = await setup();
    const before = await caller.documentInbox.get({ id: item.id });
    const analyses = await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.evidenceId, filed.evidenceId));
    await caller.documentInbox.reassign({ id: item.id, caseId: target.id, expectedVersion: before.assignment.version, reason: "Different situation confirmed by owner" });
    expect(await caller.evidenceFiles.byCase({ caseId: filed.caseId })).toHaveLength(0);
    expect((await caller.evidenceFiles.byCase({ caseId: target.id }))[0].id).toBe(filed.evidenceId);
    const after = await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.evidenceId, filed.evidenceId));
    expect(after).toEqual(analyses.map((row: any) => ({ ...row, caseId: target.id })));
    expect((await caller.documentAnalysis.generateCaseTimeline({ caseId: filed.caseId })).events).toHaveLength(0);
    expect((await caller.documentAnalysis.generateCaseTimeline({ caseId: target.id })).events.some((event: any) => event.source.evidenceId === filed.evidenceId)).toBe(true);
    expect(Buffer.from((await caller.documentInbox.download({ id: item.id })).base64, "base64").toString()).toBe(source);
    expect(await caller.documentInbox.process({ id: item.id, force: true })).toMatchObject({ caseId: target.id, evidenceId: filed.evidenceId });
    const moved = await caller.documentInbox.get({ id: item.id });
    await caller.documentInbox.reassign({ id: item.id, caseId: filed.caseId, expectedVersion: moved.assignment.version, reason: "Restore original association after review" });
    await expect(caller.documentInbox.reassign({ id: item.id, caseId: target.id, expectedVersion: before.assignment.version, reason: "Stale earlier screen" })).rejects.toThrow(/changed/i);
    const history = await caller.documentInbox.assignmentHistory({ id: item.id });
    expect(history.items).toHaveLength(2);
    expect(history.items.some((row: any) => row.from.caseId === filed.caseId && row.to.caseId === target.id)).toBe(true);
    expect((await caller.documentInbox.get({ id: item.id })).assignment.caseId).toBe(filed.caseId);
  });

  it("rejects foreign owners, foreign targets, stale versions and blank reasons without changing the assignment", async () => {
    const { caller, item, filed, target } = await setup();
    const before = await caller.documentInbox.get({ id: item.id });
    const input = { id: item.id, caseId: target.id, expectedVersion: before.assignment.version, reason: "Owner correction" };
    await expect(app.makeCaller(other).documentInbox.reassign(input)).rejects.toThrow();
    await expect(app.makeCaller(other).documentInbox.assignmentHistory({ id: item.id })).rejects.toThrow();
    const foreign = await app.makeCaller(other).cases.create({ clientName: "Foreign", clientEmail: other.email, caseType: "Other", caseSummary: "Private", urgency: "Low" });
    await expect(caller.documentInbox.reassign({ ...input, caseId: foreign.id })).rejects.toThrow(/not found/i);
    await expect(caller.documentInbox.reassign({ ...input, expectedVersion: "stale" })).rejects.toThrow(/changed/i);
    await expect(caller.documentInbox.reassign({ ...input, reason: "  " })).rejects.toThrow();
    expect((await caller.documentInbox.get({ id: item.id })).assignment.caseId).toBe(filed.caseId);
    expect((await caller.documentInbox.assignmentHistory({ id: item.id })).items).toEqual([]);
  });

  it("does not overwrite an accepted legacy action snapshot after a source moves to another dossier", async () => {
    const { caller, item, filed, target } = await setup();
    const proposal = (await caller.actionProposals.list({ caseId: filed.caseId })).items[0];
    const accepted = await caller.actionProposals.decide({ caseId: filed.caseId, evidenceId: filed.evidenceId, proposalId: proposal.id, decision: "accept" });
    // Simulate a decision saved before case-scoped proposal identities existed.
    const { deriveActionProposals } = await import("../../server/actionProposals");
    const analysis = (await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.evidenceId, filed.evidenceId)))[0];
    const legacyId = deriveActionProposals({ evidenceId: filed.evidenceId, title: "source.txt", contentHash: analysis.contentHash, result: JSON.parse(analysis.result) }).items[0].id;
    await app.db.update(app.schema.caseActionProposals).set({ id: legacyId }).where(eq(app.schema.caseActionProposals.id, proposal.id));
    const proof = await caller.actionProposals.forAction({ actionId: accepted.actionId });
    const before = await caller.documentInbox.get({ id: item.id });
    await caller.documentInbox.reassign({ id: item.id, caseId: target.id, expectedVersion: before.assignment.version, reason: "Correct situation" });
    const next = (await caller.actionProposals.list({ caseId: target.id })).items[0];
    expect(next.id).not.toBe(legacyId);
    const targetAction = await caller.actionProposals.decide({ caseId: target.id, evidenceId: filed.evidenceId, proposalId: next.id, decision: "accept" });
    expect(await caller.actionProposals.forAction({ actionId: accepted.actionId })).toEqual({ ...proof, sourceAvailable: false });
    expect((await caller.caseManagement.getUpcomingDeadlines({ caseId: filed.caseId }))[0].completed).toBe(false);
    const moved = await caller.documentInbox.get({ id: item.id });
    await caller.documentInbox.reassign({ id: item.id, caseId: filed.caseId, expectedVersion: moved.assignment.version, reason: "Reverse correction" });
    expect((await caller.actionProposals.list({ caseId: filed.caseId })).items[0]).toMatchObject({ id: legacyId, state: "accepted", actionId: accepted.actionId });
    expect(await caller.actionProposals.forAction({ actionId: accepted.actionId })).toEqual(proof);
    const restored = await caller.documentInbox.get({ id: item.id });
    await caller.documentInbox.reassign({ id: item.id, caseId: target.id, expectedVersion: restored.assignment.version, reason: "Final reviewed destination" });
    await caller.cases.delete({ id: filed.caseId });
    expect((await caller.actionProposals.list({ caseId: target.id })).items[0]).toMatchObject({ id: next.id, state: "accepted", actionId: targetAction.actionId });
  });

  it("rolls back the whole move if audit persistence fails and rejects changed original bytes", async () => {
    const { caller, item, filed, target } = await setup();
    const before = await caller.documentInbox.get({ id: item.id });
    const input = { id: item.id, caseId: target.id, expectedVersion: before.assignment.version, reason: "Correction with durable history" };
    app.db.$client.exec("CREATE TEMP TRIGGER reject_assignment_audit BEFORE INSERT ON audit_logs WHEN NEW.action = 'inbox.reassigned' BEGIN SELECT RAISE(ABORT, 'audit test failure'); END");
    try { await expect(caller.documentInbox.reassign(input)).rejects.toThrow(/audit test failure/); }
    finally { app.db.$client.exec("DROP TRIGGER reject_assignment_audit"); }
    expect((await caller.documentInbox.get({ id: item.id })).assignment).toEqual(before.assignment);
    expect((await app.db.select().from(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.evidenceId, filed.evidenceId)))[0].caseId).toBe(filed.caseId);
    await app.db.update(app.schema.documentInbox).set({ contentHash: "invalid" }).where(eq(app.schema.documentInbox.id, item.id));
    try { await expect(caller.documentInbox.reassign(input)).rejects.toThrow(/integrity/i); }
    finally { await app.db.update(app.schema.documentInbox).set({ contentHash: before.contentHash }).where(eq(app.schema.documentInbox.id, item.id)); }
    expect((await caller.documentInbox.assignmentHistory({ id: item.id })).items).toEqual([]);
  });

  it("keeps moved source and audit snapshots after deletion of the former dossier", async () => {
    const { caller, item, filed, target, source } = await setup();
    const before = await caller.documentInbox.get({ id: item.id });
    await caller.documentInbox.reassign({ id: item.id, caseId: target.id, expectedVersion: before.assignment.version, reason: "Different matter" });
    await caller.cases.delete({ id: filed.caseId });
    expect((await caller.documentInbox.get({ id: item.id })).assignment.caseId).toBe(target.id);
    expect((await caller.documentInbox.assignmentHistory({ id: item.id })).items[0].from.caseId).toBe(filed.caseId);
    expect(Buffer.from((await caller.documentInbox.download({ id: item.id })).base64, "base64").toString()).toBe(source);
  });

  it("does not audit no-op moves and paginates successive corrections without same-second ordering loss", async () => {
    const { caller, item, filed, target } = await setup();
    const before = await caller.documentInbox.get({ id: item.id });
    expect(await caller.documentInbox.reassign({ id: item.id, caseId: filed.caseId, expectedVersion: before.assignment.version, reason: "No change" })).toMatchObject({ changed: false });
    expect((await caller.documentInbox.assignmentHistory({ id: item.id })).items).toEqual([]);
    for (let index = 0; index < 12; index++) {
      const current = await caller.documentInbox.get({ id: item.id });
      await caller.documentInbox.reassign({ id: item.id, caseId: index % 2 ? filed.caseId : target.id, expectedVersion: current.assignment.version, reason: `Correction ${index}` });
    }
    const first = await caller.documentInbox.assignmentHistory({ id: item.id });
    const second = await caller.documentInbox.assignmentHistory({ id: item.id, offset: 10 });
    expect(first.items).toHaveLength(10); expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(2); expect(second.hasMore).toBe(false);
    expect([...first.items, ...second.items].map((row: any) => row.reason)).toEqual(Array.from({ length: 12 }, (_, index) => `Correction ${11 - index}`));
  });
});
