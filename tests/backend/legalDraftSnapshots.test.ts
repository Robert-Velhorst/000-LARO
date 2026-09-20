import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCase, buildEvidence, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("reviewed legal draft snapshots", () => {
  let app: TestApp;
  const owner = { id: "LEGAL_DRAFT_OWNER", name: "Draft owner", role: "user", email: "draft-owner@example.test" };
  const other = { id: "LEGAL_DRAFT_OTHER", name: "Other owner", role: "user", email: "draft-other@example.test" };
  const erase = { id: "LEGAL_DRAFT_ERASE", name: "Erase owner", role: "user", email: "draft-erase@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(owner),
      buildUser(other),
      buildUser(erase),
    ]);
  });

  afterAll(() => app?.cleanup());
  afterEach(() => vi.restoreAllMocks());

  async function createAnalyzedCase(user: typeof owner, caseId: string) {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: user.id,
      clientName: `${user.name} client`,
      caseSummary: "A source-bounded dispute requiring records review.",
    }));
    const caller = app.makeCaller(user);
    await caller.gapAnalysis.analyze({ caseId });
    return caller;
  }

  function rejectAuditAction(action: string, triggerName: string): () => void {
    app.db.$client.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = '${action}'
      BEGIN
        SELECT RAISE(ABORT, 'injected mandatory audit failure');
      END;
    `);
    return () => app.db.$client.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  }

  it("requires a reviewed recipient, persists exact bytes, versions changed inputs, and re-downloads history", async () => {
    const caseId = "LEGAL_DRAFT_CASE";
    const caller = await createAnalyzedCase(owner, caseId);

    await expect(caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "demand_letter",
      recipientRevisionId: "not-reviewed",
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const recipientInput = {
      caseId,
      name: "Reviewed Records Department",
      address: "Evidence Street 10\n1234 AB Utrecht\nNetherlands",
      provenanceType: "owner_entered" as const,
      confirmed: true as const,
    };
    const silentMandatoryFailure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const releaseRecipientAudit = rejectAuditAction(
      "legal_draft.recipient_reviewed",
      "reject_legal_recipient_audit",
    );
    try {
      await expect(caller.gapAnalysis.saveReviewedRecipient(recipientInput)).rejects.toThrow();
    } finally {
      releaseRecipientAudit();
    }
    expect(await app.db.select().from(app.schema.legalDraftRecipients).where(
      eq(app.schema.legalDraftRecipients.caseId, caseId),
    )).toHaveLength(0);
    const recipient = await caller.gapAnalysis.saveReviewedRecipient(recipientInput);
    expect(recipient).toMatchObject({
      revision: 1,
      provenanceType: "owner_entered",
      sourceReference: { kind: "owner_entered" },
    });

    const first = await caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "demand_letter",
      demandAmount: 1250,
      recipientRevisionId: recipient.id,
    });
    expect(first.snapshot).toMatchObject({ version: 1, status: "pending_review", recipientRevision: 1 });
    expect(first.document.content).toContain("To: Reviewed Records Department");
    expect(first.document.content).toContain("Evidence Street 10");
    expect(first.document.content).not.toContain("[Address to verify]");
    expect(first.document.content).not.toMatch(/To: Opponent\b/);
    await expect(caller.gapAnalysis.prepareLegalDraftDownload({ draftId: first.snapshot.id }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    const reviewInput = {
      draftId: first.snapshot.id,
      contentHash: first.snapshot.contentHash,
      confirmed: true as const,
    };
    const releaseReviewAudit = rejectAuditAction("legal_draft.reviewed", "reject_legal_draft_review_audit");
    try {
      await expect(caller.gapAnalysis.reviewLegalDraft(reviewInput)).rejects.toThrow();
    } finally {
      releaseReviewAudit();
    }
    expect((await caller.gapAnalysis.listLegalDrafts({ caseId }))[0].status).toBe("pending_review");
    const reviewed = await caller.gapAnalysis.reviewLegalDraft(reviewInput);
    expect(reviewed.status).toBe("reviewed");
    let prepared = await caller.gapAnalysis.prepareLegalDraftDownload({ draftId: first.snapshot.id });
    let token = prepared.url.match(/\/api\/legal-draft\/([^/]+)\.txt$/)?.[1];
    expect(token).toBeTruthy();
    const snapshots = await import("../../server/legalDraftSnapshots");
    let downloadedDraftId = snapshots.consumeLegalDraftDownloadTicket(token!, owner.id);
    const releaseDownloadAudit = rejectAuditAction("legal_draft.downloaded", "reject_legal_draft_download_audit");
    try {
      await expect(snapshots.recordReviewedLegalDraftDownload(owner.id, downloadedDraftId)).rejects.toThrow();
    } finally {
      releaseDownloadAudit();
    }
    expect(await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.userId, owner.id),
      eq(app.schema.auditLogs.action, "legal_draft.downloaded"),
    ))).toHaveLength(0);

    prepared = await caller.gapAnalysis.prepareLegalDraftDownload({ draftId: first.snapshot.id });
    token = prepared.url.match(/\/api\/legal-draft\/([^/]+)\.txt$/)?.[1];
    expect(token).toBeTruthy();
    downloadedDraftId = snapshots.consumeLegalDraftDownloadTicket(token!, owner.id);
    const downloaded = await snapshots.recordReviewedLegalDraftDownload(owner.id, downloadedDraftId);
    expect(downloaded.bytes.length).toBe(first.snapshot.byteLength);
    expect(createHash("sha256").update(downloaded.bytes).digest("hex")).toBe(first.snapshot.contentHash);
    expect(downloaded.bytes.toString("utf8")).toContain("Reviewed Records Department");

    const downloadAudits = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.userId, owner.id),
      eq(app.schema.auditLogs.action, "legal_draft.downloaded"),
    ));
    expect(downloadAudits).toHaveLength(1);
    expect(downloadAudits[0].details).toContain(first.snapshot.contentHash);
    expect(downloadAudits[0].details).not.toContain("Reviewed Records Department");
    expect(downloadAudits[0].details).not.toContain("Evidence Street");
    silentMandatoryFailure.mockRestore();

    await caller.cases.update({
      id: caseId,
      caseSummary: "The owner corrected a material case fact after the first review.",
    });
    await expect(caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "demand_letter",
      demandAmount: 1250,
      recipientRevisionId: recipient.id,
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await caller.gapAnalysis.analyze({ caseId });
    const changedCase = await caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "demand_letter",
      demandAmount: 1250,
      recipientRevisionId: recipient.id,
    });
    expect(changedCase.snapshot.version).toBe(2);
    expect(changedCase.snapshot.id).not.toBe(first.snapshot.id);
    expect(changedCase.snapshot.inputRevision).not.toBe(first.snapshot.inputRevision);

    const changedRecipient = await caller.gapAnalysis.saveReviewedRecipient({
      caseId,
      name: "Reviewed Records Department",
      address: "Replacement Avenue 22\n5678 CD Rotterdam\nNetherlands",
      provenanceType: "owner_entered",
      confirmed: true,
    });
    expect(changedRecipient.revision).toBe(2);
    await expect(caller.gapAnalysis.reviewLegalDraft({
      draftId: changedCase.snapshot.id,
      contentHash: changedCase.snapshot.contentHash,
      confirmed: true,
    })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const changedRecipientDraft = await caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "demand_letter",
      demandAmount: 1250,
      recipientRevisionId: changedRecipient.id,
    });
    expect(changedRecipientDraft.snapshot.version).toBe(3);
    expect(changedRecipientDraft.document.content).toContain("Replacement Avenue 22");

    await caller.evidenceFiles.create({
      caseId,
      title: "New source revision",
      type: "document",
      source: "manual",
      description: "A newly added source changes the evidence input revision.",
    });
    await caller.gapAnalysis.analyze({ caseId });
    const changedEvidence = await caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "demand_letter",
      demandAmount: 1250,
      recipientRevisionId: changedRecipient.id,
    });
    expect(changedEvidence.snapshot.version).toBe(4);
    expect(changedEvidence.snapshot.sourceRevision).not.toBe(changedRecipientDraft.snapshot.sourceRevision);

    // A semantically changed derived row advances the analysis revision even
    // when the source-input revision itself has not moved.
    await app.db.insert(app.schema.communicationGaps).values({
      id: "LEGAL_DRAFT_DERIVED_CHANGE",
      caseId,
      data: JSON.stringify({
        gapType: "review_question",
        context: "A newly reviewed derived question must remain version-bound.",
        durationDays: 4,
      }),
      createdAt: new Date(),
    });
    const changedAnalysis = await caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "demand_letter",
      demandAmount: 1250,
      recipientRevisionId: changedRecipient.id,
    });
    expect(changedAnalysis.snapshot.version).toBe(5);
    expect(changedAnalysis.snapshot.inputRevision).toBe(changedEvidence.snapshot.inputRevision);
    expect(changedAnalysis.snapshot.analysisRevision).not.toBe(changedEvidence.snapshot.analysisRevision);

    // The old reviewed snapshot remains an exact, clearly historical record.
    const historical = await caller.gapAnalysis.prepareLegalDraftDownload({ draftId: first.snapshot.id });
    const historicalToken = historical.url.match(/\/api\/legal-draft\/([^/]+)\.txt$/)?.[1];
    const historicalId = snapshots.consumeLegalDraftDownloadTicket(historicalToken!, owner.id);
    const historicalBytes = await snapshots.readReviewedLegalDraft(owner.id, historicalId);
    expect(historicalBytes.contentHash).toBe(first.snapshot.contentHash);
    expect(historicalBytes.bytes.toString("utf8")).toContain("Evidence Street 10");
    expect(historicalBytes.bytes.toString("utf8")).not.toContain("Replacement Avenue 22");

    const versions = await caller.gapAnalysis.listLegalDrafts({ caseId });
    expect(versions.map((draft: { version: number }) => draft.version)).toEqual([5, 4, 3, 2, 1]);
    expect(versions.find((draft: { version: number }) => draft.version === 1)?.isCurrentInputs).toBe(false);
  });

  it("retains source evidence revision provenance and enforces ownership", async () => {
    const caseId = "LEGAL_DRAFT_SOURCE_CASE";
    const caller = await createAnalyzedCase(owner, caseId);
    const evidenceId = "LEGAL_DRAFT_RECIPIENT_SOURCE";
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: evidenceId,
      caseId,
      userId: owner.id,
      title: "Verified address notice",
      metadata: JSON.stringify({
        contentHash: "a".repeat(64),
        sourceRevision: "source-address-v1",
        revisionNumber: 1,
      }),
    }));
    await caller.gapAnalysis.analyze({ caseId });

    const recipient = await caller.gapAnalysis.saveReviewedRecipient({
      caseId,
      name: "Source Linked Recipient",
      address: "Citation Road 3\n1000 AA Amsterdam\nNetherlands",
      provenanceType: "evidence_derived",
      evidenceId,
      confirmed: true,
    });
    expect(recipient.sourceReference).toMatchObject({
      kind: "evidence_derived",
      evidenceId,
      contentHash: "a".repeat(64),
      sourceRevision: "source-address-v1",
      revisionNumber: 1,
    });

    await expect(app.makeCaller(other).gapAnalysis.getReviewedRecipient({ caseId }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const generated = await caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "preservation_notice",
      recipientRevisionId: recipient.id,
    });
    await caller.gapAnalysis.reviewLegalDraft({
      draftId: generated.snapshot.id,
      contentHash: generated.snapshot.contentHash,
      confirmed: true,
    });
    await expect(app.makeCaller(other).gapAnalysis.prepareLegalDraftDownload({ draftId: generated.snapshot.id }))
      .rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const snapshots = await import("../../server/legalDraftSnapshots");
    await expect(snapshots.readReviewedLegalDraft(other.id, generated.snapshot.id))
      .rejects.toThrow("Reviewed draft not found");
  });

  it("exports and erases recipient revisions and draft snapshots with the account", async () => {
    const caseId = "LEGAL_DRAFT_ERASE_CASE";
    const caller = await createAnalyzedCase(erase, caseId);
    const recipient = await caller.gapAnalysis.saveReviewedRecipient({
      caseId,
      name: "Erasure Recipient",
      address: "Privacy Lane 1\n1111 AA Delft\nNetherlands",
      provenanceType: "owner_entered",
      confirmed: true,
    });
    const generated = await caller.gapAnalysis.generateDocument({
      caseId,
      documentType: "discovery_request",
      recipientRevisionId: recipient.id,
    });
    await caller.gapAnalysis.reviewLegalDraft({
      draftId: generated.snapshot.id,
      contentHash: generated.snapshot.contentHash,
      confirmed: true,
    });

    const exported = await caller.gdpr.exportData();
    expect(exported.data.legal_draft_recipients).toHaveLength(1);
    expect(exported.data.legal_draft_snapshots).toHaveLength(1);
    const deleted = await caller.gdpr.deleteData({ confirm: true });
    expect(deleted.deleted).toMatchObject({ users: 1 });
    expect(await app.db.select().from(app.schema.legalDraftRecipients).where(
      eq(app.schema.legalDraftRecipients.userId, erase.id),
    )).toHaveLength(0);
    expect(await app.db.select().from(app.schema.legalDraftSnapshots).where(
      eq(app.schema.legalDraftSnapshots.userId, erase.id),
    )).toHaveLength(0);
  });
});
