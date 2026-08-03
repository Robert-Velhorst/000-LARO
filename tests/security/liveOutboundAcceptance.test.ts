import { createHash } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV } from "../../server/_core/env";
import { encryptToken } from "../../server/emailOAuth";
import { buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("live outbound acceptance", () => {
  let app: TestApp;
  const userId = "USER_LIVE_OUTBOUND_ACCEPTANCE";
  const accountId = "GOOGLE_LIVE_OUTBOUND_ACCEPTANCE";
  const recipient = "owner-acceptance@example.com";
  const originalClientId = ENV.GOOGLE_CLIENT_ID;
  const originalClientSecret = ENV.GOOGLE_CLIENT_SECRET;

  beforeAll(async () => {
    delete process.env.FEATURE_OUTREACH_SEND_ENABLED;
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
    delete process.env.FEATURE_OUTREACH_SEND_ENABLED;
    app?.cleanup();
  });

  it("proves one delivery, blocks the duplicate, cleans transient rows, and rejects receipt tampering", async () => {
    const deliveries: Array<{ to: string; subject: string }> = [];
    const { sendApprovedOutreach } = await import("../../server/outreachSend");
    const { runLiveOutboundAcceptance } = await import("../../server/liveOutboundAcceptance");
    const { readOutboundAcceptanceReceipt } = await import("../../server/providerAcceptanceEvidence");

    await app.db.insert(app.schema.systemConfig).values({
      configKey: "flag:outreach.send.enabled",
      configValue: "false",
      updatedAt: new Date(),
    });

    const result = await runLiveOutboundAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: recipient,
      runId: "test-live-outbound-001",
    }, {
      sendApproved: (ownerId, outreachId, message) => sendApprovedOutreach(ownerId, outreachId, async (email) => {
        deliveries.push({ to: email.to, subject: email.subject });
        return { delivered: true, provider: "smtp", providerMessageId: "provider-message-test" };
      }, message),
      getFreshAccessToken: async () => "fresh-access-token",
      countInboxMessages: async () => deliveries.length,
      verifyOutbound: async () => ({ ok: true, provider: "smtp" }),
      recordReceipt: (await import("../../server/providerAcceptanceEvidence")).recordOutboundAcceptanceReceipt,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      status: "passed",
      alreadyAccepted: false,
      provider: "smtp",
      providerMessageId: "provider-message-test",
      inboxMessageCount: 1,
      duplicateBlocked: true,
      transientBusinessRowsRemoved: true,
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].to).toBe(recipient);
    expect(deliveries[0].subject).toMatch(/^LARO production delivery acceptance /);

    expect(await app.db.select().from(app.schema.cases)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.lawyers)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.outreachStatus)).toHaveLength(0);
    const configRows = await app.db.select().from(app.schema.systemConfig);
    expect(configRows.some((row: any) => row.configKey.startsWith("sent:"))).toBe(false);
    expect(configRows.find((row: any) => row.configKey === "flag:outreach.send.enabled")?.configValue).toBe("false");

    const receipt = await readOutboundAcceptanceReceipt(userId);
    expect(receipt).toMatchObject({
      provider: "smtp",
      messageCount: 1,
      sentAuditCount: 1,
      duplicateBlocked: true,
    });
    expect(JSON.stringify(receipt)).not.toContain(recipient);
    const acceptanceAudits = (await app.db.select().from(app.schema.auditLogs))
      .filter((row: any) => row.action === "provider.acceptance_recorded");
    expect(acceptanceAudits).toHaveLength(1);
    expect(acceptanceAudits[0].details).not.toContain(recipient);

    const { collectLiveProviderAcceptance } = await import("../../server/liveProviderAcceptance");
    const probe = await collectLiveProviderAcceptance({
      listDriveFolders: async () => [],
      testGmail: async () => ({ ok: true, email: recipient }),
      verifyOutbound: async () => ({ ok: true, provider: "smtp" }),
      targetUserId: userId,
      targetGoogleAccountId: accountId,
    });
    expect(probe.providers.outboundEmail.status).toBe("passed");
    expect(JSON.stringify(probe)).not.toContain(recipient);

    const suffix = createHash("sha256")
      .update(`${userId}\n${accountId}\ntest-live-outbound-001`)
      .digest("hex")
      .slice(0, 24);
    const interruptedIds = {
      caseId: `ACCEPTANCE_CASE_${suffix}`,
      lawyerId: `ACCEPTANCE_RECIPIENT_${suffix}`,
      outreachId: `ACCEPTANCE_OUTREACH_${suffix}`,
    };
    await app.db.insert(app.schema.cases).values({
      id: interruptedIds.caseId,
      userId,
      metadata: JSON.stringify({ kind: "provider_acceptance", runId: "test-live-outbound-001" }),
    });
    await app.db.insert(app.schema.lawyers).values({
      id: interruptedIds.lawyerId,
      email: recipient,
      directorySource: "provider_acceptance",
    });
    await app.db.insert(app.schema.outreachStatus).values({
      id: interruptedIds.outreachId,
      caseId: interruptedIds.caseId,
      lawyerId: interruptedIds.lawyerId,
      status: "Sent",
    });
    await app.db.insert(app.schema.systemConfig).values({
      configKey: `sent:${interruptedIds.outreachId}`,
      configValue: "sent",
      updatedAt: new Date(),
    });

    const resumed = await runLiveOutboundAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: recipient,
      runId: "test-live-outbound-001",
    }, {
      sendApproved: async () => {
        throw new Error("An accepted run must never send again");
      },
      getFreshAccessToken: async () => {
        throw new Error("An accepted run must not refresh Google");
      },
      countInboxMessages: async () => {
        throw new Error("An accepted run must not poll Gmail");
      },
      verifyOutbound: async () => ({ ok: true, provider: "smtp" }),
      recordReceipt: async () => {
        throw new Error("An accepted run must not replace its receipt");
      },
      sleep: async () => undefined,
    });
    expect(resumed).toMatchObject({ status: "passed", alreadyAccepted: true });
    expect(deliveries).toHaveLength(1);
    expect(await app.db.select().from(app.schema.cases)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.lawyers)).toHaveLength(0);
    expect(await app.db.select().from(app.schema.outreachStatus)).toHaveLength(0);
    expect((await app.db.select().from(app.schema.systemConfig))
      .some((row: any) => row.configKey === `sent:${interruptedIds.outreachId}`)).toBe(false);

    const { eq } = await import("drizzle-orm");
    const receiptRow = configRows.find((row: any) => row.configKey.startsWith("acceptance:outbound-email:"));
    const tampered = JSON.parse(receiptRow.configValue);
    tampered.messageCount = 2;
    await app.db.update(app.schema.systemConfig)
      .set({ configValue: JSON.stringify(tampered) })
      .where(eq(app.schema.systemConfig.configKey, receiptRow.configKey));
    expect(await readOutboundAcceptanceReceipt(userId)).toBeNull();
    const tamperedProbe = await collectLiveProviderAcceptance({
      listDriveFolders: async () => [],
      testGmail: async () => ({ ok: true, email: recipient }),
      verifyOutbound: async () => ({ ok: true, provider: "smtp" }),
      targetUserId: userId,
      targetGoogleAccountId: accountId,
    });
    expect(tamperedProbe.providers.outboundEmail.status).toBe("pending");
  });

  it("rejects recipient mismatch before creating acceptance data", async () => {
    const { runLiveOutboundAcceptance } = await import("../../server/liveOutboundAcceptance");
    await expect(runLiveOutboundAcceptance({
      userId,
      googleAccountId: accountId,
      recipient,
      confirmedRecipient: "different@example.com",
      runId: "test-live-outbound-002",
    })).rejects.toThrow("confirmation does not match");
  });
});
