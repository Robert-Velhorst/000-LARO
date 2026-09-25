import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "../../server/audit";
import { setFlag } from "../../server/featureFlags";
import { sendApprovedOutreach } from "../../server/outreachSend";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("per-case collaboration invitations", () => {
  let app: TestApp;
  const OWNER = { id: "OWNER_T", name: "Owner", role: "user", email: "owner@example.com" };
  const MATE = { id: "MATE_T", name: "Mate", role: "user", email: "mate@example.com" };
  const STRANGER = { id: "STRANGER_T", name: "Stranger", role: "user", email: "stranger@example.com" };
  const CASE_ID = "CASE_TEAM";
  const OUTREACH_ID = "OUTREACH_TEAM";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(OWNER),
      buildUser(MATE),
      buildUser(STRANGER),
    ]);
    await app.db.insert(app.schema.cases).values(buildCase({ id: CASE_ID, userId: OWNER.id }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: "LAWYER_TEAM" }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: OUTREACH_ID,
      caseId: CASE_ID,
      lawyerId: "LAWYER_TEAM",
      status: "PendingApproval",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await setFlag("outreach.send.enabled", false).catch(() => undefined);
    app?.cleanup();
  });

  it("requires acceptance and enforces read, edit, approve, send, revoke, and audit boundaries", async () => {
    const owner = app.makeCaller(OWNER);
    const mate = app.makeCaller(MATE);
    const stranger = app.makeCaller(STRANGER);

    await expect(stranger.cases.export({ caseId: CASE_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const invitation = await owner.teams.invite({
      caseId: CASE_ID,
      email: MATE.email,
      role: "read_only",
      capabilities: [],
    });
    expect(invitation).toMatchObject({
      caseId: CASE_ID,
      memberId: MATE.id,
      role: "read_only",
      status: "pending",
      capabilities: ["case.read"],
    });

    // Merely knowing the case id or being invited grants no access.
    await expect(mate.cases.export({ caseId: CASE_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.teams.accept({ shareId: invitation.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await mate.teams.listInvitations()).toEqual([
      expect.objectContaining({ id: invitation.id, caseId: CASE_ID, status: "pending" }),
    ]);

    await mate.teams.accept({ shareId: invitation.id });
    await expect(mate.cases.export({ caseId: CASE_ID })).resolves.toMatchObject({
      format: "laro-case-export/v1",
      case: expect.objectContaining({ id: CASE_ID }),
    });
    await expect(mate.cases.update({ id: CASE_ID, caseSummary: "read-only mutation" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    const review = await mate.workflow.preSendReview({ outreachId: OUTREACH_ID });
    await expect(mate.workflow.approveDraft({
      outreachId: OUTREACH_ID,
      approvalHash: review.message.approvalHash,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A normal collaborator may edit, but external actions remain denied.
    await owner.teams.update({ shareId: invitation.id, role: "collaborator", capabilities: [] });
    await expect(mate.cases.update({ id: CASE_ID, caseSummary: "edited by collaborator" }))
      .resolves.toEqual({ success: true });
    await expect(mate.workflow.approveDraft({
      outreachId: OUTREACH_ID,
      approvalHash: review.message.approvalHash,
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Sending is separately and explicitly granted; approval is implied so the
    // exact immutable message snapshot must still be approved first.
    const elevated = await owner.teams.update({
      shareId: invitation.id,
      role: "collaborator",
      capabilities: ["outreach.send"],
    });
    expect(elevated.capabilities).toEqual([
      "case.read",
      "case.edit",
      "outreach.approve",
      "outreach.send",
    ]);
    await mate.workflow.approveDraft({
      outreachId: OUTREACH_ID,
      approvalHash: review.message.approvalHash,
    });
    await setFlag("outreach.send.enabled", true);
    await expect(sendApprovedOutreach(MATE.id, OUTREACH_ID, async () => ({
      delivered: true,
      provider: "test",
      providerMessageId: "msg-team",
    }))).resolves.toMatchObject({ sent: true, providerMessageId: "msg-team" });

    await owner.teams.revoke({ shareId: invitation.id });
    await expect(mate.cases.export({ caseId: CASE_ID })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(stranger.cases.update({ id: CASE_ID, caseSummary: "blocked" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    const auditRows = await app.db.select().from(app.schema.auditLogs);
    const actions = auditRows.map((row: any) => row.action);
    expect(actions).toEqual(expect.arrayContaining([
      AUDIT_ACTIONS.CASE_SHARE_INVITED,
      AUDIT_ACTIONS.CASE_SHARE_ACCEPTED,
      AUDIT_ACTIONS.CASE_SHARE_UPDATED,
      AUDIT_ACTIONS.CASE_SHARE_REVOKED,
    ]));
    const shares = await owner.teams.listShares({ caseId: CASE_ID });
    expect(shares).toEqual([expect.objectContaining({ id: invitation.id, status: "revoked" })]);
  });
});
