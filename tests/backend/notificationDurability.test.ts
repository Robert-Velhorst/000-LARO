import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildCase, buildEvidence, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("typed durable notifications", () => {
  let app: TestApp;
  const owner = { id: "NOTIFICATION_OWNER", name: "Notification owner", role: "user", email: "notification-owner@example.test" };
  const other = { id: "NOTIFICATION_OTHER", name: "Other owner", role: "user", email: "notification-other@example.test" };
  const ownerCaseId = "NOTIFICATION_OWNER_CASE";
  const foreignCaseId = "NOTIFICATION_FOREIGN_CASE";
  const lawyerId = "NOTIFICATION_LAWYER";
  const evidenceId = "NOTIFICATION_EVIDENCE";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: other.id, email: other.email }),
    ]);
    await app.db.insert(app.schema.cases).values([
      buildCase({ id: ownerCaseId, userId: owner.id, urgency: "Medium" }),
      buildCase({ id: foreignCaseId, userId: other.id, urgency: "Medium" }),
    ]);
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: lawyerId }));
    await app.db.insert(app.schema.outreachStatus).values({
      id: "NOTIFICATION_OUTREACH",
      caseId: ownerCaseId,
      lawyerId,
      status: "Interested",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: evidenceId,
      caseId: ownerCaseId,
      userId: owner.id,
    }));
  });

  afterAll(() => app?.cleanup());

  it("preserves real kinds, owned context, metadata, and registered destinations", async () => {
    const { createNotification } = await import("../../server/notifications");
    const response = await createNotification({
      userId: owner.id,
      kind: "lawyer_response",
      title: "Lawyer replied",
      body: "A response is ready for review.",
      caseId: ownerCaseId,
      lawyerId,
      metadata: { outreachId: "NOTIFICATION_OUTREACH", response: "Interested" },
      dedupKey: "notification-typed-lawyer-response",
    });
    const uploaded = await createNotification({
      userId: owner.id,
      kind: "evidence_uploaded",
      title: "Evidence uploaded",
      caseId: ownerCaseId,
      evidenceFileId: evidenceId,
      metadata: { source: "manual" },
      dedupKey: "notification-typed-evidence",
    });

    expect(response.outcome).toBe("created");
    expect(uploaded.outcome).toBe("created");
    if (!response.persisted || !uploaded.persisted) throw new Error("Expected persisted notifications");
    const listed = await app.makeCaller(owner).notifications.list({ limit: 50 });
    expect(listed.find((row: any) => row.id === response.id)).toMatchObject({
      type: "lawyer_response",
      caseId: ownerCaseId,
      lawyerId,
      evidenceFileId: null,
      actionUrl: `/cases?case=${ownerCaseId}`,
      destinationStatus: "available",
      metadata: { outreachId: "NOTIFICATION_OUTREACH", response: "Interested" },
    });
    expect(listed.find((row: any) => row.id === uploaded.id)).toMatchObject({
      type: "evidence_uploaded",
      caseId: ownerCaseId,
      lawyerId: null,
      evidenceFileId: evidenceId,
      actionUrl: `/evidence?view=items&case=${ownerCaseId}&evidence=${evidenceId}`,
      destinationStatus: "available",
      metadata: { source: "manual" },
    });
  });

  it("rejects cross-owner context and suppresses unauthorized or deleted destinations", async () => {
    const { createNotification } = await import("../../server/notifications");
    const rejected = await createNotification({
      userId: owner.id,
      kind: "case_status_change",
      title: "Foreign case",
      caseId: foreignCaseId,
      dedupKey: "notification-foreign-writer",
    });
    expect(rejected).toEqual({
      outcome: "failure",
      persisted: false,
      reason: "invalid-context",
      retryable: false,
    });

    await app.db.insert(app.schema.notifications).values({
      id: "NOTIFICATION_FORGED_DESTINATION",
      userId: owner.id,
      kind: "case_status_change",
      title: "Forged destination",
      caseId: foreignCaseId,
      actionUrl: `/cases?case=${foreignCaseId}`,
      metadata: JSON.stringify({ secret: "must-not-leak" }),
      read: false,
      createdAt: new Date(),
    });

    const deletedCaseId = "NOTIFICATION_DELETED_CASE";
    await app.db.insert(app.schema.cases).values(buildCase({
      id: deletedCaseId,
      userId: owner.id,
      urgency: "Medium",
    }));
    const beforeDelete = await createNotification({
      userId: owner.id,
      kind: "case_status_change",
      title: "Deleted destination",
      caseId: deletedCaseId,
      dedupKey: "notification-deleted-destination",
    });
    expect(beforeDelete.outcome).toBe("created");
    if (!beforeDelete.persisted) throw new Error("Expected persisted notification");
    // Simulate a legacy/partially-migrated database that retained a stale row;
    // current installs normally cascade it through native foreign keys.
    const sqlite: any = app.db.$client;
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.prepare("DELETE FROM cases WHERE id = ?").run(deletedCaseId);
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }

    const listed = await app.makeCaller(owner).notifications.list({ limit: 50 });
    for (const id of ["NOTIFICATION_FORGED_DESTINATION", beforeDelete.id]) {
      expect(listed.find((row: any) => row.id === id)).toMatchObject({
        actionUrl: null,
        destinationStatus: "unavailable",
        metadata: null,
        caseId: null,
        lawyerId: null,
        evidenceFileId: null,
      });
    }
    sqlite.prepare("DELETE FROM notifications WHERE id = ?").run(beforeDelete.id);
  });

  it("deduplicates concurrent writes in the notification row itself", async () => {
    const { createNotification } = await import("../../server/notifications");
    const dedupKey = "notification-concurrent-dedup";
    const writes = await Promise.all(Array.from({ length: 20 }, () => createNotification({
      userId: owner.id,
      kind: "case_status_change",
      title: "One durable event",
      caseId: ownerCaseId,
      dedupKey,
    })));

    expect(writes.filter((result) => result.outcome === "created")).toHaveLength(1);
    expect(writes.filter((result) => result.outcome === "already-exists")).toHaveLength(19);
    expect(new Set(writes.flatMap((result) => result.persisted ? [result.id] : [])).size).toBe(1);
    const rows = await app.db.select().from(app.schema.notifications).where(and(
      eq(app.schema.notifications.userId, owner.id),
      eq(app.schema.notifications.dedupKey, dedupKey),
    ));
    expect(rows).toHaveLength(1);
  });

  it("keeps a reminder retryable after an injected storage failure", async () => {
    const reminderCaseId = "NOTIFICATION_RETRY_REMINDER";
    const now = new Date("2026-09-20T10:00:00.000Z");
    const dedupKey = `reminder:${reminderCaseId}:urgent-no-evidence:2026-09-20`;
    await app.db.insert(app.schema.cases).values(buildCase({
      id: reminderCaseId,
      userId: owner.id,
      urgency: "High",
    }));
    const sqlite: any = app.db.$client;
    sqlite.exec(`
      CREATE TRIGGER notification_injected_failure
      BEFORE INSERT ON notifications
      WHEN NEW.dedupKey = '${dedupKey}'
      BEGIN
        SELECT RAISE(ABORT, 'injected notification storage failure');
      END;
    `);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const { runRemindersForUser } = await import("../../server/reminders");
      const failed = await runRemindersForUser(owner.id, now);
      expect(failed.created).toBe(0);
      expect(await app.db.select().from(app.schema.notifications).where(eq(app.schema.notifications.dedupKey, dedupKey))).toHaveLength(0);
      expect(errorSpy).toHaveBeenCalled();
      expect(JSON.stringify(failed)).not.toContain("injected notification storage failure");

      sqlite.exec("DROP TRIGGER notification_injected_failure");
      const retried = await runRemindersForUser(owner.id, now);
      const duplicate = await runRemindersForUser(owner.id, now);
      expect(retried.created).toBe(1);
      expect(duplicate.created).toBe(0);
      expect(await app.db.select().from(app.schema.notifications).where(eq(app.schema.notifications.dedupKey, dedupKey))).toHaveLength(1);
    } finally {
      sqlite.exec("DROP TRIGGER IF EXISTS notification_injected_failure");
      errorSpy.mockRestore();
    }
  });
});
