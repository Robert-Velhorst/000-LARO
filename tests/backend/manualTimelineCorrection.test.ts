import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

function providerResponse(content: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

(sqliteAvailable ? describe : describe.skip)("owner timeline corrections", () => {
  let app: TestApp;
  const owner = { id: "timeline-owner", email: "timeline@example.test", name: "Owner", role: "user" };
  const other = { id: "timeline-other", email: "other@example.test", name: "Other", role: "user" };
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    await app.db.insert(app.schema.cases).values(buildCase({ id: "timeline-case", userId: owner.id }));
  });
  afterAll(() => app?.cleanup());
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("persists precise edits without a language model, preserves sources and rejects stale or invalid edits", async () => {
    const caller = app.makeCaller(owner);
    const uploaded = await caller.evidenceFiles.upload({ caseId: "timeline-case", title: "Decision.txt", type: "document", fileName: "decision.txt", mimeType: "text/plain", source: "manual", base64: Buffer.from("Besluit van 14 juli 2026. De gemeente heeft de aanvraag afgewezen.").toString("base64") });
    await caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: false });
    const originalAnalysis = await caller.documentAnalysis.byEvidence({ evidenceId: uploaded.id });
    const original = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    expect(original.events.length).toBeGreaterThan(0);
    const target = original.events[0];
    const input = { caseId: "timeline-case", revision: original.revision, eventKey: target.eventKey, date: "2026-07-15", title: "Decision received", description: "The owner received the decision.", actor: "Owner", reason: "Receipt date checked against the source." };
    await expect(app.makeCaller(other).documentAnalysis.updateTimelineEvent(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.documentAnalysis.updateTimelineEvent({ ...input, date: "2026-02-30" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.documentAnalysis.updateTimelineEvent({ ...input, reason: "" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const saved = await caller.documentAnalysis.updateTimelineEvent(input);
    await expect(caller.documentAnalysis.updateTimelineEvent(input)).rejects.toMatchObject({ code: "CONFLICT" });
    const updated = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    expect(updated.events).toHaveLength(original.events.length);
    expect(updated.events).toContainEqual(expect.objectContaining({ date: input.date, title: input.title, source: expect.objectContaining({ evidenceId: uploaded.id }) }));
    expect(updated.corrections).toContainEqual(expect.objectContaining({ id: saved.id, provider: "manual", before: expect.objectContaining({ date: target.date }), after: expect.objectContaining({ date: input.date }), reason: input.reason }));
    expect(await caller.documentAnalysis.byEvidence({ evidenceId: uploaded.id })).toEqual(originalAnalysis);
    const nextTarget = updated.events.find((event) => event.title === input.title)!;
    // Even a second edit that keeps its date and title must invalidate another open editor.
    await caller.documentAnalysis.updateTimelineEvent({ ...input, eventKey: nextTarget.eventKey, revision: updated.revision, description: "A more precise owner correction." });
    await expect(caller.documentAnalysis.updateTimelineEvent({ ...input, eventKey: nextTarget.eventKey, revision: updated.revision })).rejects.toMatchObject({ code: "CONFLICT" });
    const history = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    expect(history.corrections).toHaveLength(2);
    const audits = await caller.audit.list({ limit: 100 });
    expect(audits).toContainEqual(expect.objectContaining({ action: "timeline.manual_correction_applied", entityId: saved.id }));
    const [source] = await app.db.select().from(app.schema.evidence).where(eq(app.schema.evidence.id, uploaded.id));
    expect(source.title).toBe("Decision.txt");
  });

  it("rejects collisions and concurrent stale writes", async () => {
    const caller = app.makeCaller(owner);
    const current = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    const target = current.events[0];
    await app.db.insert(app.schema.timeline).values({ id: "timeline-second", caseId: "timeline-case", userId: owner.id, eventType: "imported", title: "Second event", description: "Another source-linked event.", eventAt: new Date("2026-08-01T12:00:00Z"), metadata: JSON.stringify({ evidenceId: target.source.evidenceId }) });
    const fresh = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    const input = { caseId: "timeline-case", eventKey: target.eventKey, revision: fresh.revision, date: "2026-08-01", title: "Second event", description: "Owner correction", actor: "Owner", reason: "Checked against source." };
    await expect(caller.documentAnalysis.updateTimelineEvent(input)).rejects.toMatchObject({ code: "CONFLICT" });
    const results = await Promise.allSettled([
      caller.documentAnalysis.updateTimelineEvent({ ...input, title: "Concurrent change A" }),
      caller.documentAnalysis.updateTimelineEvent({ ...input, title: "Concurrent change B" }),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect((await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" })).events).toHaveLength(fresh.events.length);
  });

  it("invalidates an open editor when the underlying analysis changes", async () => {
    const caller = app.makeCaller(owner);
    const current = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    const target = current.events[0];
    await app.db.update(app.schema.documentAnalyses).set({ updatedAt: new Date("2030-01-01T00:00:00Z") }).where(eq(app.schema.documentAnalyses.caseId, "timeline-case"));
    await expect(caller.documentAnalysis.updateTimelineEvent({ caseId: "timeline-case", eventKey: target.eventKey, revision: current.revision, date: target.date, title: target.title, description: target.description, actor: target.actor || "", reason: "Attempt from an outdated analysis." })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("prevents an in-flight assistant correction from overwriting a manual correction", async () => {
    const caller = app.makeCaller(owner);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: true });
    vi.stubEnv("OPENAI_API_KEY", "fixture-only");
    let signal!: () => void;
    let release!: (response: Response) => void;
    const started = new Promise<void>((resolve) => { signal = resolve; });
    vi.stubGlobal("fetch", () => { signal(); return new Promise<Response>((resolve) => { release = resolve; }); });
    const pending = caller.documentAnalysis.correctCaseTimeline({ caseId: "timeline-case", instruction: "Change the date of the first event to 2026-08-03." });
    const assertion = expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
    await started;
    const current = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    const target = current.events[0];
    await caller.documentAnalysis.updateTimelineEvent({ caseId: "timeline-case", eventKey: target.eventKey, revision: current.revision, date: target.date, title: target.title, description: "Manual correction saved while assistant is busy.", actor: "Owner", reason: "Checked the original source." });
    release(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      operation: "update", targetEventId: "E1", sourceDocumentId: "D1", date: "2026-08-03",
      title: null, description: null, actor: null, category: null, reason: "Owner instruction.",
      fieldSupport: [{ field: "date", basis: "owner_instruction", citationIds: [], evidenceQuotes: ["2026-08-03"] }],
    }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    await assertion;
    expect((await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" })).events).toContainEqual(expect.objectContaining({ description: "Manual correction saved while assistant is busy." }));
    await caller.userPreferences.updateWorkflow({ analysisProvider: "local" });
  });

  it("keeps a grounded proposal out of the timeline until the owner confirms, and records rejection", async () => {
    const caller = app.makeCaller(owner);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: true });
    vi.stubEnv("OPENAI_API_KEY", "fixture-only");
    const before = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(providerResponse({
      operation: "remove",
      targetEventId: "E1",
      sourceDocumentId: "D1",
      date: null,
      title: null,
      description: null,
      actor: null,
      category: null,
      reason: "The owner requested review of whether this source event should remain.",
      fieldSupport: [{
        field: "removal", basis: "evidence", citationIds: ["src-1"],
        evidenceQuotes: ["Besluit van 14 juli 2026."],
      }],
    })));
    const proposal = await caller.documentAnalysis.correctCaseTimeline({
      caseId: "timeline-case",
      instruction: "Propose removing the first event after reviewing its source.",
    });
    const pending = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    expect(pending.events).toEqual(before.events);
    expect(pending.revision).toBe(before.revision);
    expect(pending.corrections).toEqual(before.corrections);
    await expect(app.makeCaller(other).documentAnalysis.reviewTimelineCorrection({
      caseId: "timeline-case", proposalId: proposal.id, decision: "confirm",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const rejected = await caller.documentAnalysis.reviewTimelineCorrection({
      caseId: "timeline-case", proposalId: proposal.id, decision: "reject",
    });
    expect(rejected).toMatchObject({ proposalId: proposal.id, decision: "rejected" });
    const after = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    expect(after.events).toEqual(before.events);
    expect(after.revision).toBe(before.revision);
    await expect(caller.documentAnalysis.reviewTimelineCorrection({
      caseId: "timeline-case", proposalId: proposal.id, decision: "confirm",
    })).rejects.toMatchObject({ code: "CONFLICT" });
    const audits = await caller.audit.list({ limit: 100 });
    expect(audits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "timeline.ai_correction_rejected",
        entityId: proposal.id,
        details: expect.objectContaining({
          instruction: "[REDACTED_CONTENT]",
          actorUserId: owner.id,
          finalDecision: "rejected",
          reviewedOld: expect.any(Object),
          reviewedNew: null,
          sourceBasis: expect.any(Object),
        }),
      }),
    ]));
    await caller.userPreferences.updateWorkflow({ analysisProvider: "local" });
  });

  it("rejects hallucinated field support and cross-case document references without altering the timeline", async () => {
    const caller = app.makeCaller(owner);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: true });
    vi.stubEnv("OPENAI_API_KEY", "fixture-only");
    const before = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    const fetch = vi.fn()
      .mockResolvedValueOnce(providerResponse({
        operation: "update", targetEventId: "E1", sourceDocumentId: "D1", date: "2031-01-02",
        title: null, description: null, actor: null, category: null, reason: "Unsupported date.",
        fieldSupport: [{ field: "date", basis: "owner_instruction", citationIds: [], evidenceQuotes: ["2031-01-01"] }],
      }))
      .mockResolvedValueOnce(providerResponse({
        operation: "update", targetEventId: "E1", sourceDocumentId: "D999", date: "2031-01-03",
        title: null, description: null, actor: null, category: null, reason: "Wrong source.",
        fieldSupport: [{ field: "date", basis: "owner_instruction", citationIds: [], evidenceQuotes: ["2031-01-03"] }],
      }));
    vi.stubGlobal("fetch", fetch);
    await expect(caller.documentAnalysis.correctCaseTimeline({
      caseId: "timeline-case",
      instruction: "Change the first event date to 2031-01-01.",
    })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("not literally supported") });
    await expect(caller.documentAnalysis.correctCaseTimeline({
      caseId: "timeline-case",
      instruction: "Change the first event date to 2031-01-03.",
    })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("does not belong") });
    const after = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    expect(after.events).toEqual(before.events);
    expect(after.revision).toBe(before.revision);
    expect(after.corrections).toEqual(before.corrections);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "local" });
  });

  it("leaves the timeline unchanged when the provider fails or returns malformed output", async () => {
    const caller = app.makeCaller(owner);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: true });
    vi.stubEnv("OPENAI_API_KEY", "fixture-only");
    const before = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("provider unavailable")));
    await expect(caller.documentAnalysis.correctCaseTimeline({
      caseId: "timeline-case", instruction: "Change the first event date to 2032-02-02.",
    })).rejects.toThrow();
    const afterFailure = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    expect(afterFailure.events).toEqual(before.events);
    expect(afterFailure.revision).toBe(before.revision);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "not json" } }],
    }), { status: 200, headers: { "content-type": "application/json" } })));
    await expect(caller.documentAnalysis.correctCaseTimeline({
      caseId: "timeline-case", instruction: "Change the first event date to 2032-02-02.",
    })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("malformed") });
    const afterMalformed = await caller.documentAnalysis.generateCaseTimeline({ caseId: "timeline-case" });
    expect(afterMalformed.events).toEqual(before.events);
    expect(afterMalformed.revision).toBe(before.revision);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "local" });
  });
});
