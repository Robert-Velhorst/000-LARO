import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("managed storage deletion integrity", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(() => app?.cleanup());

  async function createStoredEvidence(userId: string, suffix: string) {
    const user = { id: userId, name: suffix, role: "user", email: `${suffix}@example.com` };
    await app.db.insert(app.schema.users).values(buildUser({ id: user.id, email: user.email }));
    const caller = app.makeCaller(user);
    const created = await caller.cases.create({
      clientName: suffix,
      clientEmail: `${suffix}-client@example.com`,
      caseType: "Employment",
      caseSummary: "Managed evidence deletion integrity",
      urgency: "Medium",
    });
    const { storagePut } = await import("../../server/storage");
    const blob = await storagePut(
      `evidence/${created.id}/manual/${suffix}.txt`,
      Buffer.from(`source bytes for ${suffix}`),
      "text/plain",
    );
    const evidenceId = `EV_${suffix.toUpperCase()}`;
    await app.db.insert(app.schema.evidence).values({
      id: evidenceId,
      caseId: created.id,
      userId,
      type: "document",
      title: `${suffix} evidence`,
      metadata: JSON.stringify({ storageKey: blob.key }),
      fileUrl: blob.url,
    });
    return { user, caller, caseId: created.id, evidenceId, storageKey: blob.key };
  }

  it("keeps evidence bytes when deleting its database row fails", async () => {
    const item = await createStoredEvidence("USER_DELETE_EVIDENCE_FAIL", "evidence-failure");
    const sqlite = (app.db as any).$client;
    sqlite.exec(`
      CREATE TRIGGER reject_evidence_delete
      BEFORE DELETE ON evidence
      WHEN OLD.id = '${item.evidenceId}'
      BEGIN SELECT RAISE(ABORT, 'simulated evidence delete failure'); END;
    `);

    await expect(item.caller.evidenceFiles.delete({ id: item.evidenceId })).rejects.toThrow(
      "simulated evidence delete failure",
    );

    const { storageRead } = await import("../../server/storage");
    await expect(storageRead(item.storageKey)).resolves.toEqual(
      Buffer.from("source bytes for evidence-failure"),
    );
    await expect(item.caller.evidenceFiles.get({ id: item.evidenceId })).resolves.toMatchObject({
      id: item.evidenceId,
    });
  });

  it("keeps case evidence bytes when the case deletion transaction fails", async () => {
    const item = await createStoredEvidence("USER_DELETE_CASE_FAIL", "case-failure");
    const sqlite = (app.db as any).$client;
    sqlite.exec(`
      CREATE TRIGGER reject_case_delete
      BEFORE DELETE ON cases
      WHEN OLD.id = '${item.caseId}'
      BEGIN SELECT RAISE(ABORT, 'simulated case delete failure'); END;
    `);

    await expect(item.caller.cases.delete({ id: item.caseId })).rejects.toThrow(
      "simulated case delete failure",
    );

    const { storageRead } = await import("../../server/storage");
    await expect(storageRead(item.storageKey)).resolves.toEqual(Buffer.from("source bytes for case-failure"));
    await expect(item.caller.cases.byId(item.caseId)).resolves.toMatchObject({ id: item.caseId });
  });

  it("keeps all user evidence bytes when the erasure transaction fails", async () => {
    const item = await createStoredEvidence("USER_DELETE_GDPR_FAIL", "gdpr-failure");
    const sqlite = (app.db as any).$client;
    sqlite.exec(`
      CREATE TRIGGER reject_user_delete
      BEFORE DELETE ON users
      WHEN OLD.id = '${item.user.id}'
      BEGIN SELECT RAISE(ABORT, 'simulated user delete failure'); END;
    `);

    await expect(item.caller.gdpr.deleteData({ confirm: true })).rejects.toThrow(
      "simulated user delete failure",
    );

    const { storageRead } = await import("../../server/storage");
    await expect(storageRead(item.storageKey)).resolves.toEqual(Buffer.from("source bytes for gdpr-failure"));
    const [evidenceRow] = await app.db
      .select({ id: app.schema.evidence.id })
      .from(app.schema.evidence)
      .where(eq(app.schema.evidence.id, item.evidenceId));
    expect(evidenceRow?.id).toBe(item.evidenceId);
  });

  it("persists failed object cleanup and removes it on retry", async () => {
    const storageKey = "retry/temporarily-blocked";
    const blockedPath = join(app.tmpDir, "uploads", "retry", "temporarily-blocked");
    mkdirSync(blockedPath, { recursive: true });
    const sqlite = (app.db as any).$client;
    const { enqueueStorageDeletions, processQueuedStorageDeletions } = await import(
      "../../server/storageDeletionQueue"
    );
    sqlite.transaction(() => enqueueStorageDeletions(sqlite, [storageKey]))();

    const failed = await processQueuedStorageDeletions({ storageKeys: [storageKey] });
    expect(failed).toMatchObject({ processed: 1, deleted: 0, failed: 1, pending: 1 });
    const queued = sqlite.prepare(`
      SELECT storageKey, attempts, lastError
      FROM storage_deletion_queue
      WHERE storageKey = ?
    `).get(storageKey) as { storageKey: string; attempts: number; lastError: string | null };
    expect(queued).toMatchObject({ storageKey, attempts: 1 });
    expect(queued.lastError).toBeTruthy();

    rmSync(blockedPath, { recursive: true, force: true });
    const { storagePut, storageRead } = await import("../../server/storage");
    await storagePut(storageKey, "retry succeeds", "text/plain");
    const recovered = await processQueuedStorageDeletions({ storageKeys: [storageKey] });
    expect(recovered).toMatchObject({ processed: 1, deleted: 1, failed: 0, pending: 0 });
    await expect(storageRead(storageKey)).rejects.toThrow("not found");
  });

  it("does not remove bytes that are still referenced by another evidence row", async () => {
    const item = await createStoredEvidence("USER_SHARED_STORAGE", "shared-storage");
    await app.db.insert(app.schema.evidence).values({
      id: "EV_SHARED_STORAGE_SECOND",
      caseId: item.caseId,
      userId: item.user.id,
      type: "document",
      title: "Second reference",
      metadata: JSON.stringify({ storageKey: item.storageKey }),
    });

    await expect(item.caller.evidenceFiles.delete({ id: item.evidenceId })).resolves.toMatchObject({
      success: true,
    });

    const { storageRead } = await import("../../server/storage");
    await expect(storageRead(item.storageKey)).resolves.toEqual(Buffer.from("source bytes for shared-storage"));
    await expect(item.caller.evidenceFiles.get({ id: "EV_SHARED_STORAGE_SECOND" })).resolves.toMatchObject({
      id: "EV_SHARED_STORAGE_SECOND",
    });
  });

  it("reports account erasure as pending when provider cleanup fails", async () => {
    const item = await createStoredEvidence("USER_GDPR_CLEANUP_PENDING", "gdpr-cleanup-pending");
    const blockedPath = join(app.tmpDir, "uploads", ...item.storageKey.split("/"));
    rmSync(blockedPath, { force: true });
    mkdirSync(blockedPath, { recursive: true });

    const result = await item.caller.gdpr.deleteData({ confirm: true });

    expect(result).toMatchObject({
      success: false,
      erasureStatus: "storage_cleanup_pending",
      storageCleanupPending: 1,
    });
    await expect(item.caller.cases.byId(item.caseId)).resolves.toBeNull();
    const sqlite = (app.db as any).$client;
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM storage_deletion_queue WHERE storageKey = ?")
        .get(item.storageKey).count,
    ).toBe(1);
  });

  it("does not attribute unrelated queued cleanup to a storage-free account", async () => {
    const user = { id: "USER_GDPR_NO_STORAGE", name: "No storage", role: "user", email: "no-storage@example.com" };
    await app.db.insert(app.schema.users).values(buildUser({ id: user.id, email: user.email }));
    const unrelatedKey = "retry/unrelated-owner-blocked";
    mkdirSync(join(app.tmpDir, "uploads", ...unrelatedKey.split("/")), { recursive: true });
    const sqlite = (app.db as any).$client;
    const { enqueueStorageDeletions } = await import("../../server/storageDeletionQueue");
    sqlite.transaction(() => enqueueStorageDeletions(sqlite, [unrelatedKey]))();

    const result = await app.makeCaller(user).gdpr.deleteData({ confirm: true });

    expect(result).toMatchObject({
      success: true,
      erasureStatus: "completed",
      storageCleanupPending: 0,
    });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM storage_deletion_queue WHERE storageKey = ?")
        .get(unrelatedKey).count,
    ).toBe(1);
  });

  it("reports requested cleanup that remains queued beyond the immediate batch", async () => {
    const keys = Array.from({ length: 101 }, (_, index) => `batch-cleanup/missing-${index}.txt`);
    const sqlite = (app.db as any).$client;
    const { enqueueStorageDeletions, processQueuedStorageDeletions } = await import(
      "../../server/storageDeletionQueue"
    );
    sqlite.transaction(() => enqueueStorageDeletions(sqlite, keys))();

    const report = await processQueuedStorageDeletions({ storageKeys: keys });

    expect(report).toMatchObject({
      processed: 100,
      deleted: 100,
      failed: 0,
      requestedPending: 1,
    });
  });

  it("reports evidence and case deletion as pending when object cleanup fails", async () => {
    const evidenceItem = await createStoredEvidence("USER_EVIDENCE_PENDING", "evidence-pending");
    const evidencePath = join(app.tmpDir, "uploads", ...evidenceItem.storageKey.split("/"));
    rmSync(evidencePath, { force: true });
    mkdirSync(evidencePath, { recursive: true });

    await expect(evidenceItem.caller.evidenceFiles.delete({ id: evidenceItem.evidenceId })).resolves.toMatchObject({
      success: false,
      deletionStatus: "storage_cleanup_pending",
      storageCleanupPending: 1,
    });

    const caseItem = await createStoredEvidence("USER_CASE_PENDING", "case-pending");
    const casePath = join(app.tmpDir, "uploads", ...caseItem.storageKey.split("/"));
    rmSync(casePath, { force: true });
    mkdirSync(casePath, { recursive: true });

    await expect(caseItem.caller.cases.delete({ id: caseItem.caseId })).resolves.toMatchObject({
      success: false,
      deletionStatus: "storage_cleanup_pending",
      storageCleanupPending: 1,
    });
  });

  it("chunks explicit queue selection beyond SQLite's variable limit", async () => {
    const keys = Array.from({ length: 32_766 }, (_, index) => `variable-limit/missing-${index}.txt`);
    const sqlite = (app.db as any).$client;
    const { enqueueStorageDeletions, processQueuedStorageDeletions } = await import(
      "../../server/storageDeletionQueue"
    );
    sqlite.transaction(() => enqueueStorageDeletions(sqlite, keys))();

    const report = await processQueuedStorageDeletions({ storageKeys: keys, limit: 1 });

    expect(report).toMatchObject({ processed: 1, deleted: 1, failed: 0, requestedPending: 32_765 });
  });

  it("makes scheduled cleanup failures visible to worker health", async () => {
    const key = "scheduled-cleanup/blocked";
    mkdirSync(join(app.tmpDir, "uploads", ...key.split("/")), { recursive: true });
    const sqlite = (app.db as any).$client;
    const { enqueueStorageDeletions } = await import("../../server/storageDeletionQueue");
    sqlite.transaction(() => enqueueStorageDeletions(sqlite, [key]))();
    const { runStorageDeletionSweep } = await import("../../server/cronScheduler");

    await expect(runStorageDeletionSweep()).rejects.toThrow("Storage deletion failed for");
  });

  it("repairs the storage deletion queue independently of migration bookkeeping", async () => {
    const Database = (await import("better-sqlite3")).default;
    const probe = new Database(":memory:");
    try {
      const { ensureStorageDeletionQueueTable } = await import("../../server/db");
      ensureStorageDeletionQueueTable(probe);
      expect(
        probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'storage_deletion_queue'")
          .get(),
      ).toMatchObject({ name: "storage_deletion_queue" });
      expect(
        probe.prepare(`
          SELECT COUNT(*) AS count
          FROM sqlite_master
          WHERE type = 'index'
            AND name IN ('storage_deletion_queue_storageKey_unique', 'storage_deletion_queue_nextAttemptAt_idx')
        `)
          .get().count,
      ).toBe(2);
    } finally {
      probe.close();
    }
  });
});
