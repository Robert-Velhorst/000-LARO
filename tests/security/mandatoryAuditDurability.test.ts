import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createAuditLog, writeAuditLogOrThrow } from "../../server/audit";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { setFlag } from "../../server/featureFlags";
import { sendApprovedOutreach } from "../../server/outreachSend";

const suite = sqliteAvailable ? describe : describe.skip;

suite("mandatory audit durability", () => {
  let app: TestApp;
  const admin = { id: "AUDIT_ADMIN", role: "admin", email: "audit-admin@example.com" };
  const owner = { id: "AUDIT_OWNER", role: "user", email: "audit-owner@example.com" };
  const member = { id: "AUDIT_MEMBER", role: "user", email: "audit-member@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(admin), buildUser(owner), buildUser(member)]);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "AUDIT_CASE",
      userId: owner.id,
    }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: "AUDIT_LAWYER" }));
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(() => app?.cleanup());

  function rejectAuditAction(action: string, triggerName: string): () => void {
    const sqlite = app.db.$client;
    sqlite.exec(`
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = '${action}'
      BEGIN
        SELECT RAISE(ABORT, 'injected mandatory audit failure');
      END;
    `);
    return () => sqlite.exec(`DROP TRIGGER IF EXISTS ${triggerName}`);
  }

  it("rolls back emergency-stop changes and records each real toggle once", async () => {
    const alert = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const release = rejectAuditAction("emergency_stop.engaged", "reject_emergency_stop_audit");
    try {
      await expect(app.makeCaller(admin).admin.setEmergencyStop({ engaged: true })).rejects.toThrow();
      expect((await app.makeCaller(admin).admin.emergencyStopStatus()).engaged).toBe(false);
      expect(alert).toHaveBeenCalledWith(
        "[Audit][MANDATORY] Durable audit write failed",
        expect.objectContaining({ action: "emergency_stop.engaged" }),
      );
    } finally {
      release();
    }

    const caller = app.makeCaller(admin);
    expect((await caller.admin.setEmergencyStop({ engaged: true })).changed).toBe(true);
    expect((await caller.admin.setEmergencyStop({ engaged: true })).changed).toBe(false);
    await caller.admin.setEmergencyStop({ engaged: false });
    await caller.admin.setEmergencyStop({ engaged: true });
    const events = await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, "emergency_stop.engaged"));
    expect(events).toHaveLength(2);
    await caller.admin.setEmergencyStop({ engaged: false });
  });

  it("rolls back feature-flag changes when the audit insert fails", async () => {
    const release = rejectAuditAction("feature_flag.changed", "reject_feature_flag_audit");
    try {
      await expect(app.makeCaller(admin).featureFlags.set({
        key: "outreach.send.enabled",
        value: true,
      })).rejects.toThrow();
    } finally {
      release();
    }
    expect((await app.makeCaller(admin).featureFlags.list())["outreach.send.enabled"]).toBe(false);
  });

  it("rolls back HAI credential creation and revocation when mandatory audit storage fails", async () => {
    const caller = app.makeCaller(owner);
    const releaseCreate = rejectAuditAction("integration.hai_token_created", "reject_hai_create_audit");
    try {
      await expect(caller.haiIntegration.createToken({
        name: "Audit rollback credential",
        expiresInDays: 30,
      })).rejects.toThrow();
    } finally {
      releaseCreate();
    }
    expect(await app.db.select().from(app.schema.integrationAccessTokens)
      .where(and(
        eq(app.schema.integrationAccessTokens.userId, owner.id),
        eq(app.schema.integrationAccessTokens.name, "Audit rollback credential"),
      ))).toHaveLength(0);

    const created = await caller.haiIntegration.createToken({
      name: "Audited credential",
      expiresInDays: 30,
    });
    const releaseRevoke = rejectAuditAction("integration.hai_token_revoked", "reject_hai_revoke_audit");
    try {
      await expect(caller.haiIntegration.revokeToken({ tokenId: created.credential.id })).rejects.toThrow();
    } finally {
      releaseRevoke();
    }
    const [active] = await app.db.select().from(app.schema.integrationAccessTokens)
      .where(eq(app.schema.integrationAccessTokens.id, created.credential.id));
    expect(active.status).toBe("active");

    await expect(caller.haiIntegration.revokeToken({ tokenId: created.credential.id }))
      .resolves.toEqual({ success: true });
    await expect(caller.haiIntegration.revokeToken({ tokenId: created.credential.id }))
      .resolves.toEqual({ success: true });
    const revokeEvents = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.action, "integration.hai_token_revoked"),
      eq(app.schema.auditLogs.entityId, created.credential.id),
    ));
    expect(revokeEvents).toHaveLength(1);
  });

  it("rolls back consent and share capability changes when their audit insert fails", async () => {
    const releaseConsent = rejectAuditAction("gdpr.consent_updated", "reject_consent_audit");
    try {
      await expect(app.makeCaller(owner).gdpr.updateConsent({ marketing: true })).rejects.toThrow();
    } finally {
      releaseConsent();
    }
    expect((await app.makeCaller(owner).gdpr.getConsent()).marketing).toBe(false);

    const releaseShare = rejectAuditAction("case.share_invited", "reject_share_invite_audit");
    try {
      await expect(app.makeCaller(owner).teams.invite({
        caseId: "AUDIT_CASE",
        email: member.email,
        role: "read_only",
        capabilities: [],
      })).rejects.toThrow();
    } finally {
      releaseShare();
    }
    expect(await app.makeCaller(owner).teams.listShares({ caseId: "AUDIT_CASE" })).toEqual([]);
  });

  it("rolls back outreach directory review, match creation, and match status decisions", async () => {
    const caller = app.makeCaller(owner);
    const target = await caller.outreachDirectory.createManual({
      targetType: "organization",
      name: "Employment support organization",
      url: "https://audit-target.example.org",
      legalAreas: ["Employment Law"],
    });
    const releaseReview = rejectAuditAction("outreach.directory_reviewed", "reject_directory_review_audit");
    try {
      await expect(caller.outreachDirectory.review({
        id: target.id,
        targetType: "organization",
        status: "approved",
      })).rejects.toThrow();
    } finally {
      releaseReview();
    }
    expect((await caller.outreachDirectory.list({ targetType: "organization" }))
      .find((row: { id: string }) => row.id === target.id).status).toBe("pending");

    await caller.outreachDirectory.review({
      id: target.id,
      targetType: "organization",
      status: "approved",
    });
    const releaseMatch = rejectAuditAction("outreach.targets_matched", "reject_directory_match_audit");
    try {
      await expect(caller.outreachDirectory.matchCase({
        caseId: "AUDIT_CASE",
        targetType: "organization",
      })).rejects.toThrow();
    } finally {
      releaseMatch();
    }
    expect(await caller.outreachDirectory.matches({
      caseId: "AUDIT_CASE",
      targetType: "organization",
    })).toHaveLength(0);

    const matches = await caller.outreachDirectory.matchCase({
      caseId: "AUDIT_CASE",
      targetType: "organization",
    });
    expect(matches).toHaveLength(1);
    const releaseStatus = rejectAuditAction("outreach.target_match_status_changed", "reject_match_status_audit");
    try {
      await expect(caller.outreachDirectory.updateMatchStatus({
        id: matches[0].id,
        status: "shortlisted",
      })).rejects.toThrow();
    } finally {
      releaseStatus();
    }
    expect((await caller.outreachDirectory.matches({
      caseId: "AUDIT_CASE",
      targetType: "organization",
    }))[0].status).toBe("suggested");
  });

  it("rolls back a batch review if the batch audit cannot persist", async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.outreachDirectory.createManual({
      targetType: "media",
      name: "First newsroom",
      url: "https://audit-first.example.org",
    });
    const second = await caller.outreachDirectory.createManual({
      targetType: "media",
      name: "Second newsroom",
      url: "https://audit-second.example.org",
    });
    const release = rejectAuditAction("outreach.directory_batch_reviewed", "reject_batch_review_audit");
    try {
      await expect(caller.outreachDirectory.reviewBatch({
        ids: [first.id, second.id],
        targetType: "media",
        status: "approved",
      })).rejects.toThrow();
    } finally {
      release();
    }
    const pending = await caller.outreachDirectory.list({ targetType: "media", status: "pending" });
    expect(pending.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it("marks a delivered send uncertain if its Sent audit cannot persist", async () => {
    const caller = app.makeCaller(owner);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "AUDIT_SEND_CASE",
      userId: owner.id,
    }));
    await caller.workflow.prepareDrafts({ caseId: "AUDIT_SEND_CASE" });
    const queue = await caller.workflow.reviewQueue({ caseId: "AUDIT_SEND_CASE" });
    expect(queue.length).toBeGreaterThan(0);
    const outreachId = queue[0].id;
    const review = await caller.workflow.preSendReview({ outreachId });
    await caller.workflow.approveDraft({ outreachId, approvalHash: review.message.approvalHash });

    await setFlag("outreach.send.enabled", true);
    let deliveries = 0;
    const sender = async () => {
      deliveries += 1;
      return { delivered: true, provider: "test", providerMessageId: "audit-send-1" };
    };
    const sqlite = app.db.$client;
    sqlite.exec(`
      CREATE TRIGGER reject_delivered_send_audit
      BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'outreach.status_changed' AND NEW.details LIKE '%"to":"Sent"%'
      BEGIN
        SELECT RAISE(ABORT, 'injected delivered-send audit failure');
      END;
    `);
    try {
      await expect(sendApprovedOutreach(owner.id, outreachId, sender)).rejects.toThrow();
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS reject_delivered_send_audit");
    }
    expect(deliveries).toBe(1);
    const [guard] = await app.db.select().from(app.schema.systemConfig)
      .where(eq(app.schema.systemConfig.configKey, `sent:${outreachId}`));
    expect(guard.configValue).toMatch(/^uncertain:/);
    const [status] = await app.db.select().from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, outreachId));
    expect(status.status).toBe("Dispatching");
    await expect(sendApprovedOutreach(owner.id, outreachId, sender)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(deliveries).toBe(1);

    await app.makeCaller(admin).admin.resolveUncertainOutreachDispatch({
      outreachId,
      outcome: "delivered",
      providerVerified: true,
      providerReference: "audit-send-1",
      note: "Test provider confirmed that it accepted exactly one message.",
    });
    const [resolved] = await app.db.select().from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, outreachId));
    expect(resolved.status).toBe("Sent");
    await setFlag("outreach.send.enabled", false);
  });

  it("does not return a GDPR export when its mandatory audit fails", async () => {
    const release = rejectAuditAction("gdpr.export", "reject_gdpr_export_audit");
    try {
      await expect(app.makeCaller(owner).gdpr.exportData()).rejects.toThrow();
    } finally {
      release();
    }
    const result = await app.makeCaller(owner).gdpr.exportData();
    expect(result.success).toBe(true);
    const events = await app.db.select().from(app.schema.auditLogs)
      .where(and(eq(app.schema.auditLogs.action, "gdpr.export"), eq(app.schema.auditLogs.userId, owner.id)));
    expect(events).toHaveLength(1);
  });

  it("rolls back erasure and leaves the account intact if its receipt cannot persist", async () => {
    const erasable = { id: "AUDIT_ERASABLE", role: "user", email: "erasable@example.com" };
    await app.db.insert(app.schema.users).values(buildUser(erasable));
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "AUDIT_ERASABLE_CASE",
      userId: erasable.id,
    }));
    const release = rejectAuditAction("gdpr.delete", "reject_gdpr_delete_audit");
    try {
      await expect(app.makeCaller(erasable).gdpr.deleteData({ confirm: true })).rejects.toThrow();
    } finally {
      release();
    }
    expect(await app.db.select().from(app.schema.users)
      .where(eq(app.schema.users.id, erasable.id))).toHaveLength(1);
    expect(await app.db.select().from(app.schema.cases)
      .where(eq(app.schema.cases.id, "AUDIT_ERASABLE_CASE"))).toHaveLength(1);
    expect(await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, "gdpr.delete"))).toHaveLength(0);
  });

  it("rolls back retention deletions when their receipt cannot persist", async () => {
    await app.db.insert(app.schema.auditLogs).values({
      id: "AUDIT_STALE_ROW",
      action: "test.old_event",
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
    });
    const release = rejectAuditAction("retention.sweep", "reject_retention_audit");
    try {
      await expect(app.makeCaller(admin).admin.retentionRun()).rejects.toThrow();
    } finally {
      release();
    }
    expect(await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.id, "AUDIT_STALE_ROW"))).toHaveLength(1);
    const report = await app.makeCaller(admin).admin.retentionRun();
    expect(report.auditLogsDeleted).toBeGreaterThanOrEqual(1);
    expect(await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.id, "AUDIT_STALE_ROW"))).toHaveLength(0);
  });

  it("deduplicates identical retries, rejects conflicting retries, and redacts secrets and content", async () => {
    const event = {
      userId: owner.id,
      action: "gdpr.export",
      entityType: "user",
      entityId: owner.id,
      idempotencyKey: "export-request-audit-1",
      details: {
        outcome: "ready",
        accessToken: "PRIVATE_ACCESS_TOKEN",
        sessionToken: "PRIVATE_SESSION_TOKEN",
        privateKey: "PRIVATE_SIGNING_KEY",
        nested: {
          caseSummary: "PRIVATE_CASE_CONTENT",
          evidenceQuotes: ["PRIVATE_SOURCE_TEXT"],
          caseQuote: "PRIVATE_CASE_QUOTE",
          reason: "Private user rationale with source facts",
          query: "Private search text",
          evidenceTitle: "Private document title",
        },
      },
    };
    const firstId = writeAuditLogOrThrow(app.db, event);
    expect(writeAuditLogOrThrow(app.db, event)).toBe(firstId);
    const rows = await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.id, firstId));
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toContain("[REDACTED_SECRET]");
    expect(rows[0].details).toContain("[REDACTED_CONTENT]");
    expect(rows[0].details).not.toMatch(
      /PRIVATE_ACCESS_TOKEN|PRIVATE_SESSION_TOKEN|PRIVATE_SIGNING_KEY|PRIVATE_CASE_CONTENT|PRIVATE_SOURCE_TEXT|PRIVATE_CASE_QUOTE|Private user rationale|Private search text|Private document title/,
    );
    await expect(() => writeAuditLogOrThrow(app.db, {
      ...event,
      details: { ...event.details, outcome: "different" },
    })).toThrow("conflicts with a different event");
  });

  it("keeps best-effort diagnostic failures nonblocking for a real caller", async () => {
    const release = rejectAuditAction("evidence.scored", "reject_best_effort_audit");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(app.makeCaller(owner).relevanceScoring.batchScore({
        caseContext: { caseId: "AUDIT_CASE" },
      })).resolves.toMatchObject({ success: true, totalScored: 0 });
    } finally {
      release();
    }
    expect(diagnostic).toHaveBeenCalledWith(
      "[Audit] Failed to create best-effort audit log:",
      expect.any(Error),
    );
    await expect(createAuditLog({ action: "evidence.scored" })).resolves.toBeUndefined();
  });
});
