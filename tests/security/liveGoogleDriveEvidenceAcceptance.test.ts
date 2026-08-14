import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV } from "../../server/_core/env";
import { encryptToken } from "../../server/emailOAuth";
import { buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("live Google Drive evidence acceptance", () => {
  let app: TestApp;
  const userId = "USER_LIVE_GOOGLE_DRIVE";
  const accountId = "GOOGLE_LIVE_DRIVE";
  const recipient = "owner-drive-acceptance@example.com";
  const runId = "test-live-google-drive-001";
  const originalClientId = ENV.GOOGLE_CLIENT_ID;
  const originalClientSecret = ENV.GOOGLE_CLIENT_SECRET;

  beforeAll(async () => {
    app = await bootTestApp();
    ENV.GOOGLE_CLIENT_ID = "acceptance.apps.googleusercontent.com";
    ENV.GOOGLE_CLIENT_SECRET = "acceptance-client-secret";
    await app.db.insert(app.schema.users).values(buildUser({ id: userId, email: recipient }));
    await app.db.insert(app.schema.emailAccounts).values({
      id: accountId,
      userId,
      provider: "gmail",
      email: recipient,
      accessToken: encryptToken("acceptance-access-token"),
      refreshToken: encryptToken("acceptance-refresh-token"),
      status: "connected",
      connectedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(() => {
    ENV.GOOGLE_CLIENT_ID = originalClientId;
    ENV.GOOGLE_CLIENT_SECRET = originalClientSecret;
    app?.cleanup();
  });

  it("persists, analyzes, opens, receipts, cleans, and safely resumes one Drive source", async () => {
    const { runLiveGoogleDriveEvidenceAcceptance } = await import(
      "../../server/liveGoogleDriveEvidenceAcceptance"
    );
    const {
      readGoogleDriveEvidenceAcceptanceReceipt,
      recordGoogleDriveEvidenceAcceptanceReceipt,
    } = await import("../../server/providerAcceptanceEvidence");
    const { getEvidenceDownloadUrl, readSignedEvidenceDownload, recordEvidenceSourceOpened } =
      await import("../../server/evidenceAccess");
    const { createEvidenceFile } = await import("../../server/evidence");
    const { analyzeStoredEvidence } = await import("../../server/documentAnalysisService");
    const { storagePut, storageRead } = await import("../../server/storage");
    let sourceStorageKey = "";

    const result = await runLiveGoogleDriveEvidenceAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: recipient,
      driveFileName: "Representative acceptance document.txt",
      driveFolderId: "root",
      runId,
    }, {
      pullEvidence: async (params) => {
        expect(params.driveAccountId).toBe(accountId);
        expect(params.driveFolderIds).toEqual(["root"]);
        expect(params.driveExactFileName).toBe("Representative acceptance document.txt");
        expect(params.includeGmail).toBe(false);
        expect(params.includeDrive).toBe(true);
        expect(params.includeLocal).toBe(false);
        const body = Buffer.from("Representative Drive evidence with deterministic legal source text.");
        const stored = await storagePut(
          `evidence/${params.caseId}/gdrive/representative.txt`,
          body,
          "text/plain",
        );
        sourceStorageKey = stored.key;
        const evidenceId = await createEvidenceFile(userId, {
          caseId: params.caseId,
          type: "document",
          source: "google_drive",
          title: "Representative acceptance document.txt",
          description: "Controlled Drive acceptance source",
          fileUrl: stored.url,
          fileName: "representative.txt",
          fileSize: String(body.length),
          mimeType: "text/plain",
          metadata: JSON.stringify({
            storageKey: stored.key,
            driveFileId: "drive-file-acceptance-001",
            driveAccountId: accountId,
            folderId: "root",
            sourceMimeType: "text/plain",
            autoCollected: true,
          }),
          contentHash: stored.sha256,
          relevant: true,
        });
        await app.db.insert(app.schema.googleDriveFiles).values({
          id: "GOOGLE_DRIVE_ACCEPTANCE_ROW",
          userId,
          caseId: params.caseId,
          accountId,
          googleFileId: "drive-file-acceptance-001",
          fileName: "representative.txt",
          mimeType: "text/plain",
          fileSize: String(body.length),
          s3Key: stored.key,
          s3Url: stored.url,
          evidenceType: "document",
          isIncluded: "Yes",
          createdAt: new Date(),
        });
        await app.db.insert(app.schema.autoCollectionLogs).values({
          id: "GOOGLE_DRIVE_ACCEPTANCE_PULL_LOG",
          caseId: params.caseId,
          userId,
          status: "completed",
          filesFound: "1",
          filesDownloaded: "1",
          errorCount: "0",
          createdAt: new Date(),
        });
        await analyzeStoredEvidence({ userId, evidenceId, deepAnalysis: false, force: true });
        return {
          gmailMessages: 0,
          gmailAttachments: 0,
          driveFiles: 1,
          localFiles: 0,
          errors: [],
        };
      },
      getDownloadUrl: getEvidenceDownloadUrl,
      fetchSource: async (url) => {
        const parsed = new URL(url);
        return (await readSignedEvidenceDownload({
          evidenceId: parsed.pathname.split("/").pop()!,
          expires: parsed.searchParams.get("expires") || undefined,
          signature: parsed.searchParams.get("signature") || undefined,
        })).bytes;
      },
      analyzeEvidence: analyzeStoredEvidence,
      recordSourceOpened: recordEvidenceSourceOpened,
      recordReceipt: recordGoogleDriveEvidenceAcceptanceReceipt,
    });

    expect(result).toMatchObject({
      status: "passed",
      alreadyAccepted: false,
      source: "google_drive",
      persistedEvidenceCount: 1,
      sourceContentRead: true,
      contentHashMatched: true,
      analysisCompleted: true,
      sourceOpenedAuditRecorded: true,
      providerProvenanceRecorded: true,
      transientBusinessRowsRemoved: true,
    });
    expect(await app.db.select().from(app.schema.cases)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.evidence)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.documentAnalyses)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.googleDriveFiles)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.autoCollectionLogs)).toHaveLength(0);
    await expect(storageRead(sourceStorageKey)).rejects.toThrow("not found");

    const receipt = await readGoogleDriveEvidenceAcceptanceReceipt(userId);
    expect(receipt).toMatchObject({
      provider: "google",
      source: "google_drive",
      evidencePersisted: true,
      sourceContentRead: true,
      contentHashMatched: true,
      analysisCompleted: true,
      sourceOpenedAudit: true,
    });
    expect(JSON.stringify(receipt)).not.toContain(recipient);
    expect(JSON.stringify(receipt)).not.toContain("drive-file-acceptance-001");

    const resumed = await runLiveGoogleDriveEvidenceAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: recipient,
      driveFileName: "Representative acceptance document.txt",
      runId,
    }, {
      pullEvidence: async () => { throw new Error("An accepted run must not pull Drive again"); },
      getDownloadUrl: async () => { throw new Error("An accepted run must not issue a new URL"); },
      fetchSource: async () => { throw new Error("An accepted run must not fetch again"); },
      analyzeEvidence: async () => { throw new Error("An accepted run must not analyze again"); },
      recordSourceOpened: async () => { throw new Error("An accepted run must not add an audit"); },
      recordReceipt: async () => { throw new Error("An accepted run must not replace its receipt"); },
    });
    expect(resumed).toMatchObject({ status: "passed", alreadyAccepted: true });
  });

  it("rejects account confirmation mismatch before creating temporary data", async () => {
    const { runLiveGoogleDriveEvidenceAcceptance } = await import(
      "../../server/liveGoogleDriveEvidenceAcceptance"
    );
    await expect(runLiveGoogleDriveEvidenceAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: "different@example.com",
      driveFileName: "Representative acceptance document.txt",
      runId: "test-live-google-drive-002",
    })).rejects.toThrow("confirmation does not match");
    expect(await app.db.select().from(app.schema.cases)).toHaveLength(0);
  });
});
