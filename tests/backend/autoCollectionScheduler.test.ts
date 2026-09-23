import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildUser } from "../factories";
import type { NotificationWriteResult } from "../../server/notifications";

const suite = sqliteAvailable ? describe : describe.skip;

suite("scheduled collection ownership and eligibility", () => {
  let app: TestApp;
  let previousScanRoots: string | undefined;

  beforeAll(async () => {
    app = await bootTestApp();
    previousScanRoots = process.env.LOCAL_SCAN_ROOTS;
    process.env.LOCAL_SCAN_ROOTS = app.tmpDir;
  });

  beforeEach(async () => {
    await app.db.delete(app.schema.autoCollectionSettings);
    await app.db.delete(app.schema.notifications);
  });

  afterAll(() => {
    if (previousScanRoots === undefined) delete process.env.LOCAL_SCAN_ROOTS;
    else process.env.LOCAL_SCAN_ROOTS = previousScanRoots;
    app?.cleanup();
  });

  async function insertOwnerWithCases(ownerId: string, caseIds: string[]) {
    const email = `${ownerId.toLowerCase()}@example.test`;
    await app.db.insert(app.schema.users).values(buildUser({ id: ownerId, email }));
    for (const caseId of caseIds) {
      await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId: ownerId }));
      await app.db.insert(app.schema.autoCollectionSettings).values({
        id: `SETTINGS_${caseId}`,
        caseId,
        userId: ownerId,
        keywords: JSON.stringify(["contract"]),
        keywordMatchMode: "any",
        emailAccountIds: JSON.stringify([]),
        isEnabled: true,
        status: "active",
      });
    }
    return { id: ownerId, email, name: ownerId, role: "user" };
  }

  it("persists one report per owner without leaking another owner's cases or errors", async () => {
    const ownerA = await insertOwnerWithCases("SCHEDULE_OWNER_A", ["SCHEDULE_A_1", "SCHEDULE_A_2"]);
    const ownerB = await insertOwnerWithCases("SCHEDULE_OWNER_B", ["SCHEDULE_B_1"]);
    const { runAutoCollectionForAllCases } = await import("../../server/autoCollectionService");

    const result = await runAutoCollectionForAllCases({
      now: new Date("2026-09-23T02:00:00.000Z"),
      runCase: vi.fn(async (caseId) => ({
        emailsFound: caseId === "SCHEDULE_A_1" ? 2 : 0,
        emailsProcessed: caseId === "SCHEDULE_A_1" ? 2 : 0,
        filesFound: caseId === "SCHEDULE_B_1" ? 3 : 0,
        filesDownloaded: caseId === "SCHEDULE_B_1" ? 3 : 0,
        errors: caseId === "SCHEDULE_A_2" ? ["owner A provider unavailable"] : [],
      })),
    });

    expect(result).toMatchObject({ casesProcessed: 3, emailsCollected: 2, filesCollected: 3 });
    const rows = await app.db.select().from(app.schema.notifications);
    expect(rows).toHaveLength(2);
    const reportA = rows.find((row: any) => row.userId === ownerA.id)!;
    const reportB = rows.find((row: any) => row.userId === ownerB.id)!;
    expect(reportA.kind).toBe("system_announcement");
    expect(reportA.body).toContain("Cases processed: 2");
    expect(reportA.body).toContain("SCHEDULE_A_2");
    expect(reportA.body).not.toContain("SCHEDULE_B_1");
    expect(reportB.body).toContain("Cases processed: 1");
    expect(reportB.body).not.toContain("SCHEDULE_A_1");
    expect(reportB.body).not.toContain("owner A provider unavailable");
    expect(reportA.dedupKey).toBe("auto-collection-report:2026-09-23");
    expect(reportB.dedupKey).toBe("auto-collection-report:2026-09-23");

    expect((await app.makeCaller(ownerA).notifications.list({ limit: 10 }))).toHaveLength(1);
    expect((await app.makeCaller(ownerB).notifications.list({ limit: 10 }))).toHaveLength(1);
  });

  it("returns an observable error when the canonical notification writer cannot persist", async () => {
    await insertOwnerWithCases("SCHEDULE_FAILURE_OWNER", ["SCHEDULE_FAILURE_CASE"]);
    const writeNotification = vi.fn(async (): Promise<NotificationWriteResult> => ({
      outcome: "failure",
      persisted: false,
      reason: "storage-error",
      retryable: true,
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { runAutoCollectionForAllCases } = await import("../../server/autoCollectionService");

    try {
      const result = await runAutoCollectionForAllCases({
        runCase: async () => ({ emailsFound: 0, emailsProcessed: 0, filesFound: 0, filesDownloaded: 0, errors: [] }),
        writeNotification,
      });
      expect(result.errors).toEqual([
        "Collection report for user SCHEDULE_FAILURE_OWNER was not persisted (storage-error)",
      ]);
      expect(writeNotification).toHaveBeenCalledOnce();
      expect(log.mock.calls.flat().join(" ")).not.toMatch(/notification sent/i);
      expect(error.mock.calls.flat().join(" ")).toContain("was not persisted");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("keeps folder-first setup inactive until keywords are configured", async () => {
    const owner = await insertOwnerWithCases("SCHEDULE_FOLDER_OWNER", []);
    const caseId = "SCHEDULE_FOLDER_CASE";
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId: owner.id }));
    const {
      runAutoCollectionForAllCases,
      setLocalFolderPaths,
      upsertAutoCollectionSettings,
    } = await import("../../server/autoCollectionService");
    await setLocalFolderPaths(caseId, owner.id, [app.tmpDir]);

    let [settings] = await app.db.select().from(app.schema.autoCollectionSettings)
      .where(eq(app.schema.autoCollectionSettings.caseId, caseId));
    expect(settings).toMatchObject({ isEnabled: false, status: "configured", keywords: "[]" });
    expect(await app.makeCaller(owner).autoCollection.getLocalFolders({ caseId }))
      .toMatchObject({ paths: [app.tmpDir], scheduleActive: false });

    const runCase = vi.fn(async () => ({ emailsFound: 0, emailsProcessed: 0, filesFound: 0, filesDownloaded: 0, errors: [] }));
    const writeNotification = vi.fn(async (): Promise<NotificationWriteResult> => ({
      outcome: "created", persisted: true, id: "test-report",
    }));
    await runAutoCollectionForAllCases({ runCase, writeNotification });
    expect(runCase).not.toHaveBeenCalled();
    expect(writeNotification).not.toHaveBeenCalled();

    await upsertAutoCollectionSettings({
      caseId,
      userId: owner.id,
      keywords: [" contract ", "contract"],
      keywordMatchMode: "any",
      emailAccountIds: [],
      googleDriveSources: [],
      autoDownloadAttachments: true,
      autoDownloadGoogleDriveFiles: false,
    });
    [settings] = await app.db.select().from(app.schema.autoCollectionSettings)
      .where(eq(app.schema.autoCollectionSettings.caseId, caseId));
    expect(settings).toMatchObject({ isEnabled: true, status: "active", keywords: '["contract"]' });
    expect(await app.makeCaller(owner).autoCollection.getLocalFolders({ caseId }))
      .toMatchObject({ paths: [app.tmpDir], scheduleActive: true });

    await runAutoCollectionForAllCases({ runCase, writeNotification });
    expect(runCase).toHaveBeenCalledWith(caseId);
    expect(writeNotification).toHaveBeenCalledOnce();
  });
});
