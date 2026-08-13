import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("persisted workflow controls", () => {
  let app: TestApp;
  const owner = { id: "USER_WORKFLOW_OWNER", name: "Owner", role: "user", email: "workflow-owner@example.com" };
  const other = { id: "USER_WORKFLOW_OTHER", name: "Other", role: "user", email: "workflow-other@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(owner),
      buildUser(other),
    ]);
  });

  afterAll(() => app?.cleanup());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("defaults to cost-saving local analysis and keeps preferences owner-scoped and audited", async () => {
    const ownerCaller = app.makeCaller(owner);
    const otherCaller = app.makeCaller(other);

    await expect(ownerCaller.userPreferences.workflow()).resolves.toMatchObject({
      analysisMode: "local",
      autoAnalyzeImports: true,
      shareRawDocumentContent: true,
      outreachReviewMode: "each",
      messageApprovalMode: "each",
    });

    const updated = await ownerCaller.userPreferences.updateWorkflow({
      analysisMode: "cloud",
      shareRawDocumentContent: false,
      outreachReviewMode: "batch",
      messageApprovalMode: "batch",
    });
    expect(updated).toMatchObject({
      analysisMode: "cloud",
      shareRawDocumentContent: false,
      outreachReviewMode: "batch",
      messageApprovalMode: "batch",
    });
    await expect(otherCaller.userPreferences.workflow()).resolves.toMatchObject({ analysisMode: "local" });

    const audit = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.userId, owner.id),
      eq(app.schema.auditLogs.action, "workflow.preferences_updated"),
    ));
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0].details)).toMatchObject({ analysisMode: "cloud", messageApprovalMode: "batch" });

    await Promise.all([
      ownerCaller.userPreferences.updateWorkflow({ autoAnalyzeImports: false }),
      ownerCaller.userPreferences.updateWorkflow({ messageApprovalMode: "automatic" }),
    ]);
    await expect(ownerCaller.userPreferences.workflow()).resolves.toMatchObject({
      autoAnalyzeImports: false,
      messageApprovalMode: "automatic",
    });
    const keyedRows = await app.db.select({ id: app.schema.userPreferences.id })
      .from(app.schema.userPreferences)
      .where(and(
        eq(app.schema.userPreferences.userId, owner.id),
        eq(app.schema.userPreferences.key, "workflow-controls"),
      ));
    expect(keyedRows).toHaveLength(1);
  });

  it("does not send raw content to a provider when full-source sharing is disabled", async () => {
    const caller = app.makeCaller(owner);
    await app.db.insert(app.schema.cases).values(buildCase({ id: "CASE_WORKFLOW_ANALYSIS", userId: owner.id }));
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: false });
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const fetchMock = vi.fn(() => Promise.reject(new Error("provider must not be called")));
    vi.stubGlobal("fetch", fetchMock);

    const source = Buffer.from("Besluit van 14 juli 2026. U moet binnen zes weken bezwaar maken.");
    const uploaded = await caller.evidenceFiles.upload({
      caseId: "CASE_WORKFLOW_ANALYSIS",
      title: "Besluit.txt",
      type: "document",
      fileName: "besluit.txt",
      mimeType: "text/plain",
      source: "manual",
      base64: source.toString("base64"),
    });
    const analysis = await caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: true });
    expect(analysis.result.providerStatus).toBe("not_requested");
    expect(fetchMock).not.toHaveBeenCalled();
    const assistantAnswer = await caller.assistant.ask({
      caseId: "CASE_WORKFLOW_ANALYSIS",
      question: "What is the objection deadline?",
    });
    expect(assistantAnswer.mode).not.toBe("provider");
    await expect(caller.documentAnalysis.correctCaseTimeline({
      caseId: "CASE_WORKFLOW_ANALYSIS",
      instruction: "Change the decision date to 15 July 2026.",
    })).rejects.toThrow("full-source cloud analysis");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(caller.documentAnalysis.capabilities()).resolves.toMatchObject({
      selectedAnalysisMode: "cloud",
      selectedAnalysisProvider: "openai",
      shareRawDocumentContent: false,
    });
  });

  it("supports batch and automatic draft approval without claiming that a message was sent", async () => {
    const caller = app.makeCaller(owner);
    await app.db.insert(app.schema.cases).values(buildCase({ id: "CASE_WORKFLOW_OUTREACH", userId: owner.id }));
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "LAWYER_WORKFLOW_1", name: "Lawyer One" }),
      buildLawyer({ id: "LAWYER_WORKFLOW_2", name: "Lawyer Two" }),
    ]);

    await caller.userPreferences.updateWorkflow({ messageApprovalMode: "batch" });
    await caller.workflow.initiateOutreach({ caseId: "CASE_WORKFLOW_OUTREACH", maxResults: 2 });
    const queue = await caller.workflow.reviewQueue({ caseId: "CASE_WORKFLOW_OUTREACH" });
    expect(queue).toHaveLength(2);
    await expect(caller.workflow.approveDrafts({
      outreachIds: [queue[0].id, "OUTREACH_NOT_OWNED"],
    })).rejects.toThrow("not found");
    const unchangedRows = await caller.outreach.byCaseId("CASE_WORKFLOW_OUTREACH");
    expect(unchangedRows.every((row: any) => row.status === "PendingApproval")).toBe(true);
    const approved = await caller.workflow.approveDrafts({ outreachIds: queue.map((item: any) => item.id) });
    expect(approved).toEqual({ success: true, approved: 2, sent: false });

    const rows = await caller.outreach.byCaseId("CASE_WORKFLOW_OUTREACH");
    expect(rows.every((row: any) => row.status === "Approved" && row.initialContact === null)).toBe(true);
    expect(await app.db.select().from(app.schema.emailActivity)).toHaveLength(0);

    await app.db.insert(app.schema.cases).values(buildCase({ id: "CASE_WORKFLOW_AUTO", userId: owner.id }));
    await caller.userPreferences.updateWorkflow({ messageApprovalMode: "automatic" });
    const automatic = await caller.workflow.initiateOutreach({ caseId: "CASE_WORKFLOW_AUTO", maxResults: 1 });
    expect(automatic.automaticallyApproved).toBe(1);
    const autoRows = await caller.outreach.byCaseId("CASE_WORKFLOW_AUTO");
    expect(autoRows[0]).toMatchObject({ status: "Approved", initialContact: null });
    expect(await app.db.select().from(app.schema.emailActivity)).toHaveLength(0);
  });
});
