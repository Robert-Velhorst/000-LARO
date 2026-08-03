import { createHash } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV } from "../../server/_core/env";
import { encryptToken } from "../../server/emailOAuth";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("live Google evidence acceptance", () => {
  let app: TestApp;
  const userId = "USER_LIVE_GOOGLE_EVIDENCE";
  const accountId = "GOOGLE_LIVE_EVIDENCE";
  const recipient = "owner-google-acceptance@example.com";
  const outboundRunId = "test-live-outbound-google-001";
  const googleRunId = "test-live-google-evidence-001";
  const originalClientId = ENV.GOOGLE_CLIENT_ID;
  const originalClientSecret = ENV.GOOGLE_CLIENT_SECRET;
  const originalBaseUrl = process.env.OAUTH_REDIRECT_BASE_URL;

  beforeAll(async () => {
    process.env.OAUTH_REDIRECT_BASE_URL = "https://api.example.test/laro";
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
    const { recordOutboundAcceptanceReceipt } = await import("../../server/providerAcceptanceEvidence");
    await recordOutboundAcceptanceReceipt({
      userId,
      runId: outboundRunId,
      provider: "smtp",
      recipient,
    });
  });

  afterAll(() => {
    ENV.GOOGLE_CLIENT_ID = originalClientId;
    ENV.GOOGLE_CLIENT_SECRET = originalClientSecret;
    if (originalBaseUrl === undefined) delete process.env.OAUTH_REDIRECT_BASE_URL;
    else process.env.OAUTH_REDIRECT_BASE_URL = originalBaseUrl;
    app?.cleanup();
  });

  it("persists, analyzes, opens, receipts, cleans, and safely resumes one Gmail source", async () => {
    const { runLiveGoogleEvidenceAcceptance } = await import("../../server/liveGoogleEvidenceAcceptance");
    const {
      readGoogleEvidenceAcceptanceReceipt,
      recordGoogleEvidenceAcceptanceReceipt,
    } = await import("../../server/providerAcceptanceEvidence");
    const { getEvidenceDownloadUrl, readSignedEvidenceDownload, recordEvidenceSourceOpened } =
      await import("../../server/evidenceAccess");
    const { createEvidenceFile } = await import("../../server/evidence");
    const { analyzeStoredEvidence } = await import("../../server/documentAnalysisService");
    const { storagePut, storageRead } = await import("../../server/storage");
    let sourceStorageKey = "";

    const result = await runLiveGoogleEvidenceAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: recipient,
      outboundRunId,
      runId: googleRunId,
    }, {
      pullEvidence: async (params) => {
        expect(params.gmailAccountIds).toEqual([accountId]);
        expect(params.includeDrive).toBe(false);
        expect(params.includeLocal).toBe(false);
        const subject = params.keywords[0];
        const body = Buffer.from(
          `From: ${recipient}\nTo: ${recipient}\nSubject: ${subject}\nDate: 2026-08-03\n\nAuthorized source analysis proof.`,
        );
        const stored = await storagePut(
          `evidence/${params.caseId}/gmail/test-message.eml`,
          body,
          "message/rfc822",
        );
        sourceStorageKey = stored.key;
        await createEvidenceFile(userId, {
          caseId: params.caseId,
          type: "email",
          source: "gmail",
          title: subject,
          description: "Controlled Gmail acceptance source",
          fileUrl: stored.url,
          fileName: "test-message.eml",
          fileSize: String(body.length),
          mimeType: "message/rfc822",
          metadata: JSON.stringify({
            storageKey: stored.key,
            gmailMessageId: "gmail-message-acceptance-001",
            gmailThreadId: "gmail-thread-acceptance-001",
            accountId,
            subject,
            autoCollected: true,
          }),
          contentHash: stored.sha256,
          relevant: true,
        });
        await app.db.insert(app.schema.autoCollectionLogs).values({
          id: "GOOGLE_ACCEPTANCE_PULL_LOG",
          caseId: params.caseId,
          userId,
          status: "completed",
          emailsFound: "1",
          emailsProcessed: "1",
          errorCount: "0",
          createdAt: new Date(),
        });
        return {
          gmailMessages: 1,
          gmailAttachments: 0,
          driveFiles: 0,
          localFiles: 0,
          errors: [`Analysis for "${subject}" failed: transient test failure`],
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
      recordReceipt: recordGoogleEvidenceAcceptanceReceipt,
    });

    expect(result).toMatchObject({
      status: "passed",
      alreadyAccepted: false,
      source: "gmail",
      persistedEvidenceCount: 1,
      sourceContentRead: true,
      contentHashMatched: true,
      analysisCompleted: true,
      sourceOpenedAuditRecorded: true,
      transientBusinessRowsRemoved: true,
    });
    expect(await app.db.select().from(app.schema.cases)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.evidence)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.documentAnalyses)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.autoCollectionLogs)).toHaveLength(0);
    await expect(storageRead(sourceStorageKey)).rejects.toThrow("not found");

    const receipt = await readGoogleEvidenceAcceptanceReceipt(userId);
    expect(receipt).toMatchObject({
      provider: "google",
      source: "gmail",
      evidencePersisted: true,
      sourceContentRead: true,
      contentHashMatched: true,
      analysisCompleted: true,
      sourceOpenedAudit: true,
    });
    expect(JSON.stringify(receipt)).not.toContain(recipient);
    expect(JSON.stringify(receipt)).not.toContain("gmail-message-acceptance-001");

    const { collectLiveProviderAcceptance } = await import("../../server/liveProviderAcceptance");
    const probe = await collectLiveProviderAcceptance({
      listDriveFolders: async () => [{ id: "folder" }],
      testGmail: async () => ({ ok: true, email: recipient }),
      verifyOutbound: async () => ({ ok: true, provider: "smtp" }),
      targetUserId: userId,
      targetGoogleAccountId: accountId,
    });
    expect(probe.providers.google.checks.evidencePersisted.passed).toBe(true);
    expect(probe.providers.google.checks.sourceLinkOpened.passed).toBe(true);
    expect(probe.providers.google.checks.disconnectRevoked.passed).toBe(false);
    expect(probe.providers.outboundEmail.status).toBe("passed");
    expect(JSON.stringify(probe)).not.toContain(recipient);

    const suffix = createHash("sha256").update(`${userId}\n${googleRunId}`).digest("hex").slice(0, 24);
    const interruptedCaseId = `ACCEPTANCE_GOOGLE_CASE_${suffix}`;
    await app.db.insert(app.schema.cases).values(buildCase({
      id: interruptedCaseId,
      userId,
      metadata: JSON.stringify({ kind: "provider_acceptance", runId: googleRunId }),
    }));
    const leftover = await storagePut(
      `evidence/${interruptedCaseId}/gmail/leftover.eml`,
      Buffer.from("leftover"),
      "message/rfc822",
    );
    await createEvidenceFile(userId, {
      caseId: interruptedCaseId,
      type: "email",
      source: "gmail",
      title: "leftover",
      metadata: JSON.stringify({ storageKey: leftover.key }),
      contentHash: leftover.sha256,
    });

    const resumed = await runLiveGoogleEvidenceAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: recipient,
      outboundRunId,
      runId: googleRunId,
    }, {
      pullEvidence: async () => { throw new Error("An accepted run must not pull Gmail again"); },
      getDownloadUrl: async () => { throw new Error("An accepted run must not issue a new URL"); },
      fetchSource: async () => { throw new Error("An accepted run must not fetch again"); },
      analyzeEvidence: async () => { throw new Error("An accepted run must not analyze again"); },
      recordSourceOpened: async () => { throw new Error("An accepted run must not add an audit"); },
      recordReceipt: async () => { throw new Error("An accepted run must not replace its receipt"); },
    });
    expect(resumed).toMatchObject({ status: "passed", alreadyAccepted: true });
    expect(await app.db.select().from(app.schema.cases)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.evidence)).toHaveLength(0);
    await expect(storageRead(leftover.key)).rejects.toThrow("not found");

    const { eq } = await import("drizzle-orm");
    const [receiptRow] = await app.db.select().from(app.schema.systemConfig)
      .where(eq(app.schema.systemConfig.configKey, `acceptance:google-evidence:${userId}`));
    const tampered = JSON.parse(receiptRow.configValue);
    tampered.analysisCompleted = false;
    await app.db.update(app.schema.systemConfig)
      .set({ configValue: JSON.stringify(tampered) })
      .where(eq(app.schema.systemConfig.configKey, receiptRow.configKey));
    expect(await readGoogleEvidenceAcceptanceReceipt(userId)).toBeNull();
  });

  it("rejects account confirmation mismatch before creating temporary data", async () => {
    const { runLiveGoogleEvidenceAcceptance } = await import("../../server/liveGoogleEvidenceAcceptance");
    await expect(runLiveGoogleEvidenceAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: "different@example.com",
      outboundRunId,
      runId: "test-live-google-evidence-002",
    })).rejects.toThrow("confirmation does not match");
    expect(await app.db.select().from(app.schema.cases)).toHaveLength(0);
  });
});
