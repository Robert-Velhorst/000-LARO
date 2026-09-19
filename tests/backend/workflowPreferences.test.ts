import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { EXTERNAL_DOCUMENT_SHARING_SCOPE } from "../../shared/workflowConsent";

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
      shareRawDocumentContent: false,
      externalDocumentSharingConsent: null,
      outreachReviewMode: "each",
      messageApprovalMode: "each",
    });

    const updated = await ownerCaller.userPreferences.updateWorkflow({
      analysisMode: "cloud",
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
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai" });
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

  it("does not treat a legacy sharing flag or another actor's record as consent", async () => {
    const legacy = {
      analysisMode: "cloud",
      analysisProvider: "openai",
      autoAnalyzeImports: true,
      autoOrganizeDocuments: true,
      shareRawDocumentContent: true,
      outreachReviewMode: "each",
      messageApprovalMode: "each",
    };
    await app.db.insert(app.schema.userPreferences).values({
      id: "legacy-workflow-preferences",
      userId: other.id,
      key: "workflow-controls",
      value: JSON.stringify(legacy),
      updatedAt: new Date(),
    });
    const otherCaller = app.makeCaller(other);
    await expect(otherCaller.userPreferences.workflow()).resolves.toMatchObject({
      analysisProvider: "openai",
      shareRawDocumentContent: false,
      externalDocumentSharingConsent: null,
    });

    await app.db.update(app.schema.userPreferences).set({
      value: JSON.stringify({
        ...legacy,
        externalDocumentSharingConsent: {
          id: "foreign-consent",
          version: 1,
          provider: "openai",
          scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
          actorUserId: owner.id,
          grantedAt: new Date().toISOString(),
          automaticImports: true,
          revokedAt: null,
          revokedByUserId: null,
        },
      }),
    }).where(and(
      eq(app.schema.userPreferences.userId, other.id),
      eq(app.schema.userPreferences.key, "workflow-controls"),
    ));
    await expect(otherCaller.userPreferences.workflow()).resolves.toMatchObject({
      shareRawDocumentContent: false,
      externalDocumentSharingConsent: null,
    });
  });

  it("records reviewed provider-bound consent and revokes it on provider, import, and owner changes", async () => {
    const caller = app.makeCaller(owner);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", autoAnalyzeImports: true });
    await expect(caller.userPreferences.workflow()).resolves.toMatchObject({
      analysisProvider: "openai",
      shareRawDocumentContent: false,
      externalDocumentSharingConsent: null,
    });

    await expect(caller.userPreferences.grantExternalDocumentSharing({
      provider: "openai",
      scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
      automaticImports: true,
      acknowledgeFullDocumentContent: false,
      acknowledgeAutomaticImports: true,
    } as any)).rejects.toThrow();
    await expect(caller.userPreferences.grantExternalDocumentSharing({
      provider: "openai",
      scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
      automaticImports: false,
      acknowledgeFullDocumentContent: true,
      acknowledgeAutomaticImports: true,
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const granted = await caller.userPreferences.grantExternalDocumentSharing({
      provider: "openai",
      scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
      automaticImports: true,
      acknowledgeFullDocumentContent: true,
      acknowledgeAutomaticImports: true,
    });
    expect(granted).toMatchObject({
      analysisProvider: "openai",
      shareRawDocumentContent: true,
      externalDocumentSharingConsent: {
        version: 1,
        provider: "openai",
        scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
        actorUserId: owner.id,
        automaticImports: true,
        revokedAt: null,
        revokedByUserId: null,
      },
    });
    expect(new Date(granted.externalDocumentSharingConsent!.grantedAt).toISOString())
      .toBe(granted.externalDocumentSharingConsent!.grantedAt);

    const switched = await caller.userPreferences.updateWorkflow({ analysisProvider: "together" });
    expect(switched).toMatchObject({
      analysisProvider: "together",
      shareRawDocumentContent: false,
      externalDocumentSharingConsent: {
        id: granted.externalDocumentSharingConsent!.id,
        provider: "openai",
        revokedByUserId: owner.id,
      },
    });
    expect(switched.externalDocumentSharingConsent?.revokedAt).toEqual(expect.any(String));

    const together = await caller.userPreferences.grantExternalDocumentSharing({
      provider: "together",
      scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
      automaticImports: true,
      acknowledgeFullDocumentContent: true,
      acknowledgeAutomaticImports: true,
    });
    expect(together.shareRawDocumentContent).toBe(true);
    const importChanged = await caller.userPreferences.updateWorkflow({ autoAnalyzeImports: false });
    expect(importChanged).toMatchObject({
      shareRawDocumentContent: false,
      externalDocumentSharingConsent: { provider: "together", automaticImports: true, revokedByUserId: owner.id },
    });

    await caller.userPreferences.updateWorkflow({ autoAnalyzeImports: true });
    const regranted = await caller.userPreferences.grantExternalDocumentSharing({
      provider: "together",
      scope: EXTERNAL_DOCUMENT_SHARING_SCOPE,
      automaticImports: true,
      acknowledgeFullDocumentContent: true,
      acknowledgeAutomaticImports: true,
    });
    const revoked = await caller.userPreferences.revokeExternalDocumentSharing({
      consentId: regranted.externalDocumentSharingConsent!.id,
    });
    expect(revoked).toMatchObject({
      shareRawDocumentContent: false,
      externalDocumentSharingConsent: { revokedByUserId: owner.id },
    });

    const consentAudits = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.userId, owner.id),
      eq(app.schema.auditLogs.entityType, "workflow_consent"),
    ));
    expect(consentAudits.filter((row) => row.action === "workflow.external_document_sharing_granted")).toHaveLength(3);
    expect(consentAudits.filter((row) => row.action === "workflow.external_document_sharing_revoked")).toHaveLength(3);
    expect(JSON.parse(consentAudits.find((row) => row.action === "workflow.external_document_sharing_granted")!.details!))
      .toMatchObject({ provider: "openai", scope: EXTERNAL_DOCUMENT_SHARING_SCOPE, actorUserId: owner.id, automaticImports: true });
    await caller.userPreferences.updateWorkflow({ analysisProvider: "local" });
  });

  it("supports batch approval but keeps automatic external messages pending", async () => {
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
    const reviews = await Promise.all(queue.map((item: any) => caller.workflow.preSendReview({ outreachId: item.id })));
    await expect(caller.workflow.approveDrafts({
      approvals: [
        { outreachId: queue[0].id, approvalHash: reviews[0].message.approvalHash },
        { outreachId: "OUTREACH_NOT_OWNED", approvalHash: reviews[0].message.approvalHash },
      ],
    })).rejects.toThrow("not found");
    const unchangedRows = await caller.outreach.byCaseId("CASE_WORKFLOW_OUTREACH");
    expect(unchangedRows.every((row: any) => row.status === "PendingApproval")).toBe(true);
    const approved = await caller.workflow.approveDrafts({
      approvals: reviews.map((review: any) => ({
        outreachId: review.outreachId,
        approvalHash: review.message.approvalHash,
      })),
    });
    expect(approved).toEqual({ success: true, approved: 2, sent: false });

    const rows = await caller.outreach.byCaseId("CASE_WORKFLOW_OUTREACH");
    expect(rows.every((row: any) => row.status === "Approved" && row.initialContact === null)).toBe(true);
    expect(await app.db.select().from(app.schema.emailActivity)).toHaveLength(0);

    await app.db.insert(app.schema.cases).values(buildCase({ id: "CASE_WORKFLOW_AUTO", userId: owner.id }));
    await caller.userPreferences.updateWorkflow({ messageApprovalMode: "automatic" });
    const automatic = await caller.workflow.initiateOutreach({ caseId: "CASE_WORKFLOW_AUTO", maxResults: 1 });
    expect(automatic.automaticallyApproved).toBe(0);
    const autoRows = await caller.outreach.byCaseId("CASE_WORKFLOW_AUTO");
    expect(autoRows[0]).toMatchObject({ status: "PendingApproval", initialContact: null });
    expect(await app.db.select().from(app.schema.emailActivity)).toHaveLength(0);
  });
});
