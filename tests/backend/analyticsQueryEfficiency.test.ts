import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("analytics query efficiency", () => {
  let app: TestApp;
  const owner = { id: "ANALYTICS_QUERY_OWNER", name: "Analytics owner", role: "user", email: "analytics-query@example.test" };
  const admin = { id: "ANALYTICS_QUERY_ADMIN", name: "Analytics admin", role: "admin", email: "analytics-admin@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: admin.id, email: admin.email, role: admin.role }),
      ...Array.from({ length: 10 }, (_, index) => buildUser({
        id: `ANALYTICS_RANKED_USER_${index}`,
        email: `analytics-ranked-${index}@example.test`,
      })),
    ]);
    await app.db.insert(app.schema.cases).values(Array.from({ length: 25 }, (_, index) => buildCase({
      id: `ANALYTICS_QUERY_CASE_${index}`,
      userId: owner.id,
      status: index % 2 === 0 ? "Open" : "Closed",
    })));
    await app.db.insert(app.schema.cases).values(Array.from({ length: 10 }, (_, index) => buildCase({
      id: `ANALYTICS_RANKED_CASE_${index}`,
      userId: `ANALYTICS_RANKED_USER_${index}`,
    })));
  });

  afterAll(() => app?.cleanup());

  function countSelects<T>(operation: () => Promise<T>): Promise<{ result: T; selects: number }> {
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let selects = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement)) selects += 1;
      return originalPrepare(statement, ...args);
    };
    return operation().then(
      (result) => ({ result, selects }),
      (error) => { throw error; },
    ).finally(() => { sqlite.prepare = originalPrepare; });
  }

  it("derives headline statistics in three aggregate reads", async () => {
    const { result, selects } = await countSelects(() => app.makeCaller(owner).analytics.getOverallStats());

    expect(result).toMatchObject({ totalCases: 25, activeCases: 13, closedCases: 12, totalEvidence: 0, totalOutreach: 0, responseRate: 0 });
    expect(selects).toBe(3);
  });

  it("loads owner-scoped outreach trends without materializing case IDs first", async () => {
    const { result, selects } = await countSelects(() => app.makeCaller(owner).analytics.getOutreachTrends());

    expect(result).toEqual([]);
    expect(selects).toBe(1);
  });

  it("joins ranked users and scopes outreach analytics in one read each", async () => {
    const topUsers = await countSelects(() => app.makeCaller(admin).adminAnalytics.topUsers());
    const outreach = await countSelects(() => app.makeCaller(owner).outreachAnalytics.getOverallMetrics());

    expect(topUsers.result).toHaveLength(10);
    expect(topUsers.selects).toBe(1);
    expect(outreach.result.totalOutreach).toBe(0);
    expect(outreach.selects).toBe(1);
  });
});
