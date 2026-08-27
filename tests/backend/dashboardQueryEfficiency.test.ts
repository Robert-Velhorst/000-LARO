import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildEvidence, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("dashboard query efficiency", () => {
  let app: TestApp;
  let sqlite: any;
  const owner = { id: "DASHBOARD_QUERY_OWNER", name: "Dashboard owner", role: "user", email: "dashboard-query@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    sqlite = app.db.$client;
    await app.db.insert(app.schema.users).values(buildUser({ id: owner.id, email: owner.email }));

    await app.db.insert(app.schema.cases).values(Array.from({ length: 25 }, (_, index) => buildCase({
      id: `DASHBOARD_QUERY_CASE_${index}`,
      userId: owner.id,
      clientName: `Client ${index}`,
      status: index % 2 === 0 ? "Matching" : "Outreach",
      urgency: index % 3 === 0 ? "High" : "Medium",
      legalAreas: JSON.stringify(["Administrative law"]),
      createdAt: new Date(1_700_000_000_000 + index),
    })));
    await app.db.insert(app.schema.evidence).values(Array.from({ length: 12 }, (_, index) => buildEvidence({
      id: `DASHBOARD_QUERY_EVIDENCE_${index}`,
      caseId: `DASHBOARD_QUERY_CASE_${index * 2}`,
      userId: owner.id,
      title: `Evidence ${index}`,
    })));
  });

  afterAll(() => app?.cleanup());

  it("derives next actions with a fixed read-query budget as case count grows", async () => {
    const originalPrepare = sqlite.prepare.bind(sqlite);
    const selects: string[] = [];
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement)) selects.push(statement);
      return originalPrepare(statement, ...args);
    };

    try {
      const actions = await app.makeCaller(owner).dashboard.nextActions();
      expect(actions).toHaveLength(25);
      expect(actions.filter((action: { action: string }) => action.action === "Add evidence")).toHaveLength(13);
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(selects).toHaveLength(1);
  });

  it("derives dashboard exceptions with a fixed read-query budget as case count grows", async () => {
    const originalPrepare = sqlite.prepare.bind(sqlite);
    const selects: string[] = [];
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement)) selects.push(statement);
      return originalPrepare(statement, ...args);
    };

    try {
      const result = await app.makeCaller(owner).dashboard.exceptions();
      expect(result.exceptions.some((item: { caseId: string; kind: string }) =>
        item.caseId === "DASHBOARD_QUERY_CASE_0" && item.kind === "no-evidence",
      )).toBe(false);
      expect(result.exceptions.some((item: { caseId: string; kind: string }) =>
        item.caseId === "DASHBOARD_QUERY_CASE_1" && item.kind === "no-evidence",
      )).toBe(true);
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(selects).toHaveLength(1);
  });

  it("uses composite indexes for owner-scoped dashboard aggregates", () => {
    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT cases.id, count(distinct evidence.id), count(distinct outreach_status.id)
      FROM cases
      LEFT JOIN evidence
        ON evidence.caseId = cases.id AND evidence.userId = ?
      LEFT JOIN outreach_status
        ON outreach_status.caseId = cases.id AND outreach_status.status = ?
      WHERE cases.userId = ?
      GROUP BY cases.id, cases.clientName, cases.clientEmail, cases.status,
        cases.urgency, cases.legalAreas, cases.createdAt
      ORDER BY cases.createdAt DESC
      LIMIT 100
    `).all(owner.id, "PendingApproval", owner.id).map((row: { detail: string }) => row.detail).join("\n");

    expect(plan).toContain("evidence_userId_caseId_idx");
    expect(plan).toContain("outreach_status_caseId_status_idx");
  });
});
