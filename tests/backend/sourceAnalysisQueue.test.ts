import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

(sqliteAvailable ? describe : describe.skip)("durable source analysis", () => {
  let app: TestApp;
  let sequence = 0;
  beforeAll(async () => { app = await bootTestApp(); });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => app?.cleanup());
  async function start(text: string) {
    const owner = { id: `PIPELINE_${++sequence}`, email: `pipeline-${sequence}@example.test`, role: "user" };
    await app.db.insert(app.schema.users).values(buildUser(owner));
    const root = join(app.tmpDir, owner.id); mkdirSync(root);
    writeFileSync(join(root, "source.txt"), text);
    const caller = app.makeCaller(owner, "session", true);
    const job = await caller.documentSources.start({ kind: "local", root });
    return { owner, root, caller, job };
  }
  async function drain() {
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    for (let i = 0; i < 30 && await runSourceQueueStep(); i++) { /* Bounded persisted work. */ }
  }

  it("commits the original and durable analysis work before starting analysis", async () => {
    const { caller, job } = await start("Zaaknummer: PIPE-2026-1001\nDe gemeente heeft het besluit op 2026-08-01 verzonden.");
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    await runSourceQueueStep();
    await runSourceQueueStep();
    await runSourceQueueStep(); // The bounded quick-screen pass precedes importing bytes.
    const saved = await caller.documentSources.get({ id: job.id });
    expect(saved.counts.imported).toBe(1);
    expect(saved.counts.analysisPending).toBe(1);
    expect(saved.counts.organized).toBe(0);
    expect(saved.job.status).toBe("running");
    await caller.documentSources.pause({ id: job.id });
    expect(await runSourceQueueStep()).toBe(false);
    await caller.documentSources.resume({ id: job.id });
    await drain();
    const result = await caller.documentSources.get({ id: job.id });
    expect(result.counts).toMatchObject({ imported: 1, organized: 1, analysisPending: 0, attention: 0 });
    expect(result.job.status).toBe("completed");
  });

  it("retries failed analysis from stored bytes without reading the provider again", async () => {
    const { caller, root, job } = await start("Zaaknummer: PIPE-2026-1002\nDe bewoner vraagt op 2026-08-02 om inzage.");
    const intelligence = await import("../../server/documentIntelligence");
    const extraction = vi.spyOn(intelligence, "extractDocumentTextInAcquiredSlot").mockRejectedValueOnce(Object.assign(new Error("Private parser details"), { code: "EACCES" }));
    await drain();
    const failed = await caller.documentSources.get({ id: job.id });
    expect(failed.job.status).toBe("completed_with_errors");
    expect(failed.counts).toMatchObject({ imported: 1, analysisFailed: 1, organized: 0 });
    expect(failed.latestFailures[0].failure.code).toBe("file_access");
    expect(failed.latestFailures[0].error).not.toContain("Private parser details");
    const filtered = await caller.documentSources.get({ id: job.id, filter: "failed" });
    expect(filtered.itemTotal).toBe(1);
    expect(filtered.items[0].failure.code).toBe("file_access");
    const events = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.entityId, filtered.items[0].id));
    expect(events.some((event: any) => event.action === "source.item_failed" && event.details.includes("file_access"))).toBe(true);
    writeFileSync(join(root, "source.txt"), "Different bytes in the source after import.");
    await caller.documentSources.resume({ id: job.id });
    await drain();
    const retried = await caller.documentSources.get({ id: job.id });
    expect(retried.job.status).toBe("completed");
    expect(retried.counts).toMatchObject({ imported: 1, organized: 1, analysisFailed: 0 });
    const item = (await caller.documentInbox.list({ view: "all" })).items[0];
    const stored = await app.db.select().from(app.schema.documentInbox).where(eq(app.schema.documentInbox.id, item.id));
    expect(stored[0].sourceText).toContain("PIPE-2026-1002");
    expect(extraction).toHaveBeenCalledTimes(2);
  });

  it("reports documents without a supported dossier decision as attention, not finished filing", async () => {
    const { caller, job } = await start("Een onduidelijk briefje zonder herkenbaar dossier of concrete situatie.");
    await drain();
    const result = await caller.documentSources.get({ id: job.id });
    expect(result.job.status).toBe("completed_with_attention");
    expect(result.counts).toMatchObject({ imported: 1, attention: 1, organized: 0, analyzed: 1 });
    expect(result.items.some((item: any) => item.kind === "inbox_analysis" && item.status === "needs_review")).toBe(true);
  });

  it("defers processing when automatic analysis is disabled and resumes only after it is enabled", async () => {
    const { owner, caller, job } = await start("Zaaknummer: PIPE-2026-1004\nEen brief over hetzelfde concrete geschil.");
    const { updateWorkflowPreferences } = await import("../../server/workflowPreferences");
    await updateWorkflowPreferences(owner.id, { autoAnalyzeImports: false });
    await drain();
    expect((await caller.documentSources.get({ id: job.id })).counts.deferred).toBe(1);
    await updateWorkflowPreferences(owner.id, { autoAnalyzeImports: true });
    await caller.documentSources.resume({ id: job.id });
    await drain();
    expect((await caller.documentSources.get({ id: job.id })).counts.organized).toBe(1);
    const logs = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.entityId, job.id));
    expect(logs.some((log: any) => log.action === "source.resumed")).toBe(true);
  });

  it("rescans a granted source without duplicating originals and preserves changed versions", async () => {
    const { caller, job, root } = await start("Zaaknummer: PIPE-2026-1005\nDe gemeente heeft op 2026-08-02 een besluit verzonden.");
    await drain();
    const next = await caller.documentSources.rescan({ id: job.id });
    expect(next.id).not.toBe(job.id);
    expect(await caller.documentSources.rescan({ id: job.id })).toEqual(next);
    await drain();
    expect((await caller.documentInbox.list({ view: "all" })).items).toHaveLength(1);
    writeFileSync(join(root, "source.txt"), "Zaaknummer: PIPE-2026-1005\nDe bewoner vraagt op 2026-08-03 om inzage.");
    await caller.documentSources.rescan({ id: next.id });
    await drain();
    const items = (await caller.documentInbox.list({ view: "all" })).items;
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item: any) => item.caseId)).size).toBe(1);
  });

  it("a bounded operator step processes only its selected job", async () => {
    const first = await start("First source");
    const second = await start("Second source");
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    await runSourceQueueStep(second.job.id);
    expect((await first.caller.documentSources.get({ id: first.job.id })).items[0].status).toBe("queued");
    await first.caller.documentSources.pause({ id: first.job.id });
    await second.caller.documentSources.pause({ id: second.job.id });
  });
});
