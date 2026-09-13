import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";

async function main() {
  const { values } = parseArgs({ options: {
    run: { type: "boolean", default: false }, database: { type: "string" }, storage: { type: "string" },
    owner: { type: "string" }, root: { type: "string" }, resume: { type: "string" },
    "max-steps": { type: "string", default: "100" }, "max-seconds": { type: "string", default: "300" },
    phase: { type: "string", default: "all" }, "retry-failed": { type: "boolean", default: false },
    "work-item": { type: "string" },
  } });
  if (!values.run) {
    console.log("Local-only owner import. Originals stay in place. Back up the database first.\n--run --database EXISTING.sqlite --storage SOURCE_DIRECTORY --owner USER_ID (--root FOLDER | --resume JOB_ID) [--max-steps 100] [--max-seconds 300] [--phase all|import|analysis] [--retry-failed]\nLimits are checked between work items; an in-flight extraction may take longer. Unfinished work is paused and can be resumed.");
    return;
  }
  if (!values.database || !values.storage || !values.owner || Boolean(values.root) === Boolean(values.resume)) {
    throw new Error("Specify an existing database, storage directory, owner and exactly one root or resume job");
  }
  const maxSteps = Number(values["max-steps"]), maxSeconds = Number(values["max-seconds"]);
  if (!["all", "analysis", "import"].includes(values.phase!) || ((values["retry-failed"] || values["work-item"]) && !values.resume)) throw new Error("Invalid phase or retry without a resume job");
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10000 || !Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 3600) {
    throw new Error("Limits must be whole numbers: 1..10000 steps and 1..3600 seconds");
  }
  const database = resolve(values.database), storage = resolve(values.storage);
  if (!existsSync(database)) throw new Error("Database must already exist; this command never creates an owner account");
  process.env.DATABASE_URL = database;
  process.env.LOCAL_STORAGE_DIR = storage;
  process.env.LARO_RUNTIME_MODE = "local";
  if (process.env.AWS_S3_BUCKET) throw new Error("Local source import refuses external evidence storage");
  const { getDb, closeDatabaseForMaintenance } = await import("../server/db");
  const { users, documentSourceJobs: jobs, documentSourceWork: work } = await import("../server/schema");
  const { grantLocalSourceRoot } = await import("../server/localDocumentSource");
  const { startDocumentSource, runSourceQueueStep } = await import("../server/documentSourceQueue");
  const { getWorkflowPreferences } = await import("../server/workflowPreferences");
  const { writeAuditLogOrThrow } = await import("../server/audit");
  const { isLocalLLMProvider } = await import("../server/llm");
  const db = await getDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) {
      throw new Error("Local operator import blocked an external request");
    }
    return originalFetch(input, init);
  };
  let jobId: string | undefined;
  let steps = 0;
  const started = Date.now();
  try {
    if (!db.select({ id: users.id }).from(users).where(eq(users.id, values.owner)).get()) throw new Error("Owner not found");
    const preferences = await getWorkflowPreferences(values.owner);
    if (preferences.analysisProvider !== "local" && !isLocalLLMProvider(preferences.analysisProvider)) {
      throw new Error("This operator import requires a local analysis provider; change the owner's preference in LARO first");
    }
    if (values.resume) {
      const job = db.select().from(jobs).where(and(eq(jobs.id, values.resume), eq(jobs.userId, values.owner))).get();
      if (!job || job.kind !== "local" || !["running", "paused"].includes(job.status)) throw new Error("Owned paused/running local import not found");
      const root = JSON.parse(job.config).root;
      if (await grantLocalSourceRoot(root) !== root) throw new Error("Source root identity changed");
      jobId = job.id;
      if (job.status === "paused") db.transaction(tx => {
        if (values["retry-failed"]) tx.update(work).set({ status: "queued", error: null, updatedAt: new Date() })
          .where(and(eq(work.jobId, job.id), eq(work.status, "failed"))).run();
        tx.update(jobs).set({ status: "running", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
        writeAuditLogOrThrow(tx, { userId: values.owner!, action: "source.resumed", entityType: "document_source_job", entityId: job.id, details: { operator: true, retryFailed: values["retry-failed"] } });
      });
    } else {
      const root = await grantLocalSourceRoot(values.root!);
      jobId = (await startDocumentSource(values.owner, { kind: "local", root }, { wake: false })).id;
    }
    console.log(JSON.stringify({ jobId, localOnly: true, maxSteps, maxSeconds }));
    const phase = values.phase === "all" ? undefined : values.phase as "analysis" | "import";
    while (steps < maxSteps && Date.now() - started < maxSeconds * 1000 && await runSourceQueueStep(jobId, phase, values["work-item"])) {
      steps++;
      if (steps % 25 === 0) console.log(JSON.stringify({ jobId, steps, elapsedSeconds: Math.round((Date.now() - started) / 1000) }));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (jobId) {
      db.transaction(tx => {
        const changed = tx.update(jobs).set({ status: "paused", updatedAt: new Date() }).where(and(eq(jobs.id, jobId!), eq(jobs.status, "running"))).run();
        if (changed.changes) writeAuditLogOrThrow(tx, { userId: values.owner!, action: "source.paused", entityType: "document_source_job", entityId: jobId!,
          details: { operator: true, reason: "Bounded operator run stopped", steps } });
      });
      const status = db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)).get();
      const outcomes = db.select({ kind: work.kind, status: work.status, count: sql<number>`count(*)` }).from(work)
        .where(eq(work.jobId, jobId)).groupBy(work.kind, work.status).all();
      console.log(JSON.stringify({ jobId, ...status, steps, outcomes }));
    }
    closeDatabaseForMaintenance();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "Local import failed"); process.exitCode = 1; });
