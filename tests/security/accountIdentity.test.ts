import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { ENV } from "../../server/_core/env";
import { hashPasswordResetCode } from "../../server/passwordResetSecurity";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

describe("account email identity migration", () => {
  it("quarantines every ambiguous legacy identity without merging owned accounts", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      database.exec(`
        CREATE TABLE users (id text PRIMARY KEY NOT NULL, email text);
        CREATE UNIQUE INDEX users_email_unique ON users(email) WHERE email IS NOT NULL;
        INSERT INTO users(id, email) VALUES
          ('one', 'Owner@Example.test'),
          ('two', ' owner@example.test '),
          ('three', 'Unique@Example.test');
      `);
      const migration = readFileSync("drizzle/0020_account_email_identity.sql", "utf8")
        .replaceAll("--> statement-breakpoint", "");
      database.exec(migration);

      expect(database.prepare("SELECT id, email FROM users ORDER BY id").all()).toEqual([
        { id: "one", email: null },
        { id: "three", email: "unique@example.test" },
        { id: "two", email: null },
      ]);
      expect(database.prepare(`
        SELECT userId, originalEmail, normalizedEmail, status
        FROM account_email_conflicts ORDER BY userId
      `).all()).toEqual([
        { userId: "one", originalEmail: "Owner@Example.test", normalizedEmail: "owner@example.test", status: "pending" },
        { userId: "two", originalEmail: " owner@example.test ", normalizedEmail: "owner@example.test", status: "pending" },
      ]);
      expect(() => database.prepare("INSERT INTO users(id, email) VALUES (?, ?)")
        .run("four", " UNIQUE@example.test ")).toThrow(/unique/i);
    } finally {
      database.close();
    }
  });
});

suite("canonical account identities and generated IDs", () => {
  let app: TestApp;
  const originalServerOnly = ENV.SERVER_ONLY;

  beforeAll(async () => {
    app = await bootTestApp();
    ENV.SERVER_ONLY = false;
    await app.db.insert(app.schema.users).values(buildUser({
      id: "IDENTITY_TEST_OPERATOR",
      email: "operator@example.com",
      role: "admin",
    }));
  });

  afterAll(() => {
    ENV.SERVER_ONLY = originalServerOnly;
    app?.cleanup();
  });

  it("uses one normalized identity for signup, login, reset, and team lookup", async () => {
    await app.makeCaller(null).auth.signup({
      email: "  Owner.Identity@Example.COM  ",
      password: "identity-password-123",
      name: "Identity Owner",
    });
    const [owner] = await app.db.select().from(app.schema.users)
      .where(eq(app.schema.users.email, "owner.identity@example.com"));
    expect(owner.email).toBe("owner.identity@example.com");

    await expect(app.makeCaller(null).auth.login({
      email: " OWNER.IDENTITY@example.com ",
      password: "identity-password-123",
    })).resolves.toMatchObject({ success: true, user: { id: owner.id } });
    await expect(app.makeCaller(null).auth.signup({
      email: "OWNER.IDENTITY@EXAMPLE.COM",
      password: "different-password-123",
      name: "Duplicate",
    })).rejects.toMatchObject({ code: "CONFLICT" });

    const resetCode = "483920";
    await app.db.update(app.schema.users).set({
      resetCodeHash: hashPasswordResetCode(resetCode),
      resetCodeExpiresAt: String(Date.now() + 60_000),
    }).where(eq(app.schema.users.id, owner.id));
    await expect(app.makeCaller(null).auth.resetPassword({
      email: " OWNER.IDENTITY@EXAMPLE.COM ",
      code: resetCode,
      newPassword: "identity-replacement-123",
    })).resolves.toEqual({ success: true });
    const [resetOwner] = await app.db.select().from(app.schema.users)
      .where(eq(app.schema.users.id, owner.id));
    expect(await bcrypt.compare("identity-replacement-123", resetOwner.password)).toBe(true);

    const mate = buildUser({ id: "IDENTITY_MATE", email: "Mate.Identity@Example.com" });
    await app.db.insert(app.schema.users).values(mate);
    await app.db.insert(app.schema.cases).values(buildCase({ id: "IDENTITY_CASE", userId: owner.id }));
    await expect(app.makeCaller(owner).teams.invite({
      caseId: "IDENTITY_CASE",
      email: " MATE.IDENTITY@example.COM ",
      role: "read_only",
      capabilities: [],
    })).resolves.toMatchObject({ memberId: mate.id, status: "pending" });
  });

  it("does not derive user or lawyer IDs from a frozen clock", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const claims = await Promise.all([
        app.makeCaller(null).auth.signup({ email: "clock-a@example.com", password: "clock-password-a", name: "Clock A" }),
        app.makeCaller(null).auth.signup({ email: "clock-b@example.com", password: "clock-password-b", name: "Clock B" }),
      ]);
      expect(claims.every((claim) => claim.success)).toBe(true);
      const clockUsers = (await app.db.select().from(app.schema.users))
        .filter((user: any) => user.email?.startsWith("clock-"));
      expect(new Set(clockUsers.map((user: any) => user.id)).size).toBe(2);
      expect(clockUsers.every((user: any) => /^USER-[0-9a-f-]{36}$/.test(user.id))).toBe(true);

      const admin = { id: ownerId(app), name: "Operator", role: "admin", email: "operator@example.com" };
      const lawyers = await Promise.all([
        app.makeCaller(admin).lawyers.create({ name: "Clock Lawyer A" }),
        app.makeCaller(admin).lawyers.create({ name: "Clock Lawyer B" }),
      ]);
      expect(new Set(lawyers.map((lawyer) => lawyer.id)).size).toBe(2);
      expect(lawyers.every((lawyer) => /^LAW-[0-9a-f-]{36}$/.test(lawyer.id))).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });

  it("lets an administrator explicitly resolve a quarantined identity", async () => {
    const user = buildUser({ id: "CONFLICT_USER", email: null });
    await app.db.insert(app.schema.users).values(user);
    await app.db.insert(app.schema.accountEmailConflicts).values({
      id: "CONFLICT_RECORD",
      userId: user.id,
      originalEmail: "Conflict@Example.com",
      normalizedEmail: "conflict@example.com",
      status: "pending",
      createdAt: new Date(),
    });
    const admin = { id: ownerId(app), name: "Operator", role: "admin", email: "operator@example.com" };
    await expect(app.makeCaller(admin).admin.resolveEmailIdentityConflict({
      conflictId: "CONFLICT_RECORD",
      email: " Resolved@Example.com ",
    })).resolves.toMatchObject({ resolved: true, userId: user.id, email: "resolved@example.com" });
    const [updated] = await app.db.select().from(app.schema.users).where(eq(app.schema.users.id, user.id));
    expect(updated.email).toBe("resolved@example.com");
  });
});

function ownerId(app: TestApp): string {
  void app;
  return "IDENTITY_TEST_OPERATOR";
}
