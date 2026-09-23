import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildLawyer, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("canonical lawyer comparison", () => {
  let app: TestApp;
  const owner = { id: "COMPARE_OWNER", email: "compare-owner@example.test", name: "Comparison Owner", role: "user" };
  const other = { id: "COMPARE_OTHER", email: "compare-other@example.test", name: "Other Owner", role: "user" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    await app.db.insert(app.schema.cases).values([
      buildCase({
        id: "COMPARE_CASE",
        userId: owner.id,
        clientName: "Comparison Client",
        legalAreas: JSON.stringify(["Employment Law"]),
        preferredLanguages: JSON.stringify(["Dutch"]),
      }),
      buildCase({ id: "COMPARE_FOREIGN_CASE", userId: other.id, legalAreas: JSON.stringify(["Employment Law"]) }),
    ]);
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({
        id: "COMPARE_CURRENT",
        name: "Current Shape Lawyer",
        firmName: "Current Firm",
        legalAreas: JSON.stringify([{ area: "Employment Law" }, "Civil Law"]),
        languages: JSON.stringify(["Dutch", "English"]),
        experienceYears: 12,
        currentlyAccepting: "Yes",
        caseLoad: 6,
        capacityPercentage: 25,
        averageResponseTimeHours: 36,
        totalOutreaches: 10,
        totalResponses: 8,
        totalAcceptances: 4,
      }),
      buildLawyer({
        id: "COMPARE_LEGACY",
        name: "Legacy Shape Lawyer",
        firm: "Legacy Firm",
        firmName: null,
        legalAreas: "Employment Law; Social Security Law",
        languages: "Dutch | English",
        experienceYears: null,
        currentlyAccepting: "Limited",
        caseLoad: null,
        capacityPercentage: null,
        averageResponseTimeHours: null,
        totalOutreaches: 0,
        totalResponses: 4,
        totalAcceptances: 9,
      }),
    ]);
  });

  afterAll(() => app?.cleanup());

  it("normalizes current and legacy rows into documented fields and units", async () => {
    const result = await app.makeCaller(owner).lawyers.compare({
      lawyerIds: ["COMPARE_CURRENT", "COMPARE_LEGACY"],
    });

    expect(result.matchStatus).toBe("not_selected");
    expect(result.matchScoreMax).toBeNull();
    expect(result.missingCount).toBe(0);
    expect(result.lawyers).toHaveLength(2);
    expect(result.lawyers[0]).toMatchObject({
      id: "COMPARE_CURRENT",
      firm: "Current Firm",
      legalAreas: ["Employment Law", "Civil Law"],
      languages: ["Dutch", "English"],
      experienceYears: 12,
      availability: "accepting",
      availabilityLabel: "Accepting new cases",
      caseLoad: 6,
      capacityPercent: 25,
      averageResponseHours: 36,
      responseRate: { percent: 80, numerator: 8, denominator: 10 },
      acceptanceRate: { percent: 50, numerator: 4, denominator: 8 },
      caseMatch: null,
    });
    expect(result.lawyers[1]).toMatchObject({
      id: "COMPARE_LEGACY",
      firm: "Legacy Firm",
      legalAreas: ["Employment Law", "Social Security Law"],
      languages: ["Dutch", "English"],
      experienceYears: null,
      availability: "limited",
      caseLoad: null,
      capacityPercent: null,
      averageResponseHours: null,
      responseRate: null,
      acceptanceRate: null,
      caseMatch: null,
    });
  });

  it("only returns canonical 230-point matches when an owned case is selected", async () => {
    const result = await app.makeCaller(owner).lawyers.compare({
      lawyerIds: ["COMPARE_CURRENT", "COMPARE_LEGACY"],
      caseId: "COMPARE_CASE",
    });

    expect(result.matchStatus).toBe("available");
    expect(result.matchScoreMax).toBe(230);
    for (const lawyer of result.lawyers) {
      expect(lawyer.caseMatch).toMatchObject({ maxScore: 230 });
      expect(lawyer.caseMatch!.score).toBeGreaterThanOrEqual(0);
      expect(lawyer.caseMatch!.score).toBeLessThanOrEqual(230);
      expect(lawyer.caseMatch!.percent).toBe(Math.round((lawyer.caseMatch!.score / 230) * 100));
    }

    // Comparison is read-only; outreach must still go through its maintained,
    // explicitly reviewed workflow.
    expect(await app.db.select().from(app.schema.outreachStatus)).toEqual([]);
  });

  it("reports deleted selections generically and rejects a foreign case context", async () => {
    const missing = await app.makeCaller(owner).lawyers.compare({
      lawyerIds: ["COMPARE_CURRENT", "COMPARE_MISSING"],
    });
    expect(missing.missingCount).toBe(1);
    expect(missing.lawyers.map((lawyer: { id: string }) => lawyer.id)).toEqual(["COMPARE_CURRENT"]);

    await expect(app.makeCaller(owner).lawyers.compare({
      lawyerIds: ["COMPARE_CURRENT", "COMPARE_LEGACY"],
      caseId: "COMPARE_FOREIGN_CASE",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
