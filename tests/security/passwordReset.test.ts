import crypto from "crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { AUDIT_ACTIONS } from "../../server/audit";
import { hashPasswordResetCode } from "../../server/passwordResetSecurity";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

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
});
