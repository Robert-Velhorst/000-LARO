import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { acquireLLMUsageBudget, resetLLMUsageBudgetForTests } from "../../server/llmUsageBudget";
import { trackUsage } from "../../server/usageTracking";
import { buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("enforceable optional processing preferences", () => {
  let app: TestApp;
  const A = { id: "PRIVACY_OWNER_A", name: "Privacy A", role: "user", email: "privacy-a@example.test" };
  const B = { id: "PRIVACY_OWNER_B", name: "Privacy B", role: "user", email: "privacy-b@example.test" };
  const LEGACY = { id: "PRIVACY_LEGACY", name: "Privacy legacy", role: "user", email: "privacy-legacy@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(A),
      buildUser(B),
      buildUser(LEGACY),
    ]);
    await app.db.insert(app.schema.userPreferences).values({
      id: "PRIVACY_LEGACY_PREF",
      userId: LEGACY.id,
      key: "privacy-consent",
      value: JSON.stringify({ marketing: true, analytics: false }),
      updatedAt: new Date(),
    });
  });

  afterAll(() => {
    resetLLMUsageBudgetForTests();
    app?.cleanup();
  });

  it("defaults off, removes unsupported marketing state, and rejects the removed API field", async () => {
    const consent = await app.makeCaller(LEGACY).gdpr.getConsent();
    expect(consent).toEqual({
      ownerId: LEGACY.id,
      dataProcessing: true,
      analytics: false,
    });

    const [stored] = await app.db.select().from(app.schema.userPreferences).where(eq(
      app.schema.userPreferences.id,
      "PRIVACY_LEGACY_PREF",
    ));
    expect(JSON.parse(stored.value)).toEqual({ analytics: false });

    await expect(app.makeCaller(LEGACY).gdpr.updateConsent({ marketing: true } as any))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("enforces opt-in and opt-out at the writer while required records remain active", async () => {
    const caller = app.makeCaller(A);
    const defaultWrite = await trackUsage({
      userId: A.id,
      resourceType: "document_generation",
      metadata: { state: "default-off" },
    });
    expect(defaultWrite).toMatchObject({ recorded: false, reason: "analytics_disabled" });

    await caller.gdpr.updateConsent({ analytics: true, expectedUserId: A.id });
    const optedInWrite = await trackUsage({
      userId: A.id,
      resourceType: "document_generation",
      metadata: { state: "opted-in" },
    });
    expect(optedInWrite).toMatchObject({ recorded: true });

    await caller.gdpr.updateConsent({ analytics: false, expectedUserId: A.id });
    const optedOutWrite = await trackUsage({
      userId: A.id,
      resourceType: "document_generation",
      metadata: { state: "opted-out" },
    });
    expect(optedOutWrite).toMatchObject({ recorded: false, reason: "analytics_disabled" });

    const optionalRows = await app.db.select().from(app.schema.usageTracking)
      .where(eq(app.schema.usageTracking.userId, A.id));
    expect(optionalRows).toHaveLength(1);
    expect(JSON.parse(optionalRows[0].metadata)).toMatchObject({ state: "opted-in" });

    const consentAudits = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.userId, A.id),
      eq(app.schema.auditLogs.action, "gdpr.consent_updated"),
    ));
    expect(consentAudits).toHaveLength(2);

    const release = await acquireLLMUsageBudget({
      ownerId: A.id,
      providerClass: "local",
      inputCharacters: 10,
      outputTokens: 5,
    });
    release();
    const requiredBudgetRows = await app.db.select().from(app.schema.systemConfig)
      .where(like(app.schema.systemConfig.configKey, "llm-budget:v1:%"));
    expect(requiredBudgetRows.length).toBeGreaterThan(0);
  });

  it("keeps the preference and canonical writer isolated during account changes", async () => {
    await app.makeCaller(A).gdpr.updateConsent({ analytics: true, expectedUserId: A.id });
    expect(await app.makeCaller(B).gdpr.getConsent()).toMatchObject({ ownerId: B.id, analytics: false });

    const [aWrite, bWrite] = await Promise.all([
      trackUsage({ userId: A.id, resourceType: "other", metadata: { owner: "A" } }),
      trackUsage({ userId: B.id, resourceType: "other", metadata: { owner: "B" } }),
    ]);
    expect(aWrite.recorded).toBe(true);
    expect(bWrite).toMatchObject({ recorded: false, reason: "analytics_disabled" });

    const bRows = await app.db.select().from(app.schema.usageTracking)
      .where(eq(app.schema.usageTracking.userId, B.id));
    expect(bRows).toEqual([]);

    await expect(app.makeCaller(B).gdpr.updateConsent({
      analytics: true,
      expectedUserId: A.id,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await app.makeCaller(B).gdpr.getConsent()).toMatchObject({ ownerId: B.id, analytics: false });
  });

  it("serializes concurrent preference changes and makes the final state authoritative", async () => {
    const caller = app.makeCaller(A);
    await Promise.all([
      caller.gdpr.updateConsent({ analytics: false, expectedUserId: A.id }),
      caller.gdpr.updateConsent({ analytics: true, expectedUserId: A.id }),
      caller.gdpr.updateConsent({ analytics: false, expectedUserId: A.id }),
    ]);

    const finalConsent = await caller.gdpr.getConsent();
    const write = await trackUsage({
      userId: A.id,
      resourceType: "other",
      metadata: { state: "after-concurrent-updates" },
    });
    expect(write.recorded).toBe(finalConsent.analytics);
  });
});
