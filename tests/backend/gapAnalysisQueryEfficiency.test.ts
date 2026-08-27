import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("gap analysis query efficiency", () => {
  let app: TestApp;
  const owner = { id: "GAP_QUERY_OWNER", name: "Gap owner", role: "user", email: "gap-query@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: owner.id, email: owner.email }));
    await app.db.insert(app.schema.cases).values(Array.from({ length: 25 }, (_, index) => buildCase({
      id: `GAP_QUERY_CASE_${index}`,
      userId: owner.id,
    })));
  });

  afterAll(() => app?.cleanup());

  it("loads all case gap summaries with a fixed three-read budget", async () => {
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let selects = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement)) selects += 1;
      return originalPrepare(statement, ...args);
    };

    try {
      const result = await app.makeCaller(owner).gapAnalysis.getUserCriticalGaps();
      expect(result).toMatchObject({ totalCriticalGaps: 0, totalMissingDocs: 0, casesAffected: 0, topCases: [] });
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(selects).toBe(3);
  });

  it("preserves critical-gap and missing-document aggregation", async () => {
    await app.db.insert(app.schema.communicationGaps).values({
      id: "GAP_QUERY_CRITICAL",
      caseId: "GAP_QUERY_CASE_0",
      data: JSON.stringify({ significance: "critical", durationDays: "42" }),
      createdAt: new Date(),
    });
    await app.db.insert(app.schema.expectedDocuments).values({
      id: "GAP_QUERY_MISSING_DOCUMENT",
      caseId: "GAP_QUERY_CASE_0",
      data: JSON.stringify({ status: "missing" }),
      createdAt: new Date(),
    });

    const result = await app.makeCaller(owner).gapAnalysis.getUserCriticalGaps();

    expect(result).toMatchObject({ totalCriticalGaps: 1, totalMissingDocs: 1, casesAffected: 1 });
    expect(result.topCases[0]).toMatchObject({
      caseId: "GAP_QUERY_CASE_0",
      criticalGaps: 1,
      missingDocs: 1,
      oldestGapDays: 42,
      totalSeverity: 15,
    });
  });
});
