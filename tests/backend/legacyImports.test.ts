import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildEvidence } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { verifiedErasureInput } from "../helpers/erasure";

const suite = sqliteAvailable ? describe : describe.skip;

suite("legacy import archive boundaries", () => {
  let app: TestApp;
  const ownerA = { id: "LEGACY_OWNER_A", email: "a@example.test", role: "user" };
  const ownerB = { id: "LEGACY_OWNER_B", email: "b@example.test", role: "user" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      { id: ownerA.id, email: ownerA.email, name: "Owner A", password: "hash", role: "user" },
      { id: ownerB.id, email: ownerB.email, name: "Owner B", password: "hash", role: "user" },
    ] as any);
    await app.db.insert(app.schema.legacyImportRuns).values([
      {
        id: "LEGACY_RUN_A",
        sourceRuntime: "flask",
        sourceInstanceId: "workspace-a",
        userId: ownerA.id,
        sourceUserId: "flask-a",
        sourceUserEmail: ownerA.email,
        status: "completed",
        sourceSnapshotHash: "a".repeat(64),
        recordsImported: 2,
        casesImported: 1,
        filesCopied: 1,
        missingFiles: 0,
        summary: JSON.stringify({ excludedGlobalTables: ["outreach_directory_targets"] }),
        startedAt: new Date("2026-07-21T00:00:00Z"),
        completedAt: new Date("2026-07-21T00:01:00Z"),
      },
      {
        id: "LEGACY_RUN_B",
        sourceRuntime: "flask",
        sourceInstanceId: "workspace-b",
        userId: ownerB.id,
        sourceUserId: "flask-b",
        sourceUserEmail: ownerB.email,
        status: "completed",
        sourceSnapshotHash: "b".repeat(64),
        recordsImported: 1,
        casesImported: 1,
        filesCopied: 0,
        missingFiles: 1,
        summary: "{}",
        startedAt: new Date("2026-07-21T00:00:00Z"),
        completedAt: new Date("2026-07-21T00:01:00Z"),
      },
    ] as any);
    await app.db.insert(app.schema.legacyImportRecords).values([
      {
        id: "LEGACY_RECORD_A",
        runId: "LEGACY_RUN_A",
        userId: ownerA.id,
        sourceRuntime: "flask",
        sourceInstanceId: "workspace-a",
        sourceTable: "legal_cases",
        sourceRecordId: "1",
        sourceHash: "c".repeat(64),
        payloadHash: "d".repeat(64),
        redactedFields: "[]",
        payload: "{}",
        importedAt: new Date("2026-07-21T00:01:00Z"),
      },
      {
        id: "LEGACY_RECORD_B",
        runId: "LEGACY_RUN_B",
        userId: ownerB.id,
        sourceRuntime: "flask",
        sourceInstanceId: "workspace-b",
        sourceTable: "audit_events",
        sourceRecordId: "2",
        sourceHash: "e".repeat(64),
        payloadHash: "f".repeat(64),
        redactedFields: "[]",
        payload: "{}",
        importedAt: new Date("2026-07-21T00:01:00Z"),
      },
    ] as any);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "LEGACY_CASE_A",
      userId: ownerA.id,
      caseType: "Administrative Law",
    }));
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "LEGACY_EVIDENCE_A",
      caseId: "LEGACY_CASE_A",
      userId: ownerA.id,
      title: "Imported decision.pdf",
    }));
    await app.db.insert(app.schema.timeline).values({
      id: "LEGACY_TIMELINE_A",
      caseId: "LEGACY_CASE_A",
      userId: ownerA.id,
      eventType: "decision",
      title: "Municipality issued its decision",
      description: "The municipality rejected the application.",
      eventAt: new Date("2026-07-14T00:00:00Z"),
      metadata: JSON.stringify({
        evidenceId: "LEGACY_EVIDENCE_A",
        legacyImport: { runId: "LEGACY_RUN_A", sourceEventId: "50" },
        legacySource: { actor: "Gemeente Utrecht" },
      }),
    } as any);
  });

  afterAll(() => app?.cleanup());

  it("lists only the authenticated owner's migration runs", async () => {
    const rows = await app.makeCaller(ownerA).legacyImports.listRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "LEGACY_RUN_A", sourceInstanceId: "workspace-a" });
    expect(rows[0].summary).toMatchObject({ excludedGlobalTables: ["outreach_directory_targets"] });
  });

  it("does not expose another owner's source table counts", async () => {
    const own = await app.makeCaller(ownerA).legacyImports.tableCounts({ runId: "LEGACY_RUN_A" });
    const other = await app.makeCaller(ownerA).legacyImports.tableCounts({ runId: "LEGACY_RUN_B" });
    expect(own).toEqual([{ sourceTable: "legal_cases", count: 1 }]);
    expect(other).toEqual([]);
  });

  it("includes archive rows in GDPR access and erasure", async () => {
    const exported = await app.makeCaller(ownerB).gdpr.exportData();
    expect(exported.data.legacy_import_runs).toHaveLength(1);
    expect(exported.data.legacy_import_records).toHaveLength(1);

    const caller = app.makeCaller(ownerB);
    await caller.gdpr.deleteData(await verifiedErasureInput(app, caller, ownerB.id));
    const after = await app.makeCaller(ownerA).legacyImports.tableCounts({ runId: "LEGACY_RUN_B" });
    expect(after).toEqual([]);
  });

  it("exposes imported events through the owner-scoped source-linked case timeline", async () => {
    const timeline = await app.makeCaller(ownerA).documentAnalysis.generateCaseTimeline({ caseId: "LEGACY_CASE_A" });
    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0]).toMatchObject({
      date: "2026-07-14",
      title: "Municipality issued its decision",
      actor: "Gemeente Utrecht",
      source: {
        evidenceId: "LEGACY_EVIDENCE_A",
        title: "Imported decision.pdf",
        citation: null,
      },
    });
    await expect(
      app.makeCaller(ownerB).documentAnalysis.generateCaseTimeline({ caseId: "LEGACY_CASE_A" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
