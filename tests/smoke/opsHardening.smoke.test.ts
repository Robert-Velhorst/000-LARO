/**
 * Phases 016-020 - operational behavior and live persistence boundaries.
 *
 * S0-06 owns hostile security-boundary coverage; these S0-09 checks own the
 * corresponding product outcomes. Both use the shared migrated-app harness.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { checkRateLimit, RATE_LIMITS } from "../../server/rateLimit";
import { resolveClientIp } from "../../server/clientIp";
import { getJobStatus, runJob } from "../../server/cronScheduler";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

describe("Phase 018 - rate limiter enforces the window", () => {
  it("throws after the configured request count", () => {
    const config = { maxRequests: 3, windowMs: 60_000 };
    const id = `test-${Math.round(performance.now())}-${process.hrtime.bigint()}`;
    expect(() => checkRateLimit(id, config)).not.toThrow();
    expect(() => checkRateLimit(id, config)).not.toThrow();
    expect(() => checkRateLimit(id, config)).not.toThrow();
    expect(() => checkRateLimit(id, config)).toThrow(/Rate limit|Too many|limit/i);
  });

  it("keeps finite named limits for sensitive live routes", () => {
    expect(RATE_LIMITS.caseCreate.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.auth.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.passwordResetRequest.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.passwordResetVerify.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.lawyerSearch.maxRequests).toBeGreaterThan(0);
  });

  it("ignores forged forwarded addresses from a direct client", () => {
    expect(resolveClientIp({
      headers: { "x-forwarded-for": "203.0.113.250" },
      socket: { remoteAddress: "198.51.100.10" },
    }, "loopback")).toBe("198.51.100.10");
  });

  it("walks a trusted proxy chain to the first untrusted client", () => {
    expect(resolveClientIp({
      headers: { "x-forwarded-for": "203.0.113.250, 198.51.100.42" },
      socket: { remoteAddress: "127.0.0.1" },
    }, "loopback,198.51.100.0/24")).toBe("203.0.113.250");
  });
});

describe("Phase 016 - cron job runner", () => {
  it("records a successful run", async () => {
    await runJob("unit-ok", async () => { /* successful operation */ });
    const status = getJobStatus().find((job) => job.name === "unit-ok");
    expect(status).toBeTruthy();
    expect(status!.lastSuccessAt).not.toBeNull();
    expect(status!.failures).toBe(0);
  });

  it("retries and records a terminal failure without escaping the scheduler", async () => {
    let calls = 0;
    await runJob("unit-fail", async () => {
      calls += 1;
      throw new Error("boom");
    }, { retries: 2, baseDelayMs: 1 });
    const status = getJobStatus().find((job) => job.name === "unit-fail");
    expect(calls).toBe(3);
    expect(status!.failures).toBe(1);
    expect(status!.lastError).toContain("boom");
  });
});

const liveSuite = sqliteAvailable ? describe : describe.skip;

liveSuite("Phases 017-020 - migrated application behavior", () => {
  let app: TestApp;
  const originalProxySpec = process.env.LARO_TRUSTED_PROXY_CIDRS;
  const owner = { id: "OPS_OWNER", name: "Operations owner", role: "user", email: "ops-owner@example.test" };
  const other = { id: "OPS_OTHER", name: "Other owner", role: "user", email: "ops-other@example.test" };
  const outreachCase = buildCase({ id: "OPS_OUTREACH_CASE", userId: owner.id, status: "Matching" });
  const actionCase = buildCase({
    id: "OPS_ACTION_CASE",
    userId: owner.id,
    clientName: "Needs evidence",
    status: "Matching",
    urgency: "High",
  });

  beforeAll(async () => {
    delete process.env.LARO_TRUSTED_PROXY_CIDRS;
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    await app.db.insert(app.schema.cases).values([outreachCase, actionCase]);
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "OPS_LAWYER",
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
  });

  afterEach(() => {
    delete process.env.LARO_TRUSTED_PROXY_CIDRS;
  });

  afterAll(() => {
    app?.cleanup();
    if (originalProxySpec === undefined) delete process.env.LARO_TRUSTED_PROXY_CIDRS;
    else process.env.LARO_TRUSTED_PROXY_CIDRS = originalProxySpec;
  });

  it("binds unauthenticated password-reset attempts to the socket address", async () => {
    const attempt = (forgedIp: string) => app.makeCaller(
      null,
      "session",
      false,
      { headers: { "x-forwarded-for": forgedIp }, remoteAddress: "203.0.113.9" },
    ).auth.requestPasswordReset({ email: "missing-proxy-rate-limit@example.com" });

    for (let index = 0; index < RATE_LIMITS.passwordResetRequest.maxRequests; index += 1) {
      await expect(attempt(`198.51.100.${index + 1}`)).resolves.toEqual({ success: true });
    }
    await expect(attempt("198.51.100.250"))
      .rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("makes outreach initiation idempotent in the live route and database", async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.workflow.initiateOutreach({ caseId: outreachCase.id, maxResults: 1 });
    const second = await caller.workflow.initiateOutreach({ caseId: outreachCase.id, maxResults: 1 });
    expect(first).toMatchObject({ success: true, alreadyInitiated: false, created: 1 });
    expect(second).toMatchObject({ success: true, alreadyInitiated: true, created: 0 });

    const rows = await app.db.select().from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.caseId, outreachCase.id));
    expect(rows).toHaveLength(1);
  });

  it("writes case audit events and returns them only to their owner", async () => {
    const ownerCaller = app.makeCaller(owner);
    const created = await ownerCaller.cases.create({
      clientName: "Audited Client",
      clientEmail: "audited@example.test",
      caseType: "Employment",
      caseSummary: "employment dismissal review",
      urgency: "Medium",
    });
    await expect(ownerCaller.audit.list({
      entityType: "case",
      entityId: created.id,
      action: "case.created",
    })).resolves.toContainEqual(expect.objectContaining({
      userId: owner.id,
      entityId: created.id,
      action: "case.created",
    }));
    await expect(app.makeCaller(other).audit.list({ entityId: created.id }))
      .resolves.toEqual([]);

    await expect(ownerCaller.cases.delete({ id: created.id }))
      .resolves.toMatchObject({ success: true, deletionStatus: "completed" });
    await expect(ownerCaller.audit.list({ entityId: created.id, action: "case.deleted" }))
      .resolves.toContainEqual(expect.objectContaining({ action: "case.deleted" }));
  });

  it("derives next actions from owned case state", async () => {
    const actions = await app.makeCaller(owner).dashboard.nextActions();
    expect(actions).toContainEqual(expect.objectContaining({
      caseId: actionCase.id,
      caseTitle: "Needs evidence",
      action: "Add evidence",
      priority: "high",
    }));
    const otherActions = await app.makeCaller(other).dashboard.nextActions();
    expect(otherActions.some((action: { caseId: string }) => action.caseId === actionCase.id)).toBe(false);
  });
});
