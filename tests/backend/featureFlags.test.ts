import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import {
  FEATURE_FLAG_KEYS,
  FEATURE_FLAG_REGISTRY,
  isOutreachSendingEnabled,
  setFlag,
} from "../../server/featureFlags";
import { resolveDemoMode } from "../../server/_core/env";
import { buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

suite("maintained feature-flag registry", () => {
  let app: TestApp;
  const admin = { id: "FLAG_ADMIN", name: "Flag Admin", role: "admin", email: "flag-admin@example.test" };
  const user = { id: "FLAG_USER", name: "Flag User", role: "user", email: "flag-user@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(admin), buildUser(user)]);
  });

  afterAll(() => app?.cleanup());

  it("requires an owner, safe default, runtime reader, consumer, and two-state test for every flag", () => {
    expect(FEATURE_FLAG_KEYS).toEqual(["outreach.send.enabled"]);
    const docs = readFileSync(resolve(ROOT, "docs/FEATURE_FLAGS.md"), "utf8");
    for (const key of FEATURE_FLAG_KEYS) {
      const definition = FEATURE_FLAG_REGISTRY[key];
      expect(definition.owner.length).toBeGreaterThan(0);
      expect(definition.defaultValue).toBe(false);
      expect(definition.storageKey).toBe(`flag:${key}`);
      expect(definition.runtimeConsumers.length).toBeGreaterThan(0);
      expect(docs).toContain(key);
      expect(docs).toContain(definition.reader);
      for (const consumer of definition.runtimeConsumers) {
        expect(existsSync(resolve(ROOT, consumer)), consumer).toBe(true);
        expect(readFileSync(resolve(ROOT, consumer), "utf8"), consumer).toContain(definition.reader);
      }
      expect(existsSync(resolve(ROOT, definition.twoStateTest)), definition.twoStateTest).toBe(true);
    }
  });

  it("reads both persisted states through the canonical outreach consumer", async () => {
    await setFlag("outreach.send.enabled", false);
    expect(await isOutreachSendingEnabled()).toBe(false);
    await setFlag("outreach.send.enabled", true);
    expect(await isOutreachSendingEnabled()).toBe(true);
    await setFlag("outreach.send.enabled", false);
  });

  it("exposes only the consumed flag and keeps writes admin-only and validated", async () => {
    expect(await app.makeCaller(user).featureFlags.list()).toEqual({ "outreach.send.enabled": false });
    await expect(app.makeCaller(user).featureFlags.set({
      key: "outreach.send.enabled",
      value: true,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(app.makeCaller(admin).featureFlags.set({
      key: "analytics.enabled",
      value: true,
    } as any)).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(await app.makeCaller(admin).featureFlags.set({
      key: "outreach.send.enabled",
      value: true,
    })).toMatchObject({ success: true, changed: true });
    expect((await app.makeCaller(admin).featureFlags.list())["outreach.send.enabled"]).toBe(true);
    const audit = await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, "feature_flag.changed"));
    expect(audit.some((row: any) => row.entityId === "outreach.send.enabled")).toBe(true);
    await setFlag("outreach.send.enabled", false);
  });

  it("uses DEMO_MODE as the only request and always disables it in production", () => {
    expect(resolveDemoMode(false, "development")).toBe(false);
    expect(resolveDemoMode(true, "development")).toBe(true);
    expect(resolveDemoMode(true, "test")).toBe(true);
    expect(resolveDemoMode(true, "production")).toBe(false);

    const preflight = readFileSync(resolve(ROOT, "scripts/prod-preflight.mjs"), "utf8");
    const featureFlags = readFileSync(resolve(ROOT, "server/featureFlags.ts"), "utf8");
    const systemRouter = readFileSync(resolve(ROOT, "server/_core/systemRouter.ts"), "utf8");
    const adminRouter = readFileSync(resolve(ROOT, "server/routers/admin.ts"), "utf8");
    expect(preflight).not.toContain(["FEATURE", "DEMO_MODE"].join("_"));
    expect(featureFlags).not.toContain('"demo.mode"');
    expect(featureFlags).not.toContain('"analytics.enabled"');
    expect(systemRouter).toContain("demoMode: ENV.isDemo");
    expect(adminRouter).toContain("demoMode: ENV.isDemo");
  });

  it("deletes retired SQLite storage rows without touching the live flag", async () => {
    await app.db.insert(app.schema.systemConfig).values([
      { configKey: "flag:analytics.enabled", configValue: "true", updatedAt: new Date() },
      { configKey: "flag:demo.mode", configValue: "true", updatedAt: new Date() },
    ]);
    await setFlag("outreach.send.enabled", true);
    const sql = readFileSync(resolve(ROOT, "drizzle/0025_remove_dead_feature_flags.sql"), "utf8");
    app.db.$client.exec(sql);

    const rows = await app.db.select().from(app.schema.systemConfig);
    expect(rows.some((row: any) => row.configKey === "flag:analytics.enabled")).toBe(false);
    expect(rows.some((row: any) => row.configKey === "flag:demo.mode")).toBe(false);
    expect(rows.find((row: any) => row.configKey === "flag:outreach.send.enabled")?.configValue).toBe("true");
    await setFlag("outreach.send.enabled", false);
  });
});
