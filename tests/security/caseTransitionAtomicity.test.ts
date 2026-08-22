import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { compareAndSetCaseStatus } from "../../server/caseTransitions";
import { linkInboundOutreachReply } from "../../server/inboundOutreach";
import { sendApprovedOutreach } from "../../server/outreachSend";
import { setFlag } from "../../server/featureFlags";

const suite = sqliteAvailable ? describe : describe.skip;

suite("atomic case status transitions", () => {
  let app: TestApp;
  const owner = { id: "CASE_TRANSITION_OWNER", role: "user", email: "transition-owner@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
  });

  afterAll(() => app?.cleanup());

  function rejectAuditAction(action: string, triggerName: string): () => void {
    const sqlite = app.db.$client;
    sqlite.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = '${action}'
      BEGIN
        SELECT RAISE(ABORT, 'injected audit failure');
      END;
    `);
    return () => sqlite.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  }

  it("allows only one transition from the same observed status", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_TRANSITION_RACE",
      userId: owner.id,
      status: "Matching",
    }));

    const attempts = await Promise.allSettled([
      compareAndSetCaseStatus(app.db, {
        caseId: "CASE_TRANSITION_RACE",
        ownerId: owner.id,
        expectedStatus: "Matching",
        nextStatus: "Outreach",
      }),
      compareAndSetCaseStatus(app.db, {
        caseId: "CASE_TRANSITION_RACE",
        ownerId: owner.id,
        expectedStatus: "Matching",
        nextStatus: "Closed",
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const [stored] = await app.db
      .select({ status: app.schema.cases.status })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_TRANSITION_RACE"));
    expect(["Outreach", "Closed"]).toContain(stored.status);
  });

  it("routes both public case transition paths through compare-and-set", async () => {
    await app.db.insert(app.schema.cases).values([
      buildCase({ id: "CASE_TRANSITION_PRIMARY", userId: owner.id, status: "Matching" }),
      buildCase({ id: "CASE_TRANSITION_MANAGEMENT", userId: owner.id, status: "Matching" }),
    ]);

    const caller = app.makeCaller(owner);
    await expect(caller.cases.update({
      id: "CASE_TRANSITION_PRIMARY",
      status: "Outreach",
    })).resolves.toEqual({ success: true });
    await expect(caller.caseManagement.updateStatus({
      caseId: "CASE_TRANSITION_MANAGEMENT",
      status: "Closed",
    })).resolves.toEqual({ ok: true, status: "Closed" });
  });

  it("does not let concurrent outreach responses overwrite each other", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_RESPONSE_RACE",
      userId: owner.id,
      status: "Outreach",
    }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "OUTREACH_RESPONSE_RACE",
      caseId: "CASE_RESPONSE_RACE",
      status: "Sent",
      initialContact: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const caller = app.makeCaller(owner);
    const attempts = await Promise.allSettled([
      caller.workflow.recordResponse({ outreachId: "OUTREACH_RESPONSE_RACE", response: "Interested" }),
      caller.workflow.recordResponse({ outreachId: "OUTREACH_RESPONSE_RACE", response: "Declined" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);

    const [stored] = await app.db
      .select({ status: app.schema.outreachStatus.status })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "OUTREACH_RESPONSE_RACE"));
    expect(["Interested", "Declined"]).toContain(stored.status);
  });

  it("rolls back the outreach response when its case transition is no longer valid", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_RESPONSE_ROLLBACK",
      userId: owner.id,
      status: "Closed",
    }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "OUTREACH_RESPONSE_ROLLBACK",
      caseId: "CASE_RESPONSE_ROLLBACK",
      status: "Sent",
      initialContact: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(app.makeCaller(owner).workflow.recordResponse({
      outreachId: "OUTREACH_RESPONSE_ROLLBACK",
      response: "Interested",
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const [stored] = await app.db
      .select({ status: app.schema.outreachStatus.status })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "OUTREACH_RESPONSE_ROLLBACK"));
    expect(stored.status).toBe("Sent");
  });

  it("does not move a case to Outreach when no draft candidate exists", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_OUTREACH_NO_MATCH",
      userId: owner.id,
      caseType: "Unmatched specialist area",
      legalAreas: JSON.stringify(["Unmatched specialist area"]),
      status: "Matching",
    }));

    const result = await app.makeCaller(owner).workflow.initiateOutreach({
      caseId: "CASE_OUTREACH_NO_MATCH",
      maxResults: 5,
    });
    expect(result.candidates).toBe(0);
    expect(result.statusChanged).toBe(false);

    const [stored] = await app.db
      .select({ status: app.schema.cases.status })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_OUTREACH_NO_MATCH"));
    expect(stored.status).toBe("Matching");
  });

  it("rolls back a case transition when its required audit record cannot be written", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_AUDIT_ROLLBACK",
      userId: owner.id,
      status: "Matching",
    }));
    const releaseFailure = rejectAuditAction("case.status_changed", "reject_case_transition_audit");
    try {
      await expect(app.makeCaller(owner).cases.update({
        id: "CASE_AUDIT_ROLLBACK",
        status: "Outreach",
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const [stored] = await app.db
      .select({ status: app.schema.cases.status })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_AUDIT_ROLLBACK"));
    expect(stored.status).toBe("Matching");
  });

  it("rolls back case creation when its required audit record cannot be written", async () => {
    const releaseFailure = rejectAuditAction("case.created", "reject_case_creation_audit");
    try {
      await expect(app.makeCaller(owner).cases.create({
        clientName: "Audit creation rollback",
        clientEmail: "audit-create@example.com",
        caseType: "Employment",
        caseSummary: "Employment agreement review and dismissal dispute.",
        urgency: "Medium",
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const stored = await app.db
      .select({ id: app.schema.cases.id })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.clientEmail, "audit-create@example.com"));
    expect(stored).toHaveLength(0);
  });

  it("rolls back case detail updates when their required audit record cannot be written", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_DETAILS_AUDIT_ROLLBACK",
      userId: owner.id,
      caseSummary: "Original summary",
    }));
    const releaseFailure = rejectAuditAction("case.updated", "reject_case_details_audit");
    try {
      await expect(app.makeCaller(owner).cases.update({
        id: "CASE_DETAILS_AUDIT_ROLLBACK",
        caseSummary: "Changed summary",
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const [stored] = await app.db
      .select({ caseSummary: app.schema.cases.caseSummary })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_DETAILS_AUDIT_ROLLBACK"));
    expect(stored.caseSummary).toBe("Original summary");
  });

  it("rolls back case deletion when its required audit record cannot be written", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_DELETE_AUDIT_ROLLBACK",
      userId: owner.id,
    }));
    const releaseFailure = rejectAuditAction("case.deleted", "reject_case_delete_audit");
    try {
      await expect(app.makeCaller(owner).cases.delete({
        id: "CASE_DELETE_AUDIT_ROLLBACK",
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const stored = await app.db
      .select({ id: app.schema.cases.id })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_DELETE_AUDIT_ROLLBACK"));
    expect(stored).toHaveLength(1);
  });

  it("rolls back an interested response when its required audit record cannot be written", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_RESPONSE_AUDIT_ROLLBACK",
      userId: owner.id,
      status: "Outreach",
    }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "OUTREACH_RESPONSE_AUDIT_ROLLBACK",
      caseId: "CASE_RESPONSE_AUDIT_ROLLBACK",
      status: "Sent",
      initialContact: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const releaseFailure = rejectAuditAction("email.response_received", "reject_response_audit");
    try {
      await expect(app.makeCaller(owner).workflow.recordResponse({
        outreachId: "OUTREACH_RESPONSE_AUDIT_ROLLBACK",
        response: "Interested",
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const [outreach] = await app.db
      .select({ status: app.schema.outreachStatus.status })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "OUTREACH_RESPONSE_AUDIT_ROLLBACK"));
    const [caseRow] = await app.db
      .select({ status: app.schema.cases.status })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_RESPONSE_AUDIT_ROLLBACK"));
    expect(outreach.status).toBe("Sent");
    expect(caseRow.status).toBe("Outreach");
  });

  it("rolls back outreach initiation and draft creation when its audit cannot be written", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_INIT_AUDIT_ROLLBACK",
      userId: owner.id,
      status: "Matching",
    }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: "LAWYER_INIT_AUDIT_ROLLBACK" }));
    const releaseFailure = rejectAuditAction("outreach.initiated", "reject_initiation_audit");
    try {
      await expect(app.makeCaller(owner).workflow.initiateOutreach({
        caseId: "CASE_INIT_AUDIT_ROLLBACK",
        maxResults: 1,
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const [caseRow] = await app.db
      .select({ status: app.schema.cases.status })
      .from(app.schema.cases)
      .where(eq(app.schema.cases.id, "CASE_INIT_AUDIT_ROLLBACK"));
    const drafts = await app.db
      .select({ id: app.schema.outreachStatus.id })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.caseId, "CASE_INIT_AUDIT_ROLLBACK"));
    expect(caseRow.status).toBe("Matching");
    expect(drafts).toHaveLength(0);
  });

  it("rolls back draft approval when its audit cannot be written", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_APPROVAL_AUDIT_ROLLBACK",
      userId: owner.id,
      status: "Outreach",
    }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: "LAWYER_APPROVAL_AUDIT_ROLLBACK" }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "OUTREACH_APPROVAL_AUDIT_ROLLBACK",
      caseId: "CASE_APPROVAL_AUDIT_ROLLBACK",
      lawyerId: "LAWYER_APPROVAL_AUDIT_ROLLBACK",
      status: "PendingApproval",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const caller = app.makeCaller(owner);
    const review = await caller.workflow.preSendReview({ outreachId: "OUTREACH_APPROVAL_AUDIT_ROLLBACK" });
    const releaseFailure = rejectAuditAction("outreach.status_changed", "reject_approval_audit");
    try {
      await expect(caller.workflow.approveDraft({
        outreachId: "OUTREACH_APPROVAL_AUDIT_ROLLBACK",
        approvalHash: review.message.approvalHash,
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const [stored] = await app.db
      .select({ status: app.schema.outreachStatus.status })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "OUTREACH_APPROVAL_AUDIT_ROLLBACK"));
    expect(stored.status).toBe("PendingApproval");
  });

  it("rolls back every draft when one audit in a batch approval fails", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_BATCH_AUDIT_ROLLBACK",
      userId: owner.id,
      status: "Outreach",
    }));
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({ id: "LAWYER_BATCH_AUDIT_ONE" }),
      buildLawyer({ id: "LAWYER_BATCH_AUDIT_TWO" }),
    ]);
    await app.db.insert(app.schema.outreachStatus).values([
      {
        id: "OUTREACH_BATCH_AUDIT_ONE",
        caseId: "CASE_BATCH_AUDIT_ROLLBACK",
        lawyerId: "LAWYER_BATCH_AUDIT_ONE",
        status: "PendingApproval",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "OUTREACH_BATCH_AUDIT_TWO",
        caseId: "CASE_BATCH_AUDIT_ROLLBACK",
        lawyerId: "LAWYER_BATCH_AUDIT_TWO",
        status: "PendingApproval",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const caller = app.makeCaller(owner);
    const firstReview = await caller.workflow.preSendReview({ outreachId: "OUTREACH_BATCH_AUDIT_ONE" });
    const secondReview = await caller.workflow.preSendReview({ outreachId: "OUTREACH_BATCH_AUDIT_TWO" });
    const sqlite = app.db.$client;
    sqlite.exec(`
      CREATE TRIGGER reject_second_batch_approval_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'outreach.status_changed'
        AND NEW.entityId = 'OUTREACH_BATCH_AUDIT_TWO'
      BEGIN
        SELECT RAISE(ABORT, 'injected batch audit failure');
      END;
    `);
    try {
      await expect(caller.workflow.approveDrafts({ approvals: [
        { outreachId: "OUTREACH_BATCH_AUDIT_ONE", approvalHash: firstReview.message.approvalHash },
        { outreachId: "OUTREACH_BATCH_AUDIT_TWO", approvalHash: secondReview.message.approvalHash },
      ] })).rejects.toThrow();
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS reject_second_batch_approval_audit");
    }

    const rows = await app.db
      .select({ id: app.schema.outreachStatus.id, status: app.schema.outreachStatus.status })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.caseId, "CASE_BATCH_AUDIT_ROLLBACK"));
    expect(rows).toEqual(expect.arrayContaining([
      { id: "OUTREACH_BATCH_AUDIT_ONE", status: "PendingApproval" },
      { id: "OUTREACH_BATCH_AUDIT_TWO", status: "PendingApproval" },
    ]));
  });

  it("rolls back Gmail reply linking when its required audit cannot be written", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_INBOUND_AUDIT_ROLLBACK",
      userId: owner.id,
      status: "Outreach",
    }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "LAWYER_INBOUND_AUDIT_ROLLBACK",
      email: "inbound-audit@example.com",
    }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "OUTREACH_INBOUND_AUDIT_ROLLBACK",
      caseId: "CASE_INBOUND_AUDIT_ROLLBACK",
      lawyerId: "LAWYER_INBOUND_AUDIT_ROLLBACK",
      status: "Sent",
      initialContact: new Date("2026-08-20T10:00:00Z"),
      metadata: JSON.stringify({
        outboundProviderMessageId: "outbound-audit-message",
        outboundRecipient: "inbound-audit@example.com",
        outboundSubject: "Legal outreach",
      }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const releaseFailure = rejectAuditAction("email.response_received", "reject_inbound_reply_audit");
    try {
      await expect(linkInboundOutreachReply({
        userId: owner.id,
        caseId: "CASE_INBOUND_AUDIT_ROLLBACK",
        message: {
          gmailMessageId: "gmail-inbound-audit-failure",
          from: "inbound-audit@example.com",
          subject: "Re: Legal outreach",
          body: "I have reviewed your request.",
          receivedAt: new Date("2026-08-21T10:00:00Z"),
          inReplyTo: "<outbound-audit-message>",
        },
      })).rejects.toThrow();
    } finally {
      releaseFailure();
    }

    const [stored] = await app.db
      .select({ responseReceived: app.schema.outreachStatus.responseReceived, metadata: app.schema.outreachStatus.metadata })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "OUTREACH_INBOUND_AUDIT_ROLLBACK"));
    expect(stored.responseReceived).not.toBe("Yes");
    expect(JSON.parse(stored.metadata || "{}").inboundGmailMessageIds).toBeUndefined();
  });

  it("does not contact a provider when the dispatch claim audit cannot be written", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_DISPATCH_AUDIT_ROLLBACK",
      userId: owner.id,
      status: "Outreach",
    }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "LAWYER_DISPATCH_AUDIT_ROLLBACK",
      email: "dispatch-audit@example.com",
    }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "OUTREACH_DISPATCH_AUDIT_ROLLBACK",
      caseId: "CASE_DISPATCH_AUDIT_ROLLBACK",
      lawyerId: "LAWYER_DISPATCH_AUDIT_ROLLBACK",
      status: "PendingApproval",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const caller = app.makeCaller(owner);
    const review = await caller.workflow.preSendReview({ outreachId: "OUTREACH_DISPATCH_AUDIT_ROLLBACK" });
    await caller.workflow.approveDraft({
      outreachId: "OUTREACH_DISPATCH_AUDIT_ROLLBACK",
      approvalHash: review.message.approvalHash,
    });

    await setFlag("outreach.send.enabled", true);
    const releaseFailure = rejectAuditAction("outreach.status_changed", "reject_dispatch_claim_audit");
    let providerCalled = false;
    try {
      await expect(sendApprovedOutreach(owner.id, "OUTREACH_DISPATCH_AUDIT_ROLLBACK", async () => {
        providerCalled = true;
        return { delivered: true, provider: "test" };
      })).rejects.toThrow();
    } finally {
      releaseFailure();
      await setFlag("outreach.send.enabled", false);
    }

    const [stored] = await app.db
      .select({ status: app.schema.outreachStatus.status })
      .from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "OUTREACH_DISPATCH_AUDIT_ROLLBACK"));
    expect(providerCalled).toBe(false);
    expect(stored.status).toBe("Approved");
  });
});
