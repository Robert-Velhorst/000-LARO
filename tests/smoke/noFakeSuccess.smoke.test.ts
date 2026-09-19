/**
 * Truthful-result smoke contracts.
 *
 * Each assertion enters through the real application router and observes real
 * migrated persistence or a deliberately unavailable provider. Keeping a
 * function name or canned literal in source is therefore insufficient to pass.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("truthful product results through live routes", () => {
  let app: TestApp;
  const owner = { id: "TRUTH_OWNER", name: "Truth owner", role: "user", email: "truth-owner@example.test" };
  const other = { id: "TRUTH_OTHER", name: "Other owner", role: "user", email: "truth-other@example.test" };
  const ownerCase = buildCase({
    id: "TRUTH_CASE",
    userId: owner.id,
    clientName: "Real Client",
    legalAreas: JSON.stringify(["Employment Law"]),
  });
  const otherCase = buildCase({
    id: "TRUTH_OTHER_CASE",
    userId: other.id,
    clientName: "Other Client",
    legalAreas: JSON.stringify(["Employment Law"]),
  });

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    await app.db.insert(app.schema.cases).values([ownerCase, otherCase]);
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "TRUTH_EMPLOYMENT_LAWYER", legalAreas: JSON.stringify(["Employment Law"]) }),
      buildLawyer({ id: "TRUTH_FAMILY_LAWYER", legalAreas: JSON.stringify(["Family Law"]) }),
    ]);
    await app.db.insert(app.schema.outreachStatus).values([
      {
        id: "TRUTH_OUTREACH_INTERESTED",
        caseId: ownerCase.id,
        lawyerId: "TRUTH_EMPLOYMENT_LAWYER",
        status: "Interested",
        response: "Available",
        responseTimeHours: "12",
      },
      {
        id: "TRUTH_OUTREACH_CONTACTED",
        caseId: ownerCase.id,
        lawyerId: "TRUTH_FAMILY_LAWYER",
        status: "Contacted",
        responseTimeHours: "36",
      },
    ]);
    await app.db.insert(app.schema.emailActivity).values({
      id: "TRUTH_ACTIVITY",
      caseId: ownerCase.id,
      lawyerId: "TRUTH_EMPLOYMENT_LAWYER",
      activityType: "sent",
      subject: "Evidence-based outreach",
      sentAt: new Date("2026-09-19T08:00:00.000Z"),
    });
  });

  afterAll(() => app?.cleanup());

  it("returns stable lawyer matches from case and lawyer records", async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.matching.findLawyers({ caseId: ownerCase.id });
    const second = await caller.matching.findLawyers({ caseId: ownerCase.id });

    expect(first.map((match: { id: string }) => match.id)).toEqual(["TRUTH_EMPLOYMENT_LAWYER"]);
    expect(first.map((match: { id: string; matchScore: number }) => [match.id, match.matchScore]))
      .toEqual(second.map((match: { id: string; matchScore: number }) => [match.id, match.matchScore]));
    expect(first[0].matchScore).toBeGreaterThan(0);
  });

  it("derives dashboard metrics from the caller's persisted rows", async () => {
    const ownerStats = await app.makeCaller(owner).dashboard.enhancedStats();
    const otherStats = await app.makeCaller(other).dashboard.enhancedStats();
    expect(ownerStats).toEqual({
      caseVolume: { current: 1, change: 0 },
      responseRate: { current: 50, change: 0 },
      averageMatchingScore: { current: 0, change: 0 },
      outreachEfficiency: { current: 50, change: 0 },
    });
    expect(otherStats.caseVolume.current).toBe(1);
    expect(otherStats.responseRate.current).toBe(0);
  });

  it("builds the activity feed from owned cases and email activity", async () => {
    const feed = await app.makeCaller(owner).dashboard.activityFeed({ limit: 10 });
    expect(feed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: `case-${ownerCase.id}`, title: "Case created for Real Client" }),
      expect.objectContaining({ id: "outreach-TRUTH_ACTIVITY", title: "Outreach: Evidence-based outreach" }),
    ]));
    expect(feed.some((item: { title: string }) => item.title.includes("Other Client"))).toBe(false);
  });

  it("computes outreach progress from the case's current outreach rows", async () => {
    const progress = await app.makeCaller(owner).cases.outreachProgress({ caseId: ownerCase.id });
    expect(progress.legalAreas).toEqual([
      expect.objectContaining({ name: "Employment Law", status: "In Progress" }),
    ]);
    expect(progress.overallStats).toEqual({
      totalContacted: 2,
      totalResponses: 1,
      avgResponseTime: "24h",
    });
  });

  it("rejects invalid OCR bytes instead of returning fabricated extraction text", async () => {
    await expect(app.makeCaller(owner).ocr.extractText({
      image: "data:application/pdf;base64,AAAA",
      language: "nld",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("reports an unavailable provider honestly at its mounted lifecycle route", async () => {
    const caller = app.makeCaller(owner);
    await expect(caller.providerConnections.availability({ provider: "outlook" }))
      .resolves.toMatchObject({ available: false, reason: expect.stringMatching(/not release-capable/i) });
    await expect(caller.providerConnections.begin({ provider: "outlook" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

});
