import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildEvidence, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("reminder sweep query efficiency", () => {
  let app: TestApp;
  const owner = { id: "REMINDERS_QUERY_OWNER", name: "Reminder owner", role: "user", email: "reminders-query@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: owner.id, email: owner.email }));
    await app.db.insert(app.schema.cases).values(Array.from({ length: 25 }, (_, index) => buildCase({
      id: `REMINDERS_QUERY_CASE_${index}`,
      userId: owner.id,
      urgency: index % 2 === 0 ? "High" : "Medium",
    })));
    await app.db.insert(app.schema.evidence).values(Array.from({ length: 13 }, (_, index) => buildEvidence({
      id: `REMINDERS_QUERY_EVIDENCE_${index}`,
      userId: owner.id,
      caseId: `REMINDERS_QUERY_CASE_${index * 2}`,
    })));
  });

  afterAll(() => app?.cleanup());

  it("checks reminder conditions with one aggregate read when no notifications are due", async () => {
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let selects = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement)) selects += 1;
      return originalPrepare(statement, ...args);
    };

    try {
      const { runRemindersForUser } = await import("../../server/reminders");
      const result = await runRemindersForUser(owner.id, new Date("2026-08-28T10:00:00Z"));
      expect(result).toEqual({ created: 0, scanned: 25 });
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(selects).toBe(1);
  });
});
