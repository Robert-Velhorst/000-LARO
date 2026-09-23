import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildEvidence, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("canonical Home dashboard summary", () => {
  let app: TestApp;
  const owner = { id: "DASHBOARD_SUMMARY_OWNER", name: "Dashboard owner", role: "user", email: "dashboard-owner@example.test" };
  const emptyOwner = { id: "DASHBOARD_SUMMARY_EMPTY", name: "Empty owner", role: "user", email: "dashboard-empty@example.test" };
  const other = { id: "DASHBOARD_SUMMARY_OTHER", name: "Other owner", role: "user", email: "dashboard-other@example.test" };
  const workflowCaseId = "DASHBOARD_SUMMARY_WORKFLOW";
  const urgentCaseId = "DASHBOARD_SUMMARY_URGENT";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(owner),
      buildUser(emptyOwner),
      buildUser(other),
    ]);
    await app.db.insert(app.schema.cases).values([
      buildCase({
        id: workflowCaseId,
        userId: owner.id,
        clientName: "Workflow matter",
        status: "Outreach",
        urgency: "Medium",
        legalAreas: JSON.stringify(["Employment Law", "Contract Law"]),
        createdAt: new Date("2026-01-01T09:00:00.000Z"),
        updatedAt: new Date("2026-01-01T09:00:00.000Z"),
      }),
      buildCase({
        id: urgentCaseId,
        userId: owner.id,
        clientName: "Urgent evidence gap",
        status: "Intake",
        urgency: "High",
        legalAreas: JSON.stringify(["Administrative Law"]),
        createdAt: new Date("2026-01-02T09:00:00.000Z"),
        updatedAt: new Date("2026-01-02T09:00:00.000Z"),
      }),
      buildCase({
        id: "DASHBOARD_SUMMARY_FOREIGN",
        userId: other.id,
        clientName: "Foreign matter",
        createdAt: new Date("2026-04-01T09:00:00.000Z"),
        updatedAt: new Date("2026-04-01T09:00:00.000Z"),
      }),
    ]);
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "DASHBOARD_SUMMARY_EVIDENCE",
      caseId: workflowCaseId,
      userId: owner.id,
      title: "Owned evidence",
    }));
    await app.db.insert(app.schema.lawyers).values([
      "LAWYER_DRAFT",
      "LAWYER_REJECTED",
      "LAWYER_APPROVED",
      "LAWYER_SENT",
      "LAWYER_INTERESTED",
      "LAWYER_FAILED",
      "LAWYER_FOREIGN",
    ].map(id => buildLawyer({ id })));
    await app.db.insert(app.schema.outreachStatus).values([
      { id: "DASHBOARD_DRAFT", caseId: workflowCaseId, lawyerId: "LAWYER_DRAFT", status: "PendingApproval", updatedAt: new Date("2026-02-01T09:00:00.000Z") },
      { id: "DASHBOARD_REJECTED", caseId: workflowCaseId, lawyerId: "LAWYER_REJECTED", status: "Rejected", updatedAt: new Date("2026-02-02T09:00:00.000Z") },
      { id: "DASHBOARD_APPROVED", caseId: workflowCaseId, lawyerId: "LAWYER_APPROVED", status: "Approved", updatedAt: new Date("2026-02-03T09:00:00.000Z") },
      { id: "DASHBOARD_SENT", caseId: workflowCaseId, lawyerId: "LAWYER_SENT", status: "Sent", updatedAt: new Date("2026-02-04T09:00:00.000Z") },
      { id: "DASHBOARD_INTERESTED", caseId: workflowCaseId, lawyerId: "LAWYER_INTERESTED", status: "Interested", updatedAt: new Date("2026-03-01T09:00:00.000Z") },
      { id: "DASHBOARD_FAILED", caseId: workflowCaseId, lawyerId: "LAWYER_FAILED", status: "Failed", updatedAt: new Date("2026-02-05T09:00:00.000Z") },
      { id: "DASHBOARD_FOREIGN_INTERESTED", caseId: "DASHBOARD_SUMMARY_FOREIGN", lawyerId: "LAWYER_FOREIGN", status: "Interested", updatedAt: new Date("2026-04-01T09:00:00.000Z") },
    ]);
    await app.db.insert(app.schema.emailActivity).values([
      {
        id: "DASHBOARD_SENT_ACTIVITY",
        caseId: workflowCaseId,
        lawyerId: "LAWYER_SENT",
        activityType: "sent",
        subject: "Workflow outreach sent",
        sentAt: new Date("2026-02-04T09:00:00.000Z"),
      },
      {
        id: "DASHBOARD_FOREIGN_ACTIVITY",
        caseId: "DASHBOARD_SUMMARY_FOREIGN",
        lawyerId: "LAWYER_FOREIGN",
        activityType: "sent",
        subject: "Foreign secret",
        sentAt: new Date("2026-04-01T09:00:00.000Z"),
      },
    ]);
  });

  afterAll(() => app?.cleanup());

  it("keeps draft, approved-unsent, sent, responded, and interested states distinct", async () => {
    const summary = await app.makeCaller(owner).dashboard.summary();
    expect(summary).toMatchObject({
      availability: "available",
      metrics: {
        activeCases: 2,
        evidenceCollected: 1,
        matchesMade: 2,
        outreach: {
          suggested: 6,
          drafted: 1,
          approved: 1,
          sent: 2,
          responded: 1,
          interested: 1,
          rejected: 1,
          failed: 1,
        },
      },
    });
    expect(summary.metrics?.outreach.sent).not.toBe(summary.metrics?.outreach.suggested);
    await expect(app.makeCaller(owner).dashboard.stats()).resolves.toMatchObject({ matchesMade: 2 });
  });

  it("combines maintained actions, exceptions, and clarifications as typed entries", async () => {
    const summary = await app.makeCaller(owner).dashboard.summary();
    expect(summary.actionCounts).toEqual({ total: 5, nextAction: 2, exception: 2, clarification: 1 });
    expect(summary.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "exception", caseId: urgentCaseId, title: "no-evidence", priority: "high" }),
      expect.objectContaining({ type: "next_action", caseId: urgentCaseId, title: "Add evidence", priority: "high" }),
      expect.objectContaining({ type: "exception", caseId: workflowCaseId, title: "awaiting-approval" }),
      expect.objectContaining({ type: "clarification", caseId: workflowCaseId }),
    ]));
    expect(summary.actions.every((item: { destination: string }) => /^\/cases\?case=/.test(item.destination))).toBe(true);
  });

  it("returns only owner-scoped canonical activity with event and case identities", async () => {
    const summary = await app.makeCaller(owner).dashboard.summary();
    expect(summary.activity[0]).toMatchObject({
      type: "outreach_response",
      caseId: workflowCaseId,
      caseTitle: "Workflow matter",
      status: "Interested",
      destination: `/cases?case=${workflowCaseId}`,
    });
    expect(summary.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "outreach_sent", caseId: workflowCaseId, detail: "Workflow outreach sent" }),
      expect.objectContaining({ type: "case_created", caseId: urgentCaseId }),
    ]));
    expect(summary.activity.some((item: { caseId: string; detail: string | null }) =>
      item.caseId === "DASHBOARD_SUMMARY_FOREIGN" || item.detail === "Foreign secret",
    )).toBe(false);
    expect(summary.activity.some((item: { id: string }) => item.id.includes("DASHBOARD_DRAFT") || item.id.includes("DASHBOARD_APPROVED"))).toBe(false);
  });

  it("reports measured zero instead of unavailable when the owned dataset is empty", async () => {
    const summary = await app.makeCaller(emptyOwner).dashboard.summary();
    expect(summary).toMatchObject({
      availability: "available",
      metrics: {
        activeCases: 0,
        evidenceCollected: 0,
        outreach: { suggested: 0, drafted: 0, approved: 0, sent: 0, responded: 0, interested: 0 },
      },
      actionCounts: { total: 0, nextAction: 0, exception: 0, clarification: 0 },
      actions: [],
      activity: [],
    });
    expect(summary.definitions.outreachSent).toMatch(/Sent, Interested, Declined, or NoResponse/);
  });
});
