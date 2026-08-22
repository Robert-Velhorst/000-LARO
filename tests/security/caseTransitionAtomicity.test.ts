import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildUser } from "../factories";
import { compareAndSetCaseStatus } from "../../server/caseTransitions";

const suite = sqliteAvailable ? describe : describe.skip;

suite("atomic case status transitions", () => {
  let app: TestApp;
  const owner = { id: "CASE_TRANSITION_OWNER", role: "user", email: "transition-owner@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
  });

  afterAll(() => app?.cleanup());

  it("allows only one transition from the same observed status", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_TRANSITION_RACE",
      userId: owner.id,
      status: "Matching",
    }));

    const attempts = await Promise.allSettled([
      compareAndSetCaseStatus(app.db, {
        caseId: "CASE_TRANSITION_RACE",
        ownerId: owner.id,
        expectedStatus: "Matching",
        nextStatus: "Outreach",
      }),
      compareAndSetCaseStatus(app.db, {
        caseId: "CASE_TRANSITION_RACE",
        ownerId: owner.id,
        expectedStatus: "Matching",
        nextStatus: "Closed",
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const [stored] = await app.db
      .select({ status: app.schema.cases.status })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_TRANSITION_RACE"));
    expect(["Outreach", "Closed"]).toContain(stored.status);
  });

  it("routes both public case transition paths through compare-and-set", async () => {
    await app.db.insert(app.schema.cases).values([
      buildCase({ id: "CASE_TRANSITION_PRIMARY", userId: owner.id, status: "Matching" }),
      buildCase({ id: "CASE_TRANSITION_MANAGEMENT", userId: owner.id, status: "Matching" }),
    ]);

    const caller = app.makeCaller(owner);
    await expect(caller.cases.update({
      id: "CASE_TRANSITION_PRIMARY",
      status: "Outreach",
    })).resolves.toEqual({ success: true });
    await expect(caller.caseManagement.updateStatus({
      caseId: "CASE_TRANSITION_MANAGEMENT",
      status: "Closed",
    })).resolves.toEqual({ ok: true, status: "Closed" });
  });

  it("does not let concurrent outreach responses overwrite each other", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_RESPONSE_RACE",
      userId: owner.id,
      status: "Outreach",
    }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "OUTREACH_RESPONSE_RACE",
      caseId: "CASE_RESPONSE_RACE",
      status: "Sent",
      initialContact: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const caller = app.makeCaller(owner);
    const attempts = await Promise.allSettled([
      caller.workflow.recordResponse({ outreachId: "OUTREACH_RESPONSE_RACE", response: "Interested" }),
      caller.workflow.recordResponse({ outreachId: "OUTREACH_RESPONSE_RACE", response: "Declined" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

    const [stored] = await app.db
      .select({ status: app.schema.outreachStatus.status })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "OUTREACH_RESPONSE_RACE"));
    expect(["Interested", "Declined"]).toContain(stored.status);
  });

  it("rolls back the outreach response when its case transition is no longer valid", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_RESPONSE_ROLLBACK",
      userId: owner.id,
      status: "Closed",
    }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "OUTREACH_RESPONSE_ROLLBACK",
      caseId: "CASE_RESPONSE_ROLLBACK",
      status: "Sent",
      initialContact: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(app.makeCaller(owner).workflow.recordResponse({
      outreachId: "OUTREACH_RESPONSE_ROLLBACK",
      response: "Interested",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const [stored] = await app.db
      .select({ status: app.schema.outreachStatus.status })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "OUTREACH_RESPONSE_ROLLBACK"));
    expect(stored.status).toBe("Sent");
  });

  it("does not move a case to Outreach when no draft candidate exists", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_OUTREACH_NO_MATCH",
      userId: owner.id,
      caseType: "Unmatched specialist area",
      legalAreas: JSON.stringify(["Unmatched specialist area"]),
      status: "Matching",
    }));

    const result = await app.makeCaller(owner).workflow.initiateOutreach({
      caseId: "CASE_OUTREACH_NO_MATCH",
      maxResults: 5,
    });
    expect(result.candidates).toBe(0);
    expect(result.statusChanged).toBe(false);

    const [stored] = await app.db
      .select({ status: app.schema.cases.status })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_OUTREACH_NO_MATCH"));
    expect(stored.status).toBe("Matching");
  });
});
