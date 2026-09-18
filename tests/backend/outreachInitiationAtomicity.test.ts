import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildLawyer, buildUser } from "../factories";

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

const suite = sqliteAvailable ? describe : describe.skip;

suite("atomic outreach initiation", () => {
  let app: TestApp;
  const users = Array.from({ length: 6 }, (_, index) => buildUser({
    id: `OUTREACH_ATOMIC_USER_${index + 1}`,
    email: `outreach-atomic-${index + 1}@example.test`,
  }));

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(users);
  });

  afterAll(() => app?.cleanup());
  afterEach(() => {
    vi.unstubAllEnvs();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  });

  async function storedCaseStatus(caseId: string): Promise<string | null> {
    const [row] = await app.db.select({ status: app.schema.cases.status })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, caseId));
    return row.status;
  }

  async function storedDrafts(caseId: string) {
    return app.db.select().from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.caseId, caseId));
  }

  it("rejects invalid source states through the canonical case state machine before creating drafts", async () => {
    const user = users[0];
    const caseId = "OUTREACH_ATOMIC_CLOSED";
    const legalArea = "Atomic Closed Law";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: user.id,
      status: "Closed",
      legalAreas: JSON.stringify([legalArea]),
    }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "OUTREACH_ATOMIC_CLOSED_LAWYER",
      legalAreas: JSON.stringify([legalArea]),
    }));

    await expect(app.makeCaller(user).workflow.initiateOutreach({ caseId, maxResults: 1 }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await storedCaseStatus(caseId)).toBe("Closed");
    expect(await storedDrafts(caseId)).toEqual([]);
  });

  it("leaves the case and existing outreach history unchanged when there are no candidates or matching fails", async () => {
    const user = users[1];
    const noMatchCaseId = "OUTREACH_ATOMIC_NO_MATCH";
    const failureCaseId = "OUTREACH_ATOMIC_MATCH_FAILURE";
    await app.db.insert(app.schema.cases).values([
      buildCase({
        id: noMatchCaseId,
        userId: user.id,
        status: "Matching",
        legalAreas: JSON.stringify(["Atomic No Candidate Law"]),
      }),
      buildCase({
        id: failureCaseId,
        userId: user.id,
        status: "Matching",
        legalAreas: "not-valid-json",
      }),
    ]);
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "OUTREACH_ATOMIC_HISTORY_LAWYER",
      legalAreas: JSON.stringify(["Unrelated History Law"]),
    }));
    await app.db.insert(app.schema.outreachStatus).values([
      {
        id: "OUTREACH_ATOMIC_NO_MATCH_HISTORY",
        caseId: noMatchCaseId,
        lawyerId: "OUTREACH_ATOMIC_HISTORY_LAWYER",
        status: "Approved",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "OUTREACH_ATOMIC_FAILURE_HISTORY",
        caseId: failureCaseId,
        lawyerId: "OUTREACH_ATOMIC_HISTORY_LAWYER",
        status: "Rejected",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const caller = app.makeCaller(user);
    await expect(caller.workflow.initiateOutreach({ caseId: noMatchCaseId, maxResults: 5 }))
      .resolves.toMatchObject({ success: false, statusChanged: false, created: 0, candidates: 0 });
    await expect(caller.workflow.initiateOutreach({ caseId: failureCaseId, maxResults: 5 }))
      .resolves.toMatchObject({ success: false, statusChanged: false, created: 0, candidates: 0 });

    expect(await storedCaseStatus(noMatchCaseId)).toBe("Matching");
    expect(await storedCaseStatus(failureCaseId)).toBe("Matching");
    expect((await storedDrafts(noMatchCaseId)).map((row: any) => [row.id, row.status]))
      .toEqual([["OUTREACH_ATOMIC_NO_MATCH_HISTORY", "Approved"]]);
    expect((await storedDrafts(failureCaseId)).map((row: any) => [row.id, row.status]))
      .toEqual([["OUTREACH_ATOMIC_FAILURE_HISTORY", "Rejected"]]);
  });

  it("rolls back the first draft and case transition when a later draft insert fails", async () => {
    const user = users[2];
    const caseId = "OUTREACH_ATOMIC_PARTIAL_FAILURE";
    const legalArea = "Atomic Rollback Law";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: user.id,
      status: "Matching",
      legalAreas: JSON.stringify([legalArea]),
    }));
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "OUTREACH_ATOMIC_ROLLBACK_A", legalAreas: JSON.stringify([legalArea]) }),
      buildLawyer({ id: "OUTREACH_ATOMIC_ROLLBACK_B", legalAreas: JSON.stringify([legalArea]) }),
    ]);

    const sqlite = app.db.$client;
    sqlite.exec(`
      CREATE TRIGGER outreach_atomic_fail_second_insert
      BEFORE INSERT ON outreach_status
      WHEN NEW.caseId = '${caseId}'
        AND (SELECT COUNT(*) FROM outreach_status WHERE caseId = '${caseId}') = 1
      BEGIN
        SELECT RAISE(ABORT, 'injected second draft failure');
      END;
    `);
    try {
      await expect(app.makeCaller(user).workflow.initiateOutreach({ caseId, maxResults: 2 }))
        .rejects.toThrow("injected second draft failure");
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS outreach_atomic_fail_second_insert");
    }

    expect(await storedCaseStatus(caseId)).toBe("Matching");
    expect(await storedDrafts(caseId)).toEqual([]);
    const audits = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.entityId, caseId),
      eq(app.schema.auditLogs.action, "outreach.initiated"),
    ));
    expect(audits).toEqual([]);
  });

  it("does not fall through to persisted candidates when the live provider fails", async () => {
    const user = users[5];
    const caseId = "OUTREACH_ATOMIC_PROVIDER_FAILURE";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: user.id,
      status: "Matching",
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "OUTREACH_ATOMIC_PROVIDER_FALLBACK",
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    vi.stubEnv("NODE_ENV", "development");

    await expect(app.makeCaller(user).workflow.initiateOutreach({ caseId, maxResults: 1 }))
      .resolves.toMatchObject({
        success: false,
        statusChanged: false,
        created: 0,
        candidates: 0,
        directoryStatus: "unavailable",
      });
    expect(await storedCaseStatus(caseId)).toBe("Matching");
    expect(await storedDrafts(caseId)).toEqual([]);
  });

  it("coalesces concurrent retries into one draft set and one transition", async () => {
    const user = users[3];
    const caseId = "OUTREACH_ATOMIC_CONCURRENT";
    const legalArea = "Atomic Concurrent Law";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: user.id,
      status: "Matching",
      legalAreas: JSON.stringify([legalArea]),
    }));
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "OUTREACH_ATOMIC_CONCURRENT_A", legalAreas: JSON.stringify([legalArea]) }),
      buildLawyer({ id: "OUTREACH_ATOMIC_CONCURRENT_B", legalAreas: JSON.stringify([legalArea]) }),
    ]);

    const caller = app.makeCaller(user);
    const results = await Promise.all([
      caller.workflow.initiateOutreach({ caseId, maxResults: 2 }),
      caller.workflow.initiateOutreach({ caseId, maxResults: 2 }),
    ]);
    expect(results.every((result: any) => result.success)).toBe(true);
    expect(results.reduce((sum: number, result: any) => sum + result.created, 0)).toBe(2);
    expect(results.filter((result: any) => result.alreadyInitiated)).toHaveLength(1);
    expect(await storedCaseStatus(caseId)).toBe("Outreach");
    const drafts = await storedDrafts(caseId);
    expect(drafts).toHaveLength(2);
    expect(drafts.every((row: any) => row.status === "PendingApproval")).toBe(true);
    expect(new Set(drafts.map((row: any) => row.lawyerId)).size).toBe(2);
    const audits = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.entityId, caseId),
      eq(app.schema.auditLogs.action, "outreach.initiated"),
    ));
    expect(audits).toHaveLength(1);
  });

  it("commits reviewable drafts with the transition and preserves review decisions on repeat", async () => {
    const user = users[4];
    const caseId = "OUTREACH_ATOMIC_SUCCESS";
    const legalArea = "Atomic Success Law";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: user.id,
      status: "Matching",
      legalAreas: JSON.stringify([legalArea]),
    }));
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "OUTREACH_ATOMIC_SUCCESS_A", legalAreas: JSON.stringify([legalArea]) }),
      buildLawyer({ id: "OUTREACH_ATOMIC_SUCCESS_B", legalAreas: JSON.stringify([legalArea]) }),
    ]);

    const caller = app.makeCaller(user);
    await expect(caller.workflow.initiateOutreach({ caseId, maxResults: 2 })).resolves.toMatchObject({
      success: true,
      alreadyInitiated: false,
      statusChanged: true,
      created: 2,
      candidates: 2,
      automaticallyApproved: 0,
    });
    expect(await storedCaseStatus(caseId)).toBe("Outreach");
    let drafts = await storedDrafts(caseId);
    expect(drafts).toHaveLength(2);
    expect(drafts.every((row: any) => row.status === "PendingApproval")).toBe(true);

    const approvedId = drafts[0].id;
    await app.db.update(app.schema.outreachStatus).set({ status: "Approved" })
      .where(eq(app.schema.outreachStatus.id, approvedId));
    await expect(caller.workflow.initiateOutreach({ caseId, maxResults: 2 })).resolves.toMatchObject({
      success: true,
      alreadyInitiated: true,
      statusChanged: false,
      created: 0,
    });
    drafts = await storedDrafts(caseId);
    expect(drafts).toHaveLength(2);
    expect(drafts.find((row: any) => row.id === approvedId)?.status).toBe("Approved");
    expect(drafts.filter((row: any) => row.status === "PendingApproval")).toHaveLength(1);
  });
});
