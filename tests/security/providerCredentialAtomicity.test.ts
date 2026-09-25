import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { verifiedErasureInput } from "../helpers/erasure";
import { buildUser } from "../factories";
import { decryptToken, encryptToken } from "../../server/emailOAuth";
import {
  getProviderAccessToken,
  storeProviderConnection,
} from "../../server/providerConnections";

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

  async function reviewedDisconnectInput(
    accountId: string,
    initiatedFrom: "shared_google_grant" | "gmail" | "google_drive",
  ) {
    const impact = await app.makeCaller(owner).providerConnections.disconnectImpact({ accountId });
    return {
      accountId,
      impactRevision: impact.impactRevision,
      acknowledgeSharedGoogleGrant: true as const,
      initiatedFrom,
    };
  }

  it("rolls back a newly stored OAuth connection when its audit cannot be written", async () => {
    const releaseFailure = rejectAuditAction("provider.connected", "reject_provider_connect_audit");
    try {
      await expect(storeProviderConnection(owner.id, "gmail", {
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

  it("reports an uncertain provider refresh and rolls back local tokens when its audit fails", async () => {
    await app.db.insert(app.schema.emailAccounts).values({
      id: "PROVIDER_ATOMIC_REFRESH",
      userId: owner.id,
      provider: "gmail",
      email: "atomic-refresh@example.com",
      accessToken: encryptToken("old-access"),
      refreshToken: encryptToken("old-refresh"),
      status: "connected",
    } as any);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600,
      token_type: "Bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const alert = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const releaseFailure = rejectAuditAction("provider.credentials_refreshed", "reject_provider_refresh_audit");
    try {
      await expect(getProviderAccessToken({
        userId: owner.id,
        accountId: "PROVIDER_ATOMIC_REFRESH",
        forceRefresh: true,
      })).rejects.toThrow("may have rotated");
    } finally {
      releaseFailure();
    }
    expect(alert).toHaveBeenCalledWith(
      "[Provider][REFRESH_UNCERTAIN] Credential refresh was not durably saved",
      expect.objectContaining({ accountId: "PROVIDER_ATOMIC_REFRESH" }),
    );
    const [stored] = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, "PROVIDER_ATOMIC_REFRESH"));
    expect(decryptToken(stored.accessToken)).toBe("old-access");
    expect(decryptToken(stored.refreshToken)).toBe("old-refresh");
    expect(await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, "provider.credentials_refreshed"))).toHaveLength(0);

    await expect(getProviderAccessToken({
      userId: owner.id,
      accountId: "PROVIDER_ATOMIC_REFRESH",
      forceRefresh: true,
    })).resolves.toBe("new-access");
    const rows = await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, "provider.credentials_refreshed"));
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toContain('"refreshGrantRotated":true');
    expect(rows[0].details).not.toMatch(/new-access|new-refresh|old-refresh/);
  });

  it("single-flights concurrent refreshes and atomically persists a rotated grant", async () => {
    await app.db.insert(app.schema.emailAccounts).values({
      id: "PROVIDER_CONCURRENT_REFRESH",
      userId: owner.id,
      provider: "gmail",
      email: "concurrent-refresh@example.com",
      accessToken: encryptToken("expired-access"),
      refreshToken: encryptToken("refresh-before-rotation"),
      tokenExpiry: new Date(Date.now() - 1_000),
      status: "connected",
    } as any);
    const providerFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "shared-refreshed-access",
      refresh_token: "refresh-after-rotation",
      expires_in: 7_200,
      token_type: "Bearer",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", providerFetch);

    const input = {
      userId: owner.id,
      accountId: "PROVIDER_CONCURRENT_REFRESH",
      forceRefresh: true,
    };
    await expect(Promise.all([
      getProviderAccessToken(input),
      getProviderAccessToken(input),
    ])).resolves.toEqual(["shared-refreshed-access", "shared-refreshed-access"]);
    expect(providerFetch).toHaveBeenCalledTimes(1);

    const [stored] = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, "PROVIDER_CONCURRENT_REFRESH"));
    expect(decryptToken(stored.accessToken)).toBe("shared-refreshed-access");
    expect(decryptToken(stored.refreshToken)).toBe("refresh-after-rotation");
    expect(stored.tokenExpiry.getTime()).toBeGreaterThan(Date.now() + 7_100_000);
    const audits = await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, "provider.credentials_refreshed"));
    expect(audits).toHaveLength(1);
  });

  it("marks invalid grants for reconnect and removes unusable local credentials", async () => {
    await app.db.insert(app.schema.emailAccounts).values({
      id: "PROVIDER_INVALID_GRANT",
      userId: owner.id,
      provider: "gmail",
      email: "invalid-grant@example.com",
      accessToken: encryptToken("invalid-access"),
      refreshToken: encryptToken("invalid-refresh"),
      tokenExpiry: new Date(Date.now() - 1_000),
      status: "connected",
    } as any);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "grant revoked",
    }), { status: 400, headers: { "Content-Type": "application/json" } })));

    await expect(getProviderAccessToken({
      userId: owner.id,
      accountId: "PROVIDER_INVALID_GRANT",
    })).rejects.toMatchObject({ code: "reconnect_required" });

    const [stored] = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, "PROVIDER_INVALID_GRANT"));
    expect(stored).toMatchObject({
      status: "reconnect_required",
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
    });
    const [audit] = await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, "provider.credentials_invalidated"));
    expect(JSON.parse(audit.details)).toMatchObject({ provider: "google", reason: "invalid_grant" });
  });

  it("preserves the connected grant after a retryable provider failure", async () => {
    await app.db.insert(app.schema.emailAccounts).values({
      id: "PROVIDER_RETRYABLE_REFRESH",
      userId: owner.id,
      provider: "gmail",
      email: "retryable-refresh@example.com",
      accessToken: encryptToken("retryable-old-access"),
      refreshToken: encryptToken("retryable-old-refresh"),
      tokenExpiry: new Date(Date.now() - 1_000),
      status: "connected",
    } as any);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "temporarily_unavailable",
    }), { status: 503, headers: { "Content-Type": "application/json" } })));

    await expect(getProviderAccessToken({
      userId: owner.id,
      accountId: "PROVIDER_RETRYABLE_REFRESH",
    })).rejects.toMatchObject({ code: "transient_provider_failure" });

    const [stored] = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, "PROVIDER_RETRYABLE_REFRESH"));
    expect(stored.status).toBe("connected");
    expect(decryptToken(stored.accessToken)).toBe("retryable-old-access");
    expect(decryptToken(stored.refreshToken)).toBe("retryable-old-refresh");
  });

  it("rejects unusable provider credentials and normalizes account identity", async () => {
    await expect(storeProviderConnection(owner.id, "gmail", {
      accessToken: "",
      expiresIn: 3_600,
      tokenType: "Bearer",
    }, {
      email: "missing-token@example.com",
    })).rejects.toThrow("valid account credentials");
    await expect(storeProviderConnection(owner.id, "gmail", {
      accessToken: "valid-access",
      expiresIn: 3_600,
      tokenType: "Bearer",
    }, {
      email: "not-an-email",
    })).rejects.toThrow("valid account credentials");

    const accountId = await storeProviderConnection(owner.id, "gmail", {
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

    const accountId = await storeProviderConnection(owner.id, "gmail", {
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
    const connect = (accessToken: string) => storeProviderConnection(owner.id, "gmail", {
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
      await expect(app.makeCaller(owner).providerConnections.disconnect(
        await reviewedDisconnectInput("PROVIDER_ATOMIC_ENHANCED", "shared_google_grant"),
      )).rejects.toThrow();
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
      await expect(app.makeCaller(owner).providerConnections.disconnect(
        await reviewedDisconnectInput("PROVIDER_ATOMIC_DIRECT", "gmail"),
      )).rejects.toThrow();
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
      await expect(app.makeCaller(owner).providerConnections.disconnect(
        await reviewedDisconnectInput("PROVIDER_ATOMIC_DRIVE", "google_drive"),
      )).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const accounts = await app.db.select({ id: app.schema.emailAccounts.id })
      .from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, "PROVIDER_ATOMIC_DRIVE"));
    expect(accounts).toHaveLength(1);
  });

  it("uses the same provider revocation contract before GDPR erases credentials", async () => {
    const erasable = {
      id: "PROVIDER_ERASURE_OWNER",
      role: "user",
      email: "provider-erasure@example.com",
    };
    await app.db.insert(app.schema.users).values(buildUser(erasable));
    await app.db.insert(app.schema.emailAccounts).values({
      id: "PROVIDER_ERASURE_ACCOUNT",
      userId: erasable.id,
      provider: "gmail",
      email: erasable.email,
      accessToken: encryptToken("erasure-access"),
      refreshToken: encryptToken("erasure-refresh"),
      status: "connected",
    } as any);
    const revoke = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", revoke);

    const caller = app.makeCaller(erasable);
    const result = await caller.gdpr.deleteData(await verifiedErasureInput(app, caller, erasable.id));

    expect(result.providerRevocation).toEqual({
      attempted: 1,
      revoked: 1,
      alreadyInvalid: 0,
      notApplicable: 0,
      failed: 0,
    });
    expect(revoke).toHaveBeenCalledOnce();
    expect((revoke.mock.calls[0][1]?.body as URLSearchParams).get("token")).toBe("erasure-refresh");
    expect(await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.userId, erasable.id))).toHaveLength(0);
    expect(await app.db.select().from(app.schema.users)
      .where(eq(app.schema.users.id, erasable.id))).toHaveLength(0);
  });
});
