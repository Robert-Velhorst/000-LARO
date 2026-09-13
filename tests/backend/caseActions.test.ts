import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

(sqliteAvailable ? describe : describe.skip)("case actions", () => {
  let app: TestApp;
  let caseId: string;
  const owner = { id: "ACTION_OWNER", email: "actions@example.test", role: "user" };
  const other = { id: "ACTION_OTHER", email: "other-actions@example.test", role: "user" };
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    caseId = (await app.makeCaller(owner).cases.create({ clientName: "Actions", clientEmail: owner.email,
      caseType: "Contract", caseSummary: "Source-based action tracking", urgency: "Medium" })).id;
  });
  afterAll(() => app?.cleanup());

  it("stores undated actions and audits completion and reopening without changing the history", async () => {
    const caller = app.makeCaller(owner).caseManagement;
    const created = await caller.addDeadline({ caseId, title: "Request missing correspondence" });
    expect(await caller.getUpcomingDeadlines({ caseId, completed: false })).toContainEqual(
      expect.objectContaining({ id: created.id, dueDate: null, completed: false }));
    expect(await caller.completeDeadline({ id: created.id })).toEqual({ ok: true });
    expect(await caller.getUpcomingDeadlines({ caseId, completed: false })).toEqual([]);
    expect(await caller.getUpcomingDeadlines({ caseId, completed: true })).toContainEqual(expect.objectContaining({ id: created.id }));
    expect(await caller.completeDeadline({ id: created.id, completed: false })).toEqual({ ok: true });
    expect(await caller.getUpcomingDeadlines({ caseId, completed: false })).toHaveLength(1);
    const logs = (await app.db.select().from(app.schema.auditLogs)).filter((row: any) => row.entityId === created.id);
    expect(logs.map((row: any) => row.action).sort()).toEqual(["case.action_completed", "case.action_created", "case.action_reopened"]);
  });

  it("rejects invalid dates, empty actions, and cross-owner writes", async () => {
    const caller = app.makeCaller(owner).caseManagement;
    await expect(caller.addDeadline({ caseId, title: " ", dueDate: "2026-09-04T12:00:00Z" })).rejects.toThrow();
    await expect(caller.addDeadline({ caseId, title: "Deadline", dueDate: "2026-02-31T12:00:00Z" })).rejects.toThrow();
    await expect(app.makeCaller(other).caseManagement.addDeadline({ caseId, title: "Not mine" })).rejects.toThrow();
    const [action] = await caller.getUpcomingDeadlines({ caseId });
    expect(await app.makeCaller(other).caseManagement.completeDeadline({ id: action.id })).toEqual({ ok: false });
  });

  it("supports paging so completed records cannot hide outstanding actions", async () => {
    const caller = app.makeCaller(owner).caseManagement;
    await caller.addDeadline({ caseId, title: "Dated action", dueDate: "2026-09-10" });
    const first = await caller.getUpcomingDeadlines({ caseId, completed: false, limit: 1, offset: 0 });
    const second = await caller.getUpcomingDeadlines({ caseId, completed: false, limit: 1, offset: 1 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].id).not.toBe(second[0].id);
  });
});
