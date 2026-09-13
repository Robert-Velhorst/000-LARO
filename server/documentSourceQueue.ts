import { createHash, randomUUID } from "crypto";
import { sourceFailureMessage } from "../shared/sourceFailure";
import { z } from "zod";
import { and, asc, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { documentSourceJobs as jobs, documentSourceWork as work } from "./schema";
import { writeAuditLogOrThrow } from "./audit";
import { getOwnedInboxItem, processInboxDocument, stageInboxDocument } from "./documentInbox";
import { getWorkflowPreferences } from "./workflowPreferences";
import { executeLocalSourceWork, screenLocalSourceBatch, SourceScreenDeferred } from "./localDocumentSource";
import { executeGoogleSourceWork } from "./googleDocumentSource";
import { SourceSkip, sourceConfigurationSchema, type SourceConfiguration, type SourceWork } from "./documentSourceTypes";

const LEASE_MS = 120_000;
function completedAnalysis(raw: string | null): boolean {
  try {
    const result = raw ? JSON.parse(raw) : null;
    return Boolean(result?.coverage?.complete && !["unavailable", "partial", "invalid_response", "failed"].includes(result.providerStatus));
  } catch { return false; }
}
type Db = Awaited<ReturnType<typeof getDb>>;
type Writer = Pick<Db, "insert">;
export function sourceWorkId(jobId: string, item: Pick<SourceWork, "kind" | "key">): string {
  return createHash("sha256").update(JSON.stringify([jobId, item.kind, item.key])).digest("hex");
}
export function insertSourceWork(db: Writer, job: { id: string; userId: string }, item: SourceWork) {
  const now = new Date();
  db.insert(work).values({ id: sourceWorkId(job.id, item), jobId: job.id, userId: job.userId, kind: item.kind,
    label: item.label, payload: JSON.stringify(item.payload), isDocument: item.isDocument, inboxId: item.inboxId, createdAt: now, updatedAt: now })
    .onConflictDoNothing().run();
}

// Callers must verify source access first: native picker/operator for local paths,
// and account ownership for Google. The durable job itself carries no credentials.
export async function startDocumentSource(userId: string, config: SourceConfiguration, options: { wake?: boolean } = {}) {
  const db = await getDb();
  const initial: SourceWork = config.kind === "local"
    ? { kind: "local_page", key: config.root, label: config.root, isDocument: false, payload: { path: config.root } }
    : config.kind === "gmail"
      ? { kind: "gmail_page", key: "", label: "Gmail inventory", isDocument: false, payload: {} }
      : { kind: "drive_page", key: JSON.stringify([config.folderId || "", ""]), label: "Drive inventory", isDocument: false, payload: { folderId: config.folderId } };
  const now = new Date();
  const job = { id: randomUUID(), userId, kind: config.kind, config: JSON.stringify(config), status: "running", createdAt: now, updatedAt: now };
  const result = db.transaction(tx => {
    const existing = tx.select().from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.config, job.config), eq(jobs.status, "running"))).get();
    if (existing) return existing;
    tx.insert(jobs).values(job).run();
    insertSourceWork(tx, job, initial);
    writeAuditLogOrThrow(tx, { userId, action: "source.started", entityType: "document_source_job", entityId: job.id, details: { kind: config.kind } });
    return job;
  });
  if (options.wake !== false) wakeSourceQueue();
  return { id: result.id };
}

