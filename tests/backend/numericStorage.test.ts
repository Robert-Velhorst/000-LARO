import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  calculateAverageResponseTime,
  updateLawyerStatistics,
} from "../../server/db";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("canonical numeric storage", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({
      id: "NUMERIC_RUNTIME_OWNER",
      email: "numeric-runtime@example.test",
    }));
    await app.db.insert(app.schema.cases).values([
      buildCase({ id: "NUMERIC_RUNTIME_CASE_A", userId: "NUMERIC_RUNTIME_OWNER" }),
      buildCase({ id: "NUMERIC_RUNTIME_CASE_B", userId: "NUMERIC_RUNTIME_OWNER" }),
    ]);
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "NUMERIC_RUNTIME_LAWYER",
    }));
    await app.db.insert(app.schema.outreachStatus).values([
      {
        id: "NUMERIC_RUNTIME_OUTREACH_A",
        caseId: "NUMERIC_RUNTIME_CASE_A",
        lawyerId: "NUMERIC_RUNTIME_LAWYER",
        status: "Interested",
        acceptanceStatus: "Accepted",
        responseTimeHours: 1.25,
      },
      {
        id: "NUMERIC_RUNTIME_OUTREACH_B",
        caseId: "NUMERIC_RUNTIME_CASE_B",
        lawyerId: "NUMERIC_RUNTIME_LAWYER",
        status: "Declined",
        responseTimeHours: 2.5,
      },
    ]);
  });

  afterAll(() => app?.cleanup());

  it("preserves fractional response hours and writes aggregate counts as numbers", async () => {
    expect(await calculateAverageResponseTime("NUMERIC_RUNTIME_LAWYER")).toBe(1.875);

    await updateLawyerStatistics("NUMERIC_RUNTIME_LAWYER");
    const [lawyer] = await app.db.select().from(app.schema.lawyers)
      .where(eq(app.schema.lawyers.id, "NUMERIC_RUNTIME_LAWYER"));
    expect(lawyer).toMatchObject({
      totalOutreaches: 2,
      totalResponses: 2,
      totalAcceptances: 1,
      averageResponseTimeHours: 1.875,
    });

    const sqlite = (app.db as any).$client ?? (app.db as any).session?.client;
    expect(sqlite.prepare(`
      SELECT typeof(totalOutreaches) AS countType,
             typeof(averageResponseTimeHours) AS durationType
      FROM lawyers WHERE id = ?
    `).get("NUMERIC_RUNTIME_LAWYER")).toEqual({ countType: "integer", durationType: "real" });
  });
});
