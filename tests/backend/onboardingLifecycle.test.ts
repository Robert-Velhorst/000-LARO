import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildCase, buildEvidence, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("canonical onboarding lifecycle", () => {
  let app: TestApp;
  const first = { id: "ONBOARDING_FIRST", name: "First", role: "user", email: "first-onboarding@example.test" };
  const second = { id: "ONBOARDING_SECOND", name: "Second", role: "user", email: "second-onboarding@example.test" };
  const legacy = { id: "ONBOARDING_LEGACY", name: "Legacy", role: "user", email: "legacy-onboarding@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(first),
      buildUser(second),
      buildUser(legacy),
    ]);
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: "ONBOARDING_LAWYER" }));
  });

  afterAll(() => app?.cleanup());

  it("protects every route and preserves resume, skip, reset, completion, and account isolation", async () => {
    const anonymous = app.makeCaller(null);
    await expect(anonymous.onboarding.state()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.onboarding.setCurrentStep({ stepKey: "evidence" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.onboarding.skip()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.onboarding.reset()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anonymous.onboarding.complete()).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const firstCaller = app.makeCaller(first);
    const secondCaller = app.makeCaller(second);
    const initial = await firstCaller.onboarding.state();
    expect(initial).toMatchObject({
      status: "active",
      complete: false,
      currentStepKey: "case",
      completedSteps: 0,
      totalSteps: 3,
      canComplete: false,
    });
    expect(initial.steps.map((step: any) => step.route)).toEqual(["/cases", "/evidence", "/outreach"]);
    await expect(firstCaller.onboarding.complete()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    await firstCaller.onboarding.setCurrentStep({ stepKey: "evidence" });
    expect((await firstCaller.onboarding.state()).currentStepKey).toBe("evidence");
    expect(await firstCaller.onboarding.skip()).toMatchObject({ status: "skipped", currentStepKey: "evidence" });
    expect(await firstCaller.onboarding.state()).toMatchObject({ status: "skipped", currentStepKey: "evidence" });

    // A different account has its own untouched first-run lifecycle.
    expect(await secondCaller.onboarding.state()).toMatchObject({
      status: "active",
      currentStepKey: "case",
      completedSteps: 0,
    });
    expect(await firstCaller.onboarding.reset()).toMatchObject({ status: "active", currentStepKey: "case" });

    const caseId = "ONBOARDING_CASE";
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId: first.id }));
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "ONBOARDING_EVIDENCE",
      caseId,
      userId: first.id,
    }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "ONBOARDING_OUTREACH",
      caseId,
      lawyerId: "ONBOARDING_LAWYER",
      status: "PendingApproval",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const ready = await firstCaller.onboarding.state();
    expect(ready).toMatchObject({ completedSteps: 3, totalSteps: 3, canComplete: true, complete: false });
    expect(ready.steps.every((step: any) => step.complete)).toBe(true);
    const completed = await firstCaller.onboarding.complete();
    expect(completed).toMatchObject({ status: "complete", complete: true, canComplete: true });
    expect(await firstCaller.onboarding.state()).toMatchObject({ status: "complete", complete: true });

    // Reset reopens presentation without erasing real workspace progress.
    expect(await firstCaller.onboarding.reset()).toMatchObject({
      status: "active",
      currentStepKey: "case",
      completedSteps: 3,
      canComplete: true,
    });
    expect(await secondCaller.onboarding.state()).toMatchObject({ completedSteps: 0, canComplete: false });
  });

  it("migrates the legacy completion boolean into the canonical state", async () => {
    const oldKey = `onboarding:complete:${legacy.id}`;
    const newKey = `onboarding:state:${legacy.id}`;
    await app.db.insert(app.schema.systemConfig).values({ configKey: oldKey, configValue: "true", updatedAt: new Date() });

    expect(await app.makeCaller(legacy).onboarding.state()).toMatchObject({ status: "complete", complete: true });
    const rows = await app.db.select().from(app.schema.systemConfig);
    expect(rows.find((row: any) => row.configKey === oldKey)).toBeUndefined();
    expect(JSON.parse(rows.find((row: any) => row.configKey === newKey)?.configValue ?? "{}")).toMatchObject({
      status: "complete",
      currentStepKey: "case",
    });

    await app.db.delete(app.schema.systemConfig).where(eq(app.schema.systemConfig.configKey, newKey));
  });
});