function settleJobs(db: Db, onlyJobId?: string) {
  db.transaction((tx) => {
    const running = tx.select().from(jobs).where(and(eq(jobs.status, "running"), onlyJobId ? eq(jobs.id, onlyJobId) : undefined)).all();
    for (const job of running) {
      if (tx.select({ id: work.id }).from(work).where(and(eq(work.jobId, job.id), inArray(work.status, ["queued", "running"]))).limit(1).get()) continue;
      const failed = tx.select({ id: work.id }).from(work).where(and(eq(work.jobId, job.id), eq(work.status, "failed"))).limit(1).get();
      const attention = tx.select({ id: work.id }).from(work).where(and(eq(work.jobId, job.id), inArray(work.status, ["needs_review", "deferred"]))).limit(1).get();
      const status = failed ? "completed_with_errors" : attention ? "completed_with_attention" : "completed";
      tx.update(jobs).set({ status, updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
      writeAuditLogOrThrow(tx, { userId: job.userId, action: "source.completed", entityType: "document_source_job", entityId: job.id, details: { status } });
    }
  });
}

export async function screenPendingLocalSourceWork(onlyJobId?: string): Promise<boolean> {
  const db = await getDb();
  const token = randomUUID();
  const claimed = db.transaction(tx => {
    const candidate = tx.select({ config: jobs.config, jobId: jobs.id }).from(work).innerJoin(jobs, eq(jobs.id, work.jobId))
      .where(and(eq(jobs.status, "running"), eq(jobs.kind, "local"), eq(work.userId, jobs.userId), eq(work.kind, "local_file"), eq(work.status, "queued"),
        onlyJobId ? eq(jobs.id, onlyJobId) : undefined, sql`case when json_valid(${work.payload}) then json_extract(${work.payload}, '$.screening.version') is null else 0 end`)).limit(1).get();
    if (!candidate) return null;
    const config = sourceConfigurationSchema.parse(JSON.parse(candidate.config));
    if (config.kind !== "local") return null;
    const items = tx.select().from(work).where(and(eq(work.jobId, candidate.jobId), eq(work.kind, "local_file"), eq(work.status, "queued"),
      sql`case when json_valid(${work.payload}) then json_extract(${work.payload}, '$.screening.version') is null else 0 end`)).limit(128).all();
    for (const item of items) tx.update(work).set({ status: "running", leaseToken: token, leaseUntil: Date.now() + LEASE_MS }).where(eq(work.id, item.id)).run();
    return { items, config };
  });
  if (!claimed) return false;
  const heartbeat = setInterval(() => { try { db.update(work).set({ leaseUntil: Date.now() + LEASE_MS }).where(eq(work.leaseToken, token)).run(); } catch { /* Persisted lease recovery. */ } }, 15_000);
  heartbeat.unref();
  try {
    const paths = claimed.items.map(item => {
      const payload = JSON.parse(item.payload);
      return typeof payload.path === "string" ? payload.path : "";
    });
    const screens = await screenLocalSourceBatch(claimed.config.root, paths);
    db.transaction(tx => {
      claimed.items.forEach((item, index) => {
        const owned = and(eq(work.id, item.id), eq(work.status, "running"), eq(work.leaseToken, token));
        if (!tx.select({ id: work.id }).from(work).where(owned).get()) return;
        const screening = screens[index];
        const payload = { ...JSON.parse(item.payload), screening };
        const deferred = screening.tier === "low" && !payload.allowLowPriority;
        tx.update(work).set({ payload: JSON.stringify(payload), status: deferred ? "deferred" : "queued", leaseToken: null, leaseUntil: null,
          error: deferred ? new SourceScreenDeferred(screening).message : null, updatedAt: new Date() }).where(owned).run();
        if (deferred) writeAuditLogOrThrow(tx, { userId: item.userId, action: "source.item_screened", entityType: "document_source_work", entityId: item.id,
          details: { jobId: item.jobId, screening, originalUnchanged: true } });
      });
    });
  } finally { clearInterval(heartbeat); }
  return true;
}

export async function runSourceQueueStep(onlyJobId?: string, phase?: "analysis" | "import", onlyWorkId?: string): Promise<boolean> {
  if (onlyWorkId && !onlyJobId) throw new Error("A targeted work item requires its source job");
  if (phase !== "analysis" && !onlyWorkId && await screenPendingLocalSourceWork(onlyJobId)) return true;
  const db = await getDb();
  const claimed = db.transaction((tx) => {
    const row = tx.select({ item: work, config: jobs.config }).from(work).innerJoin(jobs, and(eq(jobs.id, work.jobId), eq(jobs.userId, work.userId)))
      .where(and(eq(jobs.status, "running"), onlyJobId ? eq(jobs.id, onlyJobId) : undefined,
        onlyWorkId ? eq(work.id, onlyWorkId) : undefined,
        phase === "analysis" ? eq(work.kind, "inbox_analysis") : phase === "import" ? ne(work.kind, "inbox_analysis") : undefined,
        or(eq(work.status, "queued"), and(eq(work.status, "running"), lt(work.leaseUntil, Date.now())))))
      .orderBy(sql`case when ${work.kind} in ('local_page', 'drive_page', 'gmail_page', 'gmail_message') then 0
        when ${work.kind} = 'inbox_analysis' then 3
        when json_valid(${work.payload}) then case when json_extract(${work.payload}, '$.screening.tier') = 'priority' then 1 else 2 end else 2 end`, asc(work.updatedAt), asc(work.id)).limit(1).get();
    if (!row) return null;
    const leaseToken = randomUUID();
    tx.update(work).set({ status: "running", leaseToken, leaseUntil: Date.now() + LEASE_MS, updatedAt: new Date() }).where(eq(work.id, row.item.id)).run();
    return { ...row.item, config: row.config, leaseToken };
  });
  if (!claimed) { settleJobs(db, onlyJobId); return false; }
  const ownedLease = and(eq(work.id, claimed.id), eq(work.leaseToken, claimed.leaseToken), eq(work.status, "running"));
  const assertLease = () => {
    if (!db.select({ id: work.id }).from(work).where(ownedLease).get()) throw new Error("Source work lease is no longer held");
  };
  const heartbeat = setInterval(() => {
    try { db.update(work).set({ leaseUntil: Date.now() + LEASE_MS }).where(ownedLease).run(); }
    catch { /* Failure does not grant permission to commit under a lost lease. */ }
  }, 15_000);
  heartbeat.unref();
  try {
    const config = sourceConfigurationSchema.parse(JSON.parse(claimed.config));
    const payload = JSON.parse(claimed.payload);
    if (claimed.kind === "inbox_analysis") {
      const { inboxId } = z.object({ inboxId: z.string().uuid() }).parse(payload);
      const row = await getOwnedInboxItem(claimed.userId, inboxId);
      const preferences = await getWorkflowPreferences(claimed.userId);
      let status = "deferred";
      let error: string | null = "Automatic analysis is disabled; the original is preserved";
      if (preferences.autoAnalyzeImports) {
        const complete = completedAnalysis(row.analysis) && !row.error &&
          (preferences.analysisProvider === "local" || JSON.parse(row.analysis!).analysisProvider === preferences.analysisProvider);
        assertLease();
        const outcome = await processInboxDocument(claimed.userId, inboxId, !complete);
        const current = await getOwnedInboxItem(claimed.userId, inboxId);
        if (!completedAnalysis(current.analysis)) {
          status = "failed";
          let providerMessage = "Document analysis is incomplete";
          try { providerMessage = JSON.parse(current.analysis || "null")?.providerMessage || providerMessage; } catch { /* Incomplete stored analysis. */ }
          error = sourceFailureMessage(current.error || providerMessage);
        } else if (!outcome.caseId) {
          status = "needs_review";
          error = current.reason || "No source-supported dossier assignment is available yet";
        } else { status = "done"; error = null; }
      }
      assertLease();
      db.transaction(tx => {
        if (!tx.select({ id: work.id }).from(work).where(ownedLease).get()) return;
        if (status === "failed") writeAuditLogOrThrow(tx, { userId: claimed.userId, action: "source.item_failed", entityType: "document_source_work",
          entityId: claimed.id, details: { jobId: claimed.jobId, kind: claimed.kind, reason: error } });
        tx.update(work).set({ status, inboxId, error, leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(ownedLease).run();
        tx.update(jobs).set({ updatedAt: new Date() }).where(eq(jobs.id, claimed.jobId)).run();
      });
      settleJobs(db, onlyJobId);
      return true;
    }
    const result = config.kind === "local" ? await executeLocalSourceWork(config, claimed.kind, payload)
      : await executeGoogleSourceWork(claimed.userId, config, claimed.kind, payload);
    assertLease();
    let inboxId: string | null = null;
    if (result.document) {
      const staged = await stageInboxDocument(claimed.userId, result.document);
      inboxId = staged.id;
      assertLease();
    }
    db.transaction((tx) => {
      if (!tx.select({ id: work.id }).from(work).where(ownedLease).get()) return;
      let continuationError: string | null = null;
      if (inboxId) insertSourceWork(tx, { id: claimed.jobId, userId: claimed.userId }, {
        kind: "inbox_analysis", key: inboxId, label: result.document!.fileName, isDocument: false, inboxId, payload: { inboxId },
      });
      for (const child of result.children || []) {
        if (child.continuation && tx.select({ id: work.id }).from(work).where(eq(work.id, sourceWorkId(claimed.jobId, child))).get()) {
          continuationError = "Source repeated a continuation cursor; inventory is incomplete";
          continue;
        }
        insertSourceWork(tx, { id: claimed.jobId, userId: claimed.userId }, child);
      }
      tx.update(work).set({ status: continuationError ? "failed" : "done", inboxId, error: continuationError,
        leaseToken: null, leaseUntil: null, updatedAt: new Date() }).where(ownedLease).run();
      tx.update(jobs).set({ updatedAt: new Date() }).where(eq(jobs.id, claimed.jobId)).run();
    });
  } catch (error) {
    db.transaction(tx => {
      if (!tx.select({ id: work.id }).from(work).where(ownedLease).get()) return;
      const check = error instanceof SourceSkip ? error.check : null;
      const screen = error instanceof SourceScreenDeferred ? error.screen : null;
      const reason = (check || screen) && error instanceof Error ? error.message.slice(0, 1500) : sourceFailureMessage(error);
      const status = screen ? "deferred" : check ? check.outcome === "excluded" ? "skipped" : "needs_review" : "failed";
      // Commit the decision and its evidence together, and only under the current lease.
      if (check) writeAuditLogOrThrow(tx, { userId: claimed.userId, action: "source.item_checked", entityType: "document_source_work",
        entityId: claimed.id, details: { jobId: claimed.jobId, check, reason } });
      else if (screen) writeAuditLogOrThrow(tx, { userId: claimed.userId, action: "source.item_screened", entityType: "document_source_work", entityId: claimed.id,
        details: { jobId: claimed.jobId, screening: screen, originalUnchanged: true } });
      else writeAuditLogOrThrow(tx, { userId: claimed.userId, action: "source.item_failed", entityType: "document_source_work",
        entityId: claimed.id, details: { jobId: claimed.jobId, kind: claimed.kind, reason } });
      tx.update(work).set({ status, ...(screen ? { payload: JSON.stringify({ ...JSON.parse(claimed.payload), screening: screen }) } : {}),
        leaseToken: null, leaseUntil: null, error: reason, updatedAt: new Date() }).where(ownedLease).run();
    });
  } finally { clearInterval(heartbeat); }
  settleJobs(db, onlyJobId);
  return true;
}

let draining = false;
export async function drainSourceQueue() {
  if (draining) return;
  draining = true;
  let more = false;
  try {
    const started = Date.now();
    for (let step = 0; step < 25; step++) {
      more = await runSourceQueueStep();
      if (!more || Date.now() - started >= 30_000) break;
    }
  } finally { draining = false; }
  if (more) wakeSourceQueue();
}
export function wakeSourceQueue() {
  if (process.env.NODE_ENV === "test") return;
  const timer = setTimeout(() => { void drainSourceQueue().catch(() => console.warn("[SourceQueue] Worker failed; persisted leases remain recoverable")); }, 100);
  timer.unref();
}
