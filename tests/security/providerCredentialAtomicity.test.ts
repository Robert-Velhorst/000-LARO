import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";
import { encryptToken } from "../../server/emailOAuth";
import { saveEmailAccount } from "../../server/oauth2";

const suite = sqliteAvailable ? describe : describe.skip;

suite("provider credential audit atomicity", () => {
  let app: TestApp;
  const owner = { id: "PROVIDER_ATOMICITY_OWNER", role: "user", email: "provider-atomicity@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
  });

  beforeEach(async () => {
    await app.db.delete(app.schema.evidenceSources).where(eq(app.schema.evidenceSources.userId, owner.id));
    await app.db.delete(app.schema.emailAccounts).where(eq(app.schema.emailAccounts.userId, owner.id));
    await app.db.delete(app.schema.auditLogs).where(eq(app.schema.auditLogs.userId, owner.id));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => app?.cleanup());

  function rejectAuditAction(action: string, triggerName: string): () => void {
    const sqlite = app.db.$client;
    sqlite.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = '${action}'
      BEGIN
        SELECT RAISE(ABORT, 'injected provider audit failure');
      END;
    `);
    return () => sqlite.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  }

  function stubSuccessfulGoogleRevocation() {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  }

  it("rolls back a newly stored OAuth connection when its audit cannot be written", async () => {
    const releaseFailure = rejectAuditAction("provider.connected", "reject_provider_connect_audit");
    try {
      await expect(saveEmailAccount(owner.id, "gmail", {
        accessToken: "atomic-connect-access",
        refreshToken: "atomic-connect-refresh",
        expiresIn: 3_600,
        tokenType: "Bearer",
      }, {
        email: "atomic-connect@example.com",
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const rows = await app.db.select({ id: app.schema.emailAccounts.id })
      .from(app.schema.emailAccounts)
      .where(and(
        eq(app.schema.emailAccounts.userId, owner.id),
        eq(app.schema.emailAccounts.email, "atomic-connect@example.com"),
      ));
    expect(rows).toHaveLength(0);
  });

  it("rejects unusable provider credentials and normalizes account identity", async () => {
    await expect(saveEmailAccount(owner.id, "gmail", {
      accessToken: "",
      expiresIn: 3_600,
      tokenType: "Bearer",
    }, {
      email: "missing-token@example.com",
    })).rejects.toThrow("valid account credentials");
    await expect(saveEmailAccount(owner.id, "gmail", {
      accessToken: "valid-access",
      expiresIn: 3_600,
      tokenType: "Bearer",
    }, {
      email: "not-an-email",
    })).rejects.toThrow("valid account credentials");

    const accountId = await saveEmailAccount(owner.id, "gmail", {
      accessToken: "normalized-access",
      expiresIn: 3_600,
      tokenType: "Bearer",
    }, {
      email: "  Normalized.Account@Example.COM  ",
    });
    const [stored] = await app.db.select({ email: app.schema.emailAccounts.email })
      .from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, accountId));
    expect(stored.email).toBe("normalized.account@example.com");
  });

  it("reuses and normalizes a legacy mixed-case provider account", async () => {
    await app.db.insert(app.schema.emailAccounts).values({
      id: "LEGACY_MIXED_CASE_ACCOUNT",
      userId: owner.id,
      provider: "gmail",
      email: "Legacy.Account@Example.COM",
      accessToken: encryptToken("legacy-access"),
      status: "connected",
    } as any);

    const accountId = await saveEmailAccount(owner.id, "gmail", {
      accessToken: "replacement-access",
      expiresIn: 3_600,
      tokenType: "Bearer",
    }, {
      email: "legacy.account@example.com",
    });

    const rows = await app.db.select({
      id: app.schema.emailAccounts.id,
      email: app.schema.emailAccounts.email,
    }).from(app.schema.emailAccounts).where(eq(app.schema.emailAccounts.userId, owner.id));
    expect(accountId).toBe("LEGACY_MIXED_CASE_ACCOUNT");
    expect(rows).toEqual([{
      id: "LEGACY_MIXED_CASE_ACCOUNT",
      email: "legacy.account@example.com",
    }]);
  });

  it("converges simultaneous provider reconnects on one account row", async () => {
    const connect = (accessToken: string) => saveEmailAccount(owner.id, "gmail", {
      accessToken,
      expiresIn: 3_600,
      tokenType: "Bearer",
    }, {
      email: "concurrent.account@example.com",
    });

    const accountIds = await Promise.all([
      connect("concurrent-access-one"),
      connect("concurrent-access-two"),
    ]);
    const rows = await app.db.select({ id: app.schema.emailAccounts.id })
      .from(app.schema.emailAccounts)
      .where(and(
        eq(app.schema.emailAccounts.userId, owner.id),
        eq(app.schema.emailAccounts.email, "concurrent.account@example.com"),
      ));
    expect(new Set(accountIds).size).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it("rolls back shared Google credential and source deletion when its audit cannot be written", async () => {
    stubSuccessfulGoogleRevocation();
    await app.db.insert(app.schema.emailAccounts).values({
      id: "PROVIDER_ATOMIC_ENHANCED",
      userId: owner.id,
      provider: "gmail",
      email: "atomic-enhanced@example.com",
      accessToken: encryptToken("atomic-enhanced-access"),
      refreshToken: encryptToken("atomic-enhanced-refresh"),
      status: "connected",
    } as any);
    await app.db.insert(app.schema.evidenceSources).values({
      id: "PROVIDER_ATOMIC_SOURCE",
      userId: owner.id,
      sourceType: "Gmail",
      status: "connected",
    } as any);

    const releaseFailure = rejectAuditAction("provider.disconnect_revoked", "reject_enhanced_disconnect_audit");
    try {
      await expect(app.makeCaller(owner).gmailEnhanced.disconnect()).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const accounts = await app.db.select({ id: app.schema.emailAccounts.id })
      .from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, "PROVIDER_ATOMIC_ENHANCED"));
    const sources = await app.db.select({ id: app.schema.evidenceSources.id })
      .from(app.schema.evidenceSources)
      .where(eq(app.schema.evidenceSources.id, "PROVIDER_ATOMIC_SOURCE"));
    expect(accounts).toHaveLength(1);
    expect(sources).toHaveLength(1);
  });

  it("rolls back direct account deletion when its audit cannot be written", async () => {
    stubSuccessfulGoogleRevocation();
    await app.db.insert(app.schema.emailAccounts).values({
      id: "PROVIDER_ATOMIC_DIRECT",
      userId: owner.id,
      provider: "gmail",
      email: "atomic-direct@example.com",
      accessToken: encryptToken("atomic-direct-access"),
      refreshToken: encryptToken("atomic-direct-refresh"),
      status: "connected",
    } as any);

    const releaseFailure = rejectAuditAction("provider.disconnect_revoked", "reject_direct_disconnect_audit");
    try {
      await expect(app.makeCaller(owner).emailAccounts.revoke({
        accountId: "PROVIDER_ATOMIC_DIRECT",
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const accounts = await app.db.select({ id: app.schema.emailAccounts.id })
      .from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, "PROVIDER_ATOMIC_DIRECT"));
    expect(accounts).toHaveLength(1);
  });

  it("rolls back Drive disconnect credential deletion when its audit cannot be written", async () => {
    stubSuccessfulGoogleRevocation();
    await app.db.insert(app.schema.emailAccounts).values({
      id: "PROVIDER_ATOMIC_DRIVE",
      userId: owner.id,
      provider: "gmail",
      email: "atomic-drive@example.com",
      accessToken: encryptToken("atomic-drive-access"),
      refreshToken: encryptToken("atomic-drive-refresh"),
      status: "connected",
    } as any);

    const releaseFailure = rejectAuditAction("provider.disconnect_revoked", "reject_drive_disconnect_audit");
    try {
      await expect(app.makeCaller(owner).googleDrive.disconnect({})).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const accounts = await app.db.select({ id: app.schema.emailAccounts.id })
      .from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, "PROVIDER_ATOMIC_DRIVE"));
    expect(accounts).toHaveLength(1);
  });
});
