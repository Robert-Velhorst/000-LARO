import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("canonical keyword-pull monitoring", () => {
  let app: TestApp;
  let previousScanRoots: string | undefined;
  const user = { id: "COLLECTION_MONITOR_OWNER", name: "Monitor owner", role: "user", email: "monitor@example.test" };
  const caseId = "COLLECTION_MONITOR_CASE";
  const sourceDirectoryName = "canonical-monitoring";
  let sourceDirectory: string;

  beforeAll(async () => {
    app = await bootTestApp();
    previousScanRoots = process.env.LOCAL_SCAN_ROOTS;
    process.env.LOCAL_SCAN_ROOTS = app.tmpDir;
    sourceDirectory = join(app.tmpDir, sourceDirectoryName);
    mkdirSync(sourceDirectory);
    await app.db.insert(app.schema.users).values(buildUser(user));
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId: user.id }));
    await app.makeCaller(user).userPreferences.updateWorkflow({ autoAnalyzeImports: false });
  });

  afterAll(() => {
    if (previousScanRoots === undefined) delete process.env.LOCAL_SCAN_ROOTS;
    else process.env.LOCAL_SCAN_ROOTS = previousScanRoots;
    app?.cleanup();
  });

  const pullLocal = async (directory = sourceDirectory) => {
    const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
    return pullEvidenceByKeywords({
      caseId,
      userId: user.id,
      keywords: ["contract"],
      matchMode: "any",
      includeGmail: false,
      includeDrive: false,
      includeLocal: true,
      localFolderPaths: [directory],
    });
  };

  it("persists real duration, source counts, keywords, and local content revisions", async () => {
    const source = join(sourceDirectory, "contract-monitor.txt");
    writeFileSync(source, "first canonical contract revision", "utf8");

    const first = await pullLocal();
    expect(first.monitoring).toMatchObject({
      completeness: "complete",
      requestedKeywords: ["contract"],
      matchedKeywords: ["contract"],
      requestedSources: ["local"],
      completedSources: ["local"],
      processedItems: 1,
      storedItems: 1,
      skippedItems: 0,
      sources: [{ source: "local", status: "completed", processedItems: 1, storedItems: 1, skippedItems: 0 }],
      revisions: [{ source: "local", title: "contract-monitor.txt", revisionNumber: 1, matchedKeywords: ["contract"] }],
    });
    expect(first.monitoring.durationMs).toBeGreaterThan(0);
    const firstRevision = first.monitoring.revisions[0].contentRevision;
    expect(firstRevision).toMatch(/^[a-f0-9]{64}$/);

    const firstHistory = await app.makeCaller(user).autoCollection.monitoring({ caseId, limit: 20 });
    expect(firstHistory.jobs[0]).toMatchObject({
      status: "completed",
      monitoring: { completeness: "complete", storedItems: 1 },
    });
    const [firstEvidence] = await app.db.select().from(app.schema.evidence);
    expect(JSON.parse(firstEvidence.metadata || "{}")).toMatchObject({
      keywordPullJobId: firstHistory.jobs[0].id,
      matchedKeywords: ["contract"],
      revisionNumber: 1,
    });

    const unchanged = await pullLocal();
    expect(unchanged.monitoring).toMatchObject({
      completeness: "complete_zero",
      requestedKeywords: ["contract"],
      matchedKeywords: ["contract"],
      requestedSources: ["local"],
      completedSources: ["local"],
      processedItems: 1,
      storedItems: 0,
      skippedItems: 1,
      sources: [{ source: "local", status: "completed", storedItems: 0, skippedItems: 1 }],
    });
    expect(unchanged.monitoring.durationMs).toBeGreaterThan(0);

    writeFileSync(source, "second changed canonical contract revision", "utf8");
    const changed = await pullLocal();
    expect(changed.monitoring).toMatchObject({
      completeness: "complete",
      storedItems: 1,
      revisions: [{ source: "local", revisionNumber: 2, matchedKeywords: ["contract"] }],
    });
    expect(changed.monitoring.revisions[0].contentRevision).not.toBe(firstRevision);
    expect(await app.db.select().from(app.schema.evidence)).toHaveLength(2);
  });

  it("distinguishes a mixed-source partial result from a bounded limit", async () => {
    const partialDirectory = join(app.tmpDir, "partial-monitoring");
    mkdirSync(partialDirectory);
    writeFileSync(join(partialDirectory, "contract-partial.txt"), "partial source success", "utf8");
    const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
    const partial = await pullEvidenceByKeywords({
      caseId,
      userId: user.id,
      keywords: ["contract"],
      gmailAccountIds: ["MISSING_MONITOR_ACCOUNT"],
      includeGmail: true,
      includeDrive: false,
      includeLocal: true,
      localFolderPaths: [partialDirectory],
    });
    expect(partial.monitoring).toMatchObject({
      completeness: "partial",
      requestedSources: ["gmail", "local"],
      completedSources: ["local"],
      storedItems: 1,
      sources: expect.arrayContaining([
        expect.objectContaining({ source: "gmail", status: "failed", storedItems: 0 }),
        expect.objectContaining({ source: "local", status: "completed", storedItems: 1 }),
      ]),
    });

    const limitedDirectory = join(app.tmpDir, "limited-monitoring");
    mkdirSync(limitedDirectory);
    writeFileSync(join(limitedDirectory, "contract-limit-one.txt"), "one", "utf8");
    writeFileSync(join(limitedDirectory, "contract-limit-two.txt"), "two", "utf8");
    const { EvidenceIngestionBudget } = await import("../../server/evidenceIngestionBudget");
    const limited = await pullEvidenceByKeywords({
      caseId,
      userId: user.id,
      keywords: ["contract-limit"],
      includeGmail: false,
      includeDrive: false,
      includeLocal: true,
      localFolderPaths: [limitedDirectory],
      ingestionBudget: new EvidenceIngestionBudget(undefined, {
        maxFileBytes: 1_024,
        maxJobBytes: 2_048,
        maxJobItems: 1,
        maxConcurrentOperations: 1,
        maxAnalysisItems: 1,
        minLocalStorageHeadroomBytes: 0,
      }),
    });
    expect(limited.monitoring).toMatchObject({
      completeness: "limited",
      storedItems: 1,
      skippedItems: 1,
      sources: [{ source: "local", status: "limited", storedItems: 1, skippedItems: 1 }],
    });
  });

  it("retains cancelled, failed, and restart-interrupted terminal states", async () => {
    const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await pullEvidenceByKeywords({
      caseId,
      userId: user.id,
      keywords: ["contract"],
      includeGmail: false,
      includeDrive: false,
      includeLocal: true,
      localFolderPaths: [sourceDirectory],
      signal: controller.signal,
    });
    expect(cancelled.monitoring.completeness).toBe("cancelled");

    await expect(pullEvidenceByKeywords({
      caseId,
      userId: user.id,
      keywords: ["contract"],
      includeGmail: false,
      includeDrive: true,
      includeLocal: false,
      driveSources: [{ accountId: "MISSING_DRIVE_ACCOUNT", folderIds: ["root"] }],
    })).rejects.toThrow(/unavailable/i);

    const now = new Date();
    await app.db.insert(app.schema.keywordPullJobs).values({
      id: "58e04fca-ad0d-42aa-b21d-12091490777d",
      caseId,
      userId: user.id,
      status: "running",
      phase: "local",
      message: "Reading local evidence",
      processedWords: 2,
      totalWords: 8,
      processedItems: 1,
      totalItems: 2,
      result: JSON.stringify({ monitoring: {
        schemaVersion: 1,
        requestedKeywords: ["contract"],
        matchedKeywords: ["contract"],
        matchMode: "any",
        requestedSources: ["local"],
        completedSources: [],
        startedAt: now.toISOString(),
        completedAt: null,
        durationMs: null,
        completeness: "running",
        processedItems: 1,
        storedItems: 1,
        skippedItems: 0,
        processedBytes: 10,
        matchReasons: ["Local filename matched the persisted pull keywords."],
        sources: [{ source: "local", status: "running", processedItems: 1, storedItems: 1, skippedItems: 0, matchedKeywords: ["contract"], errors: [] }],
        revisions: [],
      } }),
      createdAt: now,
      startedAt: now,
      updatedAt: now,
    });

    const history = await app.makeCaller(user).autoCollection.monitoring({ caseId, limit: 20 });
    const states = history.jobs.map((job: { monitoring: { completeness: string } }) => job.monitoring.completeness);
    expect(states).toEqual(expect.arrayContaining([
      "complete",
      "complete_zero",
      "partial",
      "limited",
      "cancelled",
      "failed",
      "interrupted",
    ]));
    const interrupted = history.jobs.find((job: { id: string }) => job.id === "58e04fca-ad0d-42aa-b21d-12091490777d");
    expect(interrupted).toMatchObject({
      status: "failed",
      monitoring: { completeness: "interrupted" },
    });
  });
});
