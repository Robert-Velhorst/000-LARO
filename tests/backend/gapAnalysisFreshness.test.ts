import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildCase, buildEvidence, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("gap-analysis input freshness", () => {
  let app: TestApp;
  const owner = { id: "GAP_FRESH_OWNER", email: "gap-fresh@example.test", role: "user" };
  const caseIds = {
    evidence: "CASE_GAP_INPUT_EVIDENCE",
    unchanged: "CASE_GAP_INPUT_UNCHANGED",
    correction: "CASE_GAP_INPUT_CORRECTION",
    failure: "CASE_GAP_INPUT_FAILURE",
  };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
    await app.db.insert(app.schema.cases).values(Object.values(caseIds).map((id) => buildCase({
      id,
      userId: owner.id,
      caseType: "Employment termination",
    })));
    await app.db.insert(app.schema.timeline).values([
      {
        id: "GAP_FAILURE_REQUEST",
        caseId: caseIds.failure,
        userId: owner.id,
        eventType: "request",
        title: "Termination records request",
        description: "Requested records",
        eventAt: new Date("2026-07-01T12:00:00Z"),
        metadata: JSON.stringify({ reviewStatus: "reviewed" }),
        createdAt: new Date("2026-07-01T12:00:00Z"),
      },
      {
        id: "GAP_FAILURE_LATER",
        caseId: caseIds.failure,
        userId: owner.id,
        eventType: "event",
        title: "Later event",
        description: "Later documented event",
        eventAt: new Date("2026-08-20T12:00:00Z"),
        metadata: JSON.stringify({ reviewStatus: "reviewed" }),
        createdAt: new Date("2026-08-20T12:00:00Z"),
      },
    ]);
  });

  afterAll(() => app?.cleanup());

  it("marks evidence creation, deletion, and a same-source content revision stale", async () => {
    const caller = app.makeCaller(owner);
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "GAP_FRESH_SOURCE",
      caseId: caseIds.evidence,
      userId: owner.id,
      metadata: JSON.stringify({ contentHash: "a".repeat(64) }),
    }));

    const first = await caller.gapAnalysis.analyze({ caseId: caseIds.evidence });
    expect(first.coverage).toMatchObject({
      analysisStatus: "fresh",
      inputRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      caseRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      inputs: [expect.objectContaining({
        id: "GAP_FRESH_SOURCE",
        contentHash: "a".repeat(64),
      })],
    });
    await expect(caller.gapAnalysis.getSummary({ caseId: caseIds.evidence }))
      .resolves.toMatchObject({ analysisStatus: "fresh" });

    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "GAP_FRESH_ADDED",
      caseId: caseIds.evidence,
      userId: owner.id,
      metadata: JSON.stringify({ contentHash: "b".repeat(64) }),
    }));
    await expect(caller.gapAnalysis.getSummary({ caseId: caseIds.evidence }))
      .resolves.toMatchObject({ analysisStatus: "stale", gapsCount: 0, patternsCount: 0 });
    await expect(caller.gapAnalysis.getGaps({ caseId: caseIds.evidence })).resolves.toEqual([]);

    await caller.gapAnalysis.analyze({ caseId: caseIds.evidence });
    await app.db.delete(app.schema.evidence).where(eq(app.schema.evidence.id, "GAP_FRESH_ADDED"));
    await expect(caller.gapAnalysis.getSummary({ caseId: caseIds.evidence }))
      .resolves.toMatchObject({ analysisStatus: "stale" });

    await caller.gapAnalysis.analyze({ caseId: caseIds.evidence });
    await app.db.update(app.schema.evidence).set({
      metadata: JSON.stringify({ contentHash: "c".repeat(64) }),
      updatedAt: new Date("2026-09-19T12:00:00Z"),
    }).where(eq(app.schema.evidence.id, "GAP_FRESH_SOURCE"));
    await expect(caller.gapAnalysis.getSummary({ caseId: caseIds.evidence }))
      .resolves.toMatchObject({ analysisStatus: "stale" });
  });

  it("keeps unchanged reruns idempotently bound to the same input revision", async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.gapAnalysis.analyze({ caseId: caseIds.unchanged });
    const second = await caller.gapAnalysis.analyze({ caseId: caseIds.unchanged });
    expect(second.coverage.inputRevision).toBe(first.coverage.inputRevision);
    expect(second.coverage.caseRevision).toBe(first.coverage.caseRevision);
    expect(second.coverage.sourceRevision).toBe(first.coverage.sourceRevision);
    await expect(caller.gapAnalysis.getSummary({ caseId: caseIds.unchanged }))
      .resolves.toMatchObject({ analysisStatus: "fresh" });
  });

  it("marks a material owner timeline correction stale through the real product path", async () => {
    const caller = app.makeCaller(owner);
    const uploaded = await caller.evidenceFiles.upload({
      caseId: caseIds.correction,
      title: "Decision.txt",
      type: "document",
      fileName: "decision.txt",
      mimeType: "text/plain",
      source: "manual",
      base64: Buffer.from("Besluit van 14 juli 2026. De aanvraag is afgewezen.").toString("base64"),
    });
    await caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: false });
    await caller.gapAnalysis.analyze({ caseId: caseIds.correction });
    const timeline = await caller.documentAnalysis.generateCaseTimeline({ caseId: caseIds.correction });
    const target = timeline.events[0];
    await caller.documentAnalysis.updateTimelineEvent({
      caseId: caseIds.correction,
      revision: timeline.revision,
      eventKey: target.eventKey,
      date: target.date,
      title: target.title,
      description: "Owner-verified correction to the event detail.",
      actor: target.actor || "Owner",
      reason: "Checked against the original source.",
    });
    await expect(caller.gapAnalysis.getSummary({ caseId: caseIds.correction }))
      .resolves.toMatchObject({ analysisStatus: "stale" });
  });

  it("records a failed recomputation and never exposes the previous derived rows as current", async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.gapAnalysis.analyze({ caseId: caseIds.failure });
    expect(first.gaps.length).toBeGreaterThan(0);
    await app.db.insert(app.schema.timeline).values({
      id: "GAP_FAILURE_CHANGED_INPUT",
      caseId: caseIds.failure,
      userId: owner.id,
      eventType: "event",
      title: "Changed input",
      eventAt: new Date("2026-09-01T12:00:00Z"),
      metadata: JSON.stringify({ reviewStatus: "reviewed" }),
      createdAt: new Date("2026-09-01T12:00:00Z"),
    });

    const sqlite = (app.db as any).$client ?? (app.db as any).session?.client;
    sqlite.exec(`
      CREATE TRIGGER fail_gap_analysis_insert
      BEFORE INSERT ON communication_gaps
      WHEN NEW.caseId = '${caseIds.failure}'
      BEGIN
        SELECT RAISE(ABORT, 'injected gap-analysis write failure');
      END;
    `);
    await expect(caller.gapAnalysis.analyze({ caseId: caseIds.failure })).rejects.toThrow();
    sqlite.exec("DROP TRIGGER fail_gap_analysis_insert");

    await expect(caller.gapAnalysis.getSummary({ caseId: caseIds.failure })).resolves.toMatchObject({
      hasAnalysis: true,
      analysisStatus: "failed",
      gapsCount: 0,
      patternsCount: 0,
    });
    await expect(caller.gapAnalysis.getCoverage({ caseId: caseIds.failure })).resolves.toMatchObject({
      analysisStatus: "failed",
      failureCode: "analysis_failed",
    });
    await expect(caller.gapAnalysis.getGaps({ caseId: caseIds.failure })).resolves.toEqual([]);
    const persistedRows = await app.db.select().from(app.schema.communicationGaps)
      .where(eq(app.schema.communicationGaps.caseId, caseIds.failure));
    expect(persistedRows.length).toBeGreaterThan(0);
  });
});
