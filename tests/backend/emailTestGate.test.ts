import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

const sendSystemEmail = vi.fn();
vi.mock("../../server/systemEmail", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/systemEmail")>();
  return { ...original, sendSystemEmail };
});

const suite = sqliteAvailable ? describe : describe.skip;

suite("transactional email self-test gate", () => {
  let app: TestApp;
  const admin = { id: "ADMIN_EMAIL_TEST", name: "Admin", role: "admin", email: "admin@example.com" };
  const user = { id: "USER_EMAIL_TEST", name: "User", role: "user", email: "user@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(admin),
      buildUser(user),
    ]);
  });

  beforeEach(async () => {
    sendSystemEmail.mockReset();
    sendSystemEmail.mockResolvedValue({ delivered: true, provider: "smtp", providerMessageId: "test-id" });
    delete process.env.LARO_EMAIL_TEST_ALLOWLIST;
    await app.db.delete(app.schema.systemConfig).where(eq(app.schema.systemConfig.configKey, "system:emergency_stop"));
  });

  afterAll(() => app?.cleanup());

  async function actionsFor(userId: string): Promise<string[]> {
    const rows = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.userId, userId));
    return rows.map((row: any) => row.action);
  }

  it("denies a normal user before invoking the provider and audits the decision", async () => {
    await expect(app.makeCaller(user).email.test({ to: user.email })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sendSystemEmail).not.toHaveBeenCalled();
    expect(await actionsFor(user.id)).toContain("email.test_denied");
  });

  it("denies an arbitrary recipient before invoking the provider", async () => {
    await expect(app.makeCaller(admin).email.test({ to: "third-party@example.com" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sendSystemEmail).not.toHaveBeenCalled();
    expect(await actionsFor(admin.id)).toContain("email.test_denied");
  });

  it("honors the emergency stop before invoking the provider", async () => {
    await app.db.insert(app.schema.systemConfig).values({
      configKey: "system:emergency_stop",
      configValue: "true",
      updatedAt: new Date(),
    });
    await expect(app.makeCaller(admin).email.test({ to: admin.email })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(sendSystemEmail).not.toHaveBeenCalled();
  });

  it("delivers an authorized self-test and records attempted and confirmed outcomes", async () => {
    const result = await app.makeCaller(admin).email.test({ to: " ADMIN@EXAMPLE.COM " });
    expect(result).toMatchObject({ success: true, provider: "smtp" });
    expect(sendSystemEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "admin@example.com",
      subject: "LARO transactional email self-test",
    }));
    const actions = await actionsFor(admin.id);
    expect(actions).toContain("email.test_attempted");
    expect(actions).toContain("email.test_delivered");
    const rows = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.userId, admin.id));
    expect(rows.map((row: any) => row.details).join("\n")).not.toContain(admin.email);
  });

  it("supports an explicit acceptance allowlist and audits provider failure", async () => {
    process.env.LARO_EMAIL_TEST_ALLOWLIST = "acceptance@example.com";
    sendSystemEmail.mockRejectedValueOnce(new Error("SMTP password=secret socket failed"));
    await expect(app.makeCaller(admin).email.test({ to: "acceptance@example.com" })).rejects.toThrow();
    expect(sendSystemEmail).toHaveBeenCalledTimes(1);
    expect(await actionsFor(admin.id)).toContain("email.test_failed");
  });

  it("rate-limits further delivery attempts and audits without a fourth provider call", async () => {
    const caller = app.makeCaller({ ...admin, id: "ADMIN_EMAIL_RATE", email: "rate@example.com" });
    await app.db.insert(app.schema.users).values(buildUser({ id: "ADMIN_EMAIL_RATE", role: "admin", email: "rate@example.com" }));
    for (let index = 0; index < 3; index += 1) await caller.email.test({ to: "rate@example.com" });
    await expect(caller.email.test({ to: "rate@example.com" })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(sendSystemEmail).toHaveBeenCalledTimes(3);
    expect(await actionsFor("ADMIN_EMAIL_RATE")).toContain("email.test_rate_limited");
  });
});
