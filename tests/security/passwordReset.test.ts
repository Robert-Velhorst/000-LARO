import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AUDIT_ACTIONS } from "../../server/audit";
import { hashPasswordResetCode } from "../../server/passwordResetSecurity";
import { PASSWORD_RESET_LOCK_MS, PASSWORD_RESET_MAX_FAILURES } from "../../server/passwordResetSecurity";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";
import { createContext } from "../../server/context";
import { ENV } from "../../server/_core/env";
import { SESSION_COOKIE_NAME } from "../../server/sessionCookie";
import { revokeUserSessions } from "../../server/sessionRevocation";

const suite = sqliteAvailable ? describe : describe.skip;

suite("password reset security", () => {
  let app: TestApp;
  const userId = "USER_PASSWORD_RESET";
  const email = "password-reset@example.com";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: userId, email }));
  });

  afterAll(() => app?.cleanup());

  it("stores reset codes with a secret-keyed digest", () => {
    const code = "123456";
    expect(hashPasswordResetCode(code)).toHaveLength(64);
    expect(hashPasswordResetCode(code)).not.toBe(
      crypto.createHash("sha256").update(code).digest("hex"),
    );
  });

  it("invalidates sessions and audits a successful password reset", async () => {
    const code = "654321";
    await app.db
      .update(app.schema.users)
      .set({
        resetCodeHash: hashPasswordResetCode(code),
        resetCodeExpiresAt: String(Date.now() + 60_000),
      })
      .where(eq(app.schema.users.id, userId));

    await expect(app.makeCaller(null).auth.resetPassword({
      email,
      code,
      newPassword: "replacement-password-123",
    })).resolves.toEqual({ success: true });

    const [user] = await app.db
      .select()
      .from(app.schema.users)
      .where(eq(app.schema.users.id, userId));
    expect(await bcrypt.compare("replacement-password-123", user.password)).toBe(true);
    expect(user.resetCodeHash).toBeNull();
    expect(user.resetCodeExpiresAt).toBeNull();

    const [revocation] = await app.db
      .select()
      .from(app.schema.systemConfig)
      .where(eq(app.schema.systemConfig.configKey, `session:revokedAfter:${userId}`));
    expect(Number(revocation.configValue)).toBeGreaterThan(0);

    const auditRows = await app.db
      .select()
      .from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, AUDIT_ACTIONS.USER_PASSWORD_RESET));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ userId, entityId: userId });
  });

  it("rejects a revoked session cookie at the live request-context boundary", async () => {
    const token = jwt.sign({ userId }, ENV.JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: "15m",
    });
    await revokeUserSessions(userId, new Date());

    const req = {
      cookies: { [SESSION_COOKIE_NAME]: token },
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
      get: () => undefined,
    } as any;
    const context = await createContext({ req, res: {} as any });

    expect(context.user).toBeNull();
    expect(context.authScope).toBeUndefined();
  });

  it("enforces one failure budget for the account across rotating client addresses", async () => {
    const correctCode = "314159";
    await app.db.update(app.schema.users).set({
      resetCodeHash: hashPasswordResetCode(correctCode),
      resetCodeExpiresAt: String(Date.now() + 60_000),
      resetCodeFailures: 0,
      resetCodeLockedUntil: null,
    }).where(eq(app.schema.users.id, userId));

    for (let attempt = 0; attempt < PASSWORD_RESET_MAX_FAILURES; attempt += 1) {
      const caller = app.makeCaller(null, "session", false, {
        remoteAddress: `198.51.100.${attempt + 10}`,
      });
      await expect(caller.auth.resetPassword({
        email: attempt % 2 === 0 ? " PASSWORD-RESET@EXAMPLE.COM " : email,
        code: String(attempt).padStart(6, "0"),
        newPassword: "guessed-password-123",
      })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Invalid or expired reset code" });
    }

    const [exhausted] = await app.db.select().from(app.schema.users)
      .where(eq(app.schema.users.id, userId));
    expect(exhausted.resetCodeFailures).toBe(PASSWORD_RESET_MAX_FAILURES);
    expect(exhausted.resetCodeHash).toBeNull();
    expect(exhausted.resetCodeExpiresAt).toBeNull();
    expect(exhausted.resetCodeLockedUntil!.getTime()).toBeGreaterThan(Date.now());

    await expect(app.makeCaller(null, "session", false, {
      remoteAddress: "203.0.113.99",
    }).auth.resetPassword({
      email,
      code: correctCode,
      newPassword: "should-not-be-used-123",
    })).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Invalid or expired reset code" });

    // Enumeration-safe request succeeds publicly but cannot replace a locked
    // account challenge until the account-level cooldown has elapsed.
    await expect(app.makeCaller(null, "session", false, {
      remoteAddress: "203.0.113.100",
    }).auth.requestPasswordReset({ email: " PASSWORD-RESET@EXAMPLE.COM " }))
      .resolves.toEqual({ success: true });
    const [stillLocked] = await app.db.select().from(app.schema.users)
      .where(eq(app.schema.users.id, userId));
    expect(stillLocked.resetCodeHash).toBeNull();
    expect(stillLocked.resetCodeLockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(stillLocked.resetCodeLockedUntil!.getTime()).toBeLessThanOrEqual(Date.now() + PASSWORD_RESET_LOCK_MS);
  });

  it("rejects expired and reused challenges with the same public message", async () => {
    const code = "271828";
    await app.db.update(app.schema.users).set({
      resetCodeHash: hashPasswordResetCode(code),
      resetCodeExpiresAt: String(Date.now() - 1),
      resetCodeFailures: 0,
      resetCodeLockedUntil: null,
    }).where(eq(app.schema.users.id, userId));
    await expect(app.makeCaller(null, "session", false, {
      remoteAddress: "192.0.2.20",
    }).auth.resetPassword({ email, code, newPassword: "expired-password-123" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: "Invalid or expired reset code" });

    await app.db.update(app.schema.users).set({
      resetCodeHash: hashPasswordResetCode(code),
      resetCodeExpiresAt: String(Date.now() + 60_000),
      resetCodeFailures: 0,
      resetCodeLockedUntil: null,
    }).where(eq(app.schema.users.id, userId));
    const reset = (remoteAddress: string) => app.makeCaller(null, "session", false, { remoteAddress })
      .auth.resetPassword({ email, code, newPassword: "one-use-password-123" });
    await expect(reset("192.0.2.21")).resolves.toEqual({ success: true });
    await expect(reset("192.0.2.22"))
      .rejects.toMatchObject({ code: "BAD_REQUEST", message: "Invalid or expired reset code" });
  });
});
