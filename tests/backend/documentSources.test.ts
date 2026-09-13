import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

(sqliteAvailable ? describe : describe.skip)("durable document sources", () => {
  let app: TestApp;
  let root: string;
  const owner = { id: "SOURCE_OWNER", email: "source-owner@example.test", role: "user" };
  const other = { id: "SOURCE_OTHER", email: "source-other@example.test", role: "user" };
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    root = join(app.tmpDir, "originals"); mkdirSync(root);
    mkdirSync(join(root, "subfolder"));
    writeFileSync(join(root, "generic-name.txt"), "Zaaknummer: SOURCE-2026-1234\nOp 2026-08-01 verklaart de gemeente dat het besluit is verzonden.");
    writeFileSync(join(root, "subfolder", "another.txt"), "Zaaknummer: SOURCE-2026-1234\nOp 2026-08-10 verzoekt de bewoner om de ontbrekende stukken.");
    writeFileSync(join(root, "unsupported.exe"), "Unsupported source fixture");
  });
  afterAll(() => app?.cleanup());

  it("requires a native scanner credential for local paths and scopes all controls to the owner", async () => {
    await expect(app.makeCaller(owner).documentSources.start({ kind: "local", root })).rejects.toThrow(/desktop/i);
    const job = await app.makeCaller(owner, "session", true).documentSources.start({ kind: "local", root });
    await expect(app.makeCaller(other).documentSources.get({ id: job.id })).rejects.toThrow(/not found/i);
    await app.makeCaller(owner).documentSources.pause({ id: job.id });
  });

  it("builds a dossier from real folder contents, retains progress across pause/resume and does not duplicate retries", async () => {
    const caller = app.makeCaller(owner, "session", true);
    const job = await caller.documentSources.start({ kind: "local", root });
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    expect(await runSourceQueueStep()).toBe(true);
    await caller.documentSources.pause({ id: job.id });
    expect(await runSourceQueueStep()).toBe(false);
    expect((await caller.documentSources.get({ id: job.id })).job.status).toBe("paused");
    await caller.documentSources.resume({ id: job.id });
    for (let i = 0; i < 20 && await runSourceQueueStep(); i++) { /* Drain bounded test work. */ }
    const finished = await caller.documentSources.get({ id: job.id });
    expect(finished.job.status).toBe("completed_with_attention");
    expect(finished.counts.imported).toBe(2);
    expect(finished.counts.skipped).toBe(0);
    expect(finished.counts.intakeAttention).toBe(1);
    const unsupported = finished.items.find((item: any) => item.label.endsWith("unsupported.exe"));
    expect(unsupported.status).toBe("needs_review");
    expect(unsupported.check).toMatchObject({ code: "unsupported_format", contentAssessed: false,
      facts: { extension: ".exe", sizeBytes: 26 } });
    const inbox = await caller.documentInbox.list({ view: "all" });
    expect(inbox.items).toHaveLength(2);
    expect(new Set(inbox.items.map((item: any) => item.caseId)).size).toBe(1);
    expect(inbox.items.every((item: any) => item.caseId)).toBe(true);
    const evidence = await caller.evidenceFiles.byCase({ caseId: inbox.items[0].caseId });
    expect(evidence.every((item: any) => item.source === "local")).toBe(true);
    const second = await caller.documentSources.start({ kind: "local", root });
    for (let i = 0; i < 20 && await runSourceQueueStep(); i++) { /* Repeat source inventory. */ }
    expect((await caller.documentSources.get({ id: second.id })).counts.imported).toBe(2);
    expect((await caller.documentInbox.list({ view: "all" })).items).toHaveLength(2);
    expect(writeFileSync(join(root, "generic-name.txt"), "Zaaknummer: SOURCE-2026-1234\nChanged original version.")).toBeUndefined();
    await caller.documentSources.start({ kind: "local", root });
    for (let i = 0; i < 20 && await runSourceQueueStep(); i++) { /* Discover the changed version. */ }
    expect((await caller.documentInbox.list({ view: "all" })).items).toHaveLength(3);
  });

  it("recovers an expired persisted work lease without treating an active lease as stopped", async () => {
    const caller = app.makeCaller(owner, "session", true);
    const job = await caller.documentSources.start({ kind: "local", root });
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    await app.db.update(app.schema.documentSourceWork).set({ status: "running", leaseToken: "old-worker", leaseUntil: Date.now() + 60_000 })
      .where(eq(app.schema.documentSourceWork.jobId, job.id));
    expect(await runSourceQueueStep()).toBe(false);
    await app.db.update(app.schema.documentSourceWork).set({ leaseUntil: Date.now() - 1 }).where(eq(app.schema.documentSourceWork.jobId, job.id));
    expect(await runSourceQueueStep()).toBe(true);
    await caller.documentSources.pause({ id: job.id });
  });

  it("resumes large directories by filename without losing entries across pages", async () => {
    const folder = join(app.tmpDir, "paged"); mkdirSync(folder);
    for (let index = 0; index < 105; index++) writeFileSync(join(folder, `document-${String(index).padStart(3, "0")}.txt`), "Source fixture");
    const { executeLocalSourceWork, grantLocalSourceRoot } = await import("../../server/localDocumentSource");
    const canonical = await grantLocalSourceRoot(folder);
    const first = await executeLocalSourceWork({ kind: "local", root: canonical }, "local_page", { path: canonical });
    expect(first.children?.filter((item) => item.isDocument)).toHaveLength(100);
    const next = first.children!.find((item) => item.continuation)!;
    const second = await executeLocalSourceWork({ kind: "local", root: canonical }, "local_page", next.payload);
    expect(second.children).toHaveLength(5);
    expect(new Set([...first.children!, ...second.children!].filter((item) => item.isDocument).map((item) => item.key)).size).toBe(105);
  });

  it("does not traverse a junction or symlink outside the granted folder", async () => {
    const folder = join(app.tmpDir, "boundary"); mkdirSync(folder);
    const outside = join(app.tmpDir, "outside"); mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "Do not import outside the source root.");
    symlinkSync(outside, join(folder, "escape"), process.platform === "win32" ? "junction" : "dir");
    const caller = app.makeCaller(owner, "session", true);
    const job = await caller.documentSources.start({ kind: "local", root: folder });
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    for (let i = 0; i < 5 && await runSourceQueueStep(); i++) { /* Only the junction itself is inspected. */ }
    const result = await caller.documentSources.get({ id: job.id });
    expect(result.counts.imported).toBe(0);
    expect(result.counts.skipped).toBe(1);
    expect(result.items.some((item: any) => item.label.endsWith("private.txt"))).toBe(false);
  });

  it("excludes secrets, caches and software trees from broad local intake", async () => {
    const folder = join(app.tmpDir, "broad-source"); mkdirSync(folder);
    for (const name of ["AppData", ".ssh", ".codex", "node_modules", "Windows", "Codex"]) {
      mkdirSync(join(folder, name)); writeFileSync(join(folder, name, "private.txt"), "Must not be read");
    }
    writeFileSync(join(folder, "passwords.txt"), "Must not be read");
    writeFileSync(join(folder, "decision.txt"), "Zaaknummer: SCOPE-2026-4401\nDe gemeente heeft een besluit verzonden.");
    const caller = app.makeCaller(owner, "session", true);
    const job = await caller.documentSources.start({ kind: "local", root: folder });
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    for (let i = 0; i < 25 && await runSourceQueueStep(); i++) { /* Excluded trees are not traversed. */ }
    const result = await caller.documentSources.get({ id: job.id });
    expect(result.counts.imported).toBe(1);
    expect(result.counts.skipped).toBe(7);
    expect(result.items.some((item: any) => item.label.endsWith("private.txt"))).toBe(false);
    const excluded = result.items.find((item: any) => item.label.endsWith("passwords.txt"));
    expect(excluded.check).toMatchObject({ outcome: "excluded", basis: "path_policy", code: "protected_path", contentAssessed: false });
    const review = await caller.documentSources.get({ id: job.id, filter: "exceptions" });
    expect(review.itemTotal).toBe(7);
    expect(review.items.every((item: any) => item.status === "skipped")).toBe(true);
    await expect(app.makeCaller(other).documentSources.recheck({ id: job.id, workId: excluded.id })).rejects.toThrow(/not found/i);
    await caller.documentSources.recheck({ id: job.id, workId: excluded.id });
    await runSourceQueueStep(job.id, "import", excluded.id);
    const checked = await caller.documentSources.get({ id: job.id, filter: "exceptions" });
    expect(checked.items.find((item: any) => item.id === excluded.id).status).toBe("skipped");
    expect(checked.counts.imported).toBe(1);
    const history = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.entityId, excluded.id));
    expect(history.filter((event: any) => event.action === "source.item_checked")).toHaveLength(2);
    expect(history.filter((event: any) => event.action === "source.item_recheck_requested")).toHaveLength(1);
  });

  it("keeps empty and oversized originals as intake review with measured evidence", async () => {
    const folder = join(app.tmpDir, "limits"); mkdirSync(folder);
    writeFileSync(join(folder, "empty.txt"), "");
    writeFileSync(join(folder, "large.txt"), Buffer.alloc(7 * 1024 * 1024 + 1));
    const caller = app.makeCaller(owner, "session", true);
    const job = await caller.documentSources.start({ kind: "local", root: folder });
    const { runSourceQueueStep } = await import("../../server/documentSourceQueue");
    for (let i = 0; i < 5 && await runSourceQueueStep(job.id); i++) { /* No analysis or downloads. */ }
    const result = await caller.documentSources.get({ id: job.id, filter: "exceptions" });
    expect(result.counts).toMatchObject({ skipped: 0, intakeAttention: 2, imported: 0 });
    expect(result.items.map((item: any) => item.check.code).sort()).toEqual(["empty_file", "size_limit"]);
    expect(result.items.every((item: any) => item.check.contentAssessed === false)).toBe(true);
    const empty = result.items.find((item: any) => item.label.endsWith("empty.txt"));
    expect(empty.check.facts.sizeBytes).toBe(0);
    await app.db.update(app.schema.documentSourceJobs).set({ status: "paused" }).where(eq(app.schema.documentSourceJobs.id, job.id));
    expect(await caller.documentSources.recheck({ id: job.id, workId: empty.id })).toEqual({ queued: true, paused: true });
    expect(await runSourceQueueStep(job.id)).toBe(false);
    expect((await caller.documentSources.get({ id: job.id })).job.status).toBe("paused");
    await expect(caller.documentSources.recheck({ id: job.id, workId: empty.id })).rejects.toThrow(/stopped/i);
    await caller.documentSources.resume({ id: job.id });
    expect((await caller.documentSources.get({ id: job.id })).counts.intakeAttention).toBe(1);
    await caller.documentSources.pause({ id: job.id });
  });

  it("does not fabricate verification for a legacy skipped item", async () => {
    const caller = app.makeCaller(owner, "session", true);
    const job = await caller.documentSources.start({ kind: "local", root });
    await app.db.update(app.schema.documentSourceWork).set({ status: "skipped", error: "Legacy reason" }).where(eq(app.schema.documentSourceWork.jobId, job.id));
    const result = await caller.documentSources.get({ id: job.id, filter: "exceptions" });
    expect(result.items[0].check).toBeNull();
    await caller.documentSources.pause({ id: job.id });
  });

  it("exports and erases persisted source jobs and work with the owning account", async () => {
    const disposable = { id: "SOURCE_ERASURE", email: "source-erasure@example.test", role: "user" };
    await app.db.insert(app.schema.users).values(buildUser(disposable));
    await app.makeCaller(disposable, "session", true).documentSources.start({ kind: "local", root });
    const { exportUserData, deleteUserData } = await import("../../server/gdpr");
    const exported = await exportUserData(disposable.id);
    expect(exported.document_source_jobs).toHaveLength(1);
    expect(exported.document_source_work).toHaveLength(1);
    await deleteUserData(disposable.id);
    expect(await app.db.select().from(app.schema.documentSourceJobs).where(eq(app.schema.documentSourceJobs.userId, disposable.id))).toHaveLength(0);
    expect(await app.db.select().from(app.schema.documentSourceWork).where(eq(app.schema.documentSourceWork.userId, disposable.id))).toHaveLength(0);
  });

  it("paginates all source jobs and only audits actual pause/resume transitions", async () => {
    const caller = app.makeCaller(owner, "session", true);
    const job = await caller.documentSources.start({ kind: "local", root });
    await caller.documentSources.pause({ id: job.id });
    await caller.documentSources.pause({ id: job.id });
    await caller.documentSources.resume({ id: job.id });
    await caller.documentSources.resume({ id: job.id });
    await caller.documentSources.pause({ id: job.id });
    const events = await app.db.select().from(app.schema.auditLogs).where(eq(app.schema.auditLogs.entityId, job.id));
    expect(events.filter((event: any) => event.action === "source.resumed")).toHaveLength(1);
    expect(events.filter((event: any) => event.action === "source.paused")).toHaveLength(2);
    const first = await caller.documentSources.list({ offset: 0, limit: 2 });
    const next = await caller.documentSources.list({ offset: 2, limit: 2 });
    expect(first.total).toBeGreaterThan(2);
    expect(first.items).toHaveLength(2);
    expect(first.items.some((item: any) => next.items.some((otherItem: any) => item.id === otherItem.id))).toBe(false);
  });
});
