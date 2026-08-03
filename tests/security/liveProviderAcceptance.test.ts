import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV } from "../../server/_core/env";
import { encryptToken } from "../../server/emailOAuth";
import {
  collectLiveProviderAcceptance,
  type LiveProviderAcceptanceDependencies,
} from "../../server/liveProviderAcceptance";
import { buildCase, buildEvidence, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("live provider acceptance evidence", () => {
  let app: TestApp;
  const originalClientId = ENV.GOOGLE_CLIENT_ID;
  const originalClientSecret = ENV.GOOGLE_CLIENT_SECRET;

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(() => {
    ENV.GOOGLE_CLIENT_ID = originalClientId;
    ENV.GOOGLE_CLIENT_SECRET = originalClientSecret;
    app?.cleanup();
  });

  it("keeps checks pending when the target database has no acceptance evidence", async () => {
    const result = await collectLiveProviderAcceptance({
      listDriveFolders: async () => [],
      testGmail: async () => ({ ok: false, error: "not connected" }),
      verifyOutbound: async () => ({ ok: false, provider: "unconfigured" }),
    });

    expect(result.summary.status).toBe("pending");
    expect(result.summary.pendingChecks).toHaveLength(12);
    expect(result.providers.google.status).toBe("pending");
    expect(result.providers.outboundEmail.status).toBe("pending");
  });

  it("passes only from complete source-linked and delivery evidence without leaking private values", async () => {
    const userId = "USER_ACCEPTANCE";
    const caseId = "CASE_ACCEPTANCE";
    const outreachId = "OUTREACH_ACCEPTANCE";
    const now = new Date();
    ENV.GOOGLE_CLIENT_ID = "123-test.apps.googleusercontent.com";
    ENV.GOOGLE_CLIENT_SECRET = "test-google-client-secret";

    await app.db.insert(app.schema.users).values(buildUser({ id: userId }));
    await app.db.insert(app.schema.users).values(buildUser({ id: "USER_OTHER_ACCEPTANCE" }));
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId }));
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "EVIDENCE_ACCEPTANCE",
      caseId,
      userId,
      source: "google_drive",
    }));
    await app.db.insert(app.schema.emailAccounts).values({
      id: "GOOGLE_ACCEPTANCE",
      userId,
      provider: "gmail",
      email: "private-owner@example.com",
      accessToken: encryptToken("private-access-token"),
      refreshToken: encryptToken("private-refresh-token"),
      status: "connected",
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await app.db.insert(app.schema.emailAccounts).values({
      id: "GOOGLE_OTHER_ACCOUNT",
      userId: "USER_OTHER_ACCEPTANCE",
      provider: "gmail",
      email: "other-private-owner@example.com",
      accessToken: encryptToken("other-private-access-token"),
      refreshToken: encryptToken("other-private-refresh-token"),
      status: "connected",
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await app.db.insert(app.schema.outreachStatus).values({
      id: outreachId,
      caseId,
      status: "Interested",
      createdAt: now,
      updatedAt: now,
    });
    await app.db.insert(app.schema.systemConfig).values({
      configKey: `sent:${outreachId}`,
      configValue: "sent",
      updatedAt: now,
    });
    await app.db.insert(app.schema.auditLogs).values([
      {
        id: "AUDIT_PROVIDER_CONNECTED",
        userId,
        action: "provider.connected",
        entityType: "provider_connection",
        entityId: "GOOGLE_ACCEPTANCE",
        createdAt: now,
      },
      {
        id: "AUDIT_SOURCE_OPENED",
        userId,
        action: "evidence.source_opened",
        entityType: "evidence",
        entityId: "EVIDENCE_ACCEPTANCE",
        createdAt: now,
      },
      {
        id: "AUDIT_DISCONNECT",
        userId,
        action: "provider.disconnect_revoked",
        entityType: "provider_connection",
        entityId: "GOOGLE_ACCEPTANCE",
        createdAt: now,
      },
      {
        id: "AUDIT_SENT",
        userId,
        action: "outreach.status_changed",
        entityType: "outreach",
        entityId: outreachId,
        details: JSON.stringify({ from: "Approved", to: "Sent", provider: "smtp" }),
        createdAt: now,
      },
    ]);

    const providerDependencies: LiveProviderAcceptanceDependencies = {
      listDriveFolders: async () => [{ id: "folder" }] as any,
      testGmail: async () => ({ ok: true, email: "private-owner@example.com" }),
      verifyOutbound: async () => ({ ok: true, provider: "smtp" }),
    };
    const ambiguous = await collectLiveProviderAcceptance(providerDependencies);
    expect(ambiguous.providers.google.status).toBe("pending");

    const result = await collectLiveProviderAcceptance({
      ...providerDependencies,
      targetUserId: userId,
    });

    expect(result.summary).toEqual({ status: "passed", pendingChecks: [] });
    expect(result.providers.google.status).toBe("passed");
    expect(result.providers.outboundEmail.status).toBe("passed");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private-owner@example.com");
    expect(serialized).not.toContain("private-access-token");
    expect(serialized).not.toContain("private-refresh-token");

    await app.db.insert(app.schema.emailAccounts).values({
      id: "GOOGLE_ACCEPTANCE_SECOND",
      userId,
      provider: "gmail",
      email: "private-second@example.com",
      accessToken: encryptToken("private-second-access-token"),
      refreshToken: encryptToken("private-second-refresh-token"),
      status: "connected",
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const ambiguousOwner = await collectLiveProviderAcceptance({
      ...providerDependencies,
      targetUserId: userId,
    });
    expect(ambiguousOwner.providers.google.status).toBe("pending");

    const selectedAccount = await collectLiveProviderAcceptance({
      ...providerDependencies,
      targetUserId: userId,
      targetGoogleAccountId: "GOOGLE_ACCEPTANCE",
    });
    expect(selectedAccount.summary).toEqual({ status: "passed", pendingChecks: [] });
    expect(JSON.stringify(selectedAccount)).not.toContain("private-second@example.com");
  });

  it("does not accept a source-open audit for unrelated non-Google evidence", async () => {
    const userId = "USER_UNRELATED_SOURCE_OPEN";
    const caseId = "CASE_UNRELATED_SOURCE_OPEN";
    const now = new Date();
    await app.db.insert(app.schema.users).values(buildUser({ id: userId }));
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId }));
    await app.db.insert(app.schema.evidence).values([
      buildEvidence({ id: "GOOGLE_EVIDENCE_NOT_OPENED", caseId, userId, source: "gmail" }),
      buildEvidence({ id: "LOCAL_EVIDENCE_OPENED", caseId, userId, source: "manual_upload" }),
    ]);
    await app.db.insert(app.schema.emailAccounts).values({
      id: "GOOGLE_UNRELATED_SOURCE_OPEN",
      userId,
      provider: "gmail",
      email: "private-unrelated@example.com",
      accessToken: encryptToken("private-unrelated-access-token"),
      refreshToken: encryptToken("private-unrelated-refresh-token"),
      status: "connected",
      connectedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await app.db.insert(app.schema.auditLogs).values({
      id: "AUDIT_UNRELATED_SOURCE_OPEN",
      userId,
      action: "evidence.source_opened",
      entityType: "evidence",
      entityId: "LOCAL_EVIDENCE_OPENED",
      createdAt: now,
    });

    const result = await collectLiveProviderAcceptance({
      listDriveFolders: async () => [],
      testGmail: async () => ({ ok: true, email: "private-unrelated@example.com" }),
      verifyOutbound: async () => ({ ok: false, provider: "unconfigured" }),
      targetUserId: userId,
    });

    expect(result.providers.google.checks.evidencePersisted.passed).toBe(true);
    expect(result.providers.google.checks.sourceLinkOpened).toEqual({ passed: false, evidence: [] });
  });
});
