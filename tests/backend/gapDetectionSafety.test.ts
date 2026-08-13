import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("gap analysis evidence safety", () => {
  let app: TestApp;
  const owner = { id: "USR_GAP_SAFETY", name: "Owner", role: "user", email: "gap-safety@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_GAP_SAFETY",
      userId: owner.id,
      caseType: "Employment termination",
    }));
    const start = new Date(Date.now() - 45 * 86_400_000);
    await app.db.insert(app.schema.timeline).values([
      {
        id: "GAP_EVENT_START",
        caseId: "CASE_GAP_SAFETY",
        userId: owner.id,
        eventType: "request",
        title: "Termination records request",
        description: "Requested records after termination",
        eventAt: start,
        metadata: JSON.stringify({ source: "document" }),
        createdAt: start,
      },
      {
        id: "GAP_EVENT_END",
        caseId: "CASE_GAP_SAFETY",
        userId: owner.id,
        eventType: "event",
        title: "Later case event",
        eventAt: new Date(),
        metadata: JSON.stringify({ source: "document" }),
        createdAt: new Date(),
      },
    ]);
  });

  afterAll(() => app?.cleanup());

  it("treats gaps as review questions and never fabricates legal authority or motive", async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.gapAnalysis.analyze({ caseId: "CASE_GAP_SAFETY" });
    const serialized = JSON.stringify(first);
    expect(first.expectedDocs.length).toBeGreaterThan(0);
    expect(first.patterns).toEqual(expect.arrayContaining([
      expect.objectContaining({ patternType: "missing_expected_documents" }),
    ]));
    expect(first.inferences.every((inference: any) => inference.strength === "review_required")).toBe(true);
    expect(first.inferences.every((inference: any) => JSON.parse(inference.caselaw).length === 0)).toBe(true);
    expect(first.caseStrength.legalBasisScore).toBe(0);
    expect(serialized).not.toMatch(/ECLI:|spoliation|demonstrates bad faith|consciousness of wrongdoing/i);
    expect(serialized).toContain("does not establish motive");

    const second = await caller.gapAnalysis.analyze({ caseId: "CASE_GAP_SAFETY" });
    expect(second.patterns.map((pattern: any) => pattern.patternType)).toEqual(
      first.patterns.map((pattern: any) => pattern.patternType),
    );
    await expect(caller.gapAnalysis.getCaseStrength({ caseId: "CASE_GAP_SAFETY" }))
      .resolves.toMatchObject({ legalBasisScore: 0 });
  });
});
