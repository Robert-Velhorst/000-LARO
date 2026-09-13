import { z } from "zod";
import { describeSourceFailure } from "../../shared/sourceFailure";
import { sourceScreenSchema } from "../../shared/sourceScreening";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { auditLogs, documentInbox, documentSourceJobs as jobs, documentSourceWork as work, emailAccounts } from "../schema";
import { grantLocalSourceRoot } from "../localDocumentSource";
import { startDocumentSource, wakeSourceQueue } from "../documentSourceQueue";
import { writeAuditLogOrThrow } from "../audit";
import { sourceCheckSchema, sourceConfigurationSchema } from "../documentSourceTypes";
import { checkGoogleSourceConnection, requireSourceGoogleAccount } from "../googleDocumentSource";

const identity = z.object({ id: z.string().uuid() });
async function ownedJob(userId: string, id: string) {
  const db = await getDb();
  const job = db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.userId, userId))).get();
  if (!job) throw new TRPCError({ code: "NOT_FOUND", message: "Source job not found" });
  return { db, job };
}
export const documentSourcesRouter = router({
  checkConnection: protectedProcedure.input(z.object({ accountId: z.string().min(1).max(200), kind: z.enum(["gmail", "drive"]) }))
    .mutation(({ ctx, input }) => checkGoogleSourceConnection(ctx.user.id, input.accountId, input.kind)),
  accounts: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    return db.select({ id: emailAccounts.id, email: emailAccounts.email, status: emailAccounts.status }).from(emailAccounts)
      .where(and(eq(emailAccounts.userId, ctx.user.id), eq(emailAccounts.provider, "gmail")));
  }),
  start: protectedProcedure.input(sourceConfigurationSchema)
    .mutation(async ({ ctx, input }) => {
      let config = input;
      if (input.kind === "local") {
        if (!ctx.desktopScanner) throw new TRPCError({ code: "FORBIDDEN", message: "Local source selection requires the trusted desktop folder picker" });
        config = { ...input, root: await grantLocalSourceRoot(input.root) };
      } else {
        await requireSourceGoogleAccount(ctx.user.id, input.accountId);
      }
      return startDocumentSource(ctx.user.id, config);
    }),
  rescan: protectedProcedure.input(identity).mutation(async ({ ctx, input }) => {
    const { job } = await ownedJob(ctx.user.id, input.id);
    const config = sourceConfigurationSchema.parse(JSON.parse(job.config));
    if (config.kind === "local") {
      if (await grantLocalSourceRoot(config.root) !== config.root) throw new TRPCError({ code: "CONFLICT", message: "The granted source folder moved; select it again on the desktop" });
    } else await requireSourceGoogleAccount(ctx.user.id, config.accountId);
    return startDocumentSource(ctx.user.id, config);
  }),
  list: protectedProcedure.input(z.object({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(30).default(10) }).default({})).query(async ({ ctx, input }) => {
    const db = await getDb();
    const where = eq(jobs.userId, ctx.user.id);
    return { items: db.select().from(jobs).where(where).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(input.limit).offset(input.offset).all(),
      total: db.select({ count: sql<number>`count(*)` }).from(jobs).where(where).get()!.count };
  }),
  get: protectedProcedure.input(identity.extend({ offset: z.number().int().min(0).default(0), filter: z.enum(["all", "exceptions", "failed", "deferred"]).default("all") })).query(async ({ ctx, input }) => {
    const { db, job } = await ownedJob(ctx.user.id, input.id);
    const rows = db.select({ status: work.status, kind: work.kind, isDocument: work.isDocument, count: sql<number>`count(*)`, imported: sql<number>`sum(case when ${work.inboxId} is not null then 1 else 0 end)` })
      .from(work).where(eq(work.jobId, job.id)).groupBy(work.status, work.kind, work.isDocument).all();
    const counts = { discovered: 0, imported: 0, skipped: 0, failed: 0, pending: 0, inventoryPending: 0,
      analysisPending: 0, analysisFailed: 0, attention: 0, intakeAttention: 0, intakeDeferred: 0, deferred: 0, analyzed: 0, organized: 0 };
    for (const row of rows) {
      if (row.isDocument) { counts.discovered += row.count; counts.imported += Number(row.imported || 0); }
      if (row.status === "failed") counts.failed += row.count;
      if (row.status === "skipped") counts.skipped += row.count;
      if (row.kind !== "inbox_analysis" && row.status === "needs_review") counts.intakeAttention += row.count;
      if (row.kind !== "inbox_analysis" && row.status === "deferred") counts.intakeDeferred += row.count;
      if (row.kind === "inbox_analysis") {
        if (["queued", "running"].includes(row.status)) counts.analysisPending += row.count;
        if (row.status === "failed") counts.analysisFailed += row.count;
        if (row.status === "needs_review") counts.attention += row.count;
        if (row.status === "deferred") counts.deferred += row.count;
      }
      if (["queued", "running"].includes(row.status)) {
        counts.pending += row.count;
        if (!row.isDocument && row.kind !== "inbox_analysis") counts.inventoryPending += row.count;
      }
    }
    const outcomes = db.select({
      analyzed: sql<number>`count(distinct case when json_valid(${documentInbox.analysis}) then case when json_extract(${documentInbox.analysis}, '$.coverage.complete') = 1
        and coalesce(json_extract(${documentInbox.analysis}, '$.providerStatus'), 'not_requested') not in ('unavailable', 'partial', 'invalid_response', 'failed')
        and ${documentInbox.error} is null then ${documentInbox.id} end end)`,
      organized: sql<number>`count(distinct case when ${documentInbox.evidenceId} is not null then ${documentInbox.id} end)`,
    }).from(work).innerJoin(documentInbox, and(eq(documentInbox.id, work.inboxId), eq(documentInbox.userId, ctx.user.id)))
      .where(and(eq(work.jobId, job.id), eq(work.isDocument, true))).get();
    counts.analyzed = outcomes?.analyzed || 0;
    counts.organized = outcomes?.organized || 0;
    const itemWhere = and(eq(work.jobId, job.id), ["failed", "deferred"].includes(input.filter) ? eq(work.status, input.filter) : input.filter === "exceptions" ? inArray(work.status, ["skipped", "needs_review", "failed"]) : undefined);
    const page = db.select({ id: work.id, kind: work.kind, label: work.label, status: work.status, error: work.error, inboxId: work.inboxId, payload: work.payload })
      .from(work).where(itemWhere).orderBy(desc(work.updatedAt), desc(work.id)).limit(20).offset(input.offset).all();
    // Fetch only the latest recorded check for each visible item, in one bounded result.
    const latest = db.select({ rowId: sql<number>`max(rowid)` }).from(auditLogs).where(and(eq(auditLogs.userId, ctx.user.id),
      eq(auditLogs.entityType, "document_source_work"), inArray(auditLogs.entityId, page.map(item => item.id)),
      eq(auditLogs.action, "source.item_checked"))).groupBy(auditLogs.entityId);
    const checks = new Map(page.length ? db.select({ entityId: auditLogs.entityId, details: auditLogs.details }).from(auditLogs)
      .where(inArray(sql`rowid`, latest)).all().map(row => [row.entityId, row.details]) : []);
    const items = page.map(item => {
        const { payload, ...visible } = item;
        let check = null;
        let screening = null;
        try { screening = sourceScreenSchema.parse(JSON.parse(payload)?.screening); } catch { /* Unscreened or legacy item. */ }
        try { check = sourceCheckSchema.parse(JSON.parse(checks.get(item.id) || "null")?.check); } catch { /* Legacy skips remain explicitly unverified. */ }
        return { ...visible, check, screening, failure: item.status === "failed" ? describeSourceFailure(item.error) : null };
      });
    const itemTotal = db.select({ count: sql<number>`count(*)` }).from(work).where(itemWhere).get()!.count;
    const latestFailures = db.select({ id: work.id, label: work.label, kind: work.kind, error: work.error, inboxId: work.inboxId, updatedAt: work.updatedAt })
      .from(work).where(and(eq(work.jobId, job.id), eq(work.status, "failed"))).orderBy(desc(work.updatedAt), desc(work.id)).limit(3).all()
      .map(item => ({ ...item, failure: describeSourceFailure(item.error) }));
    const screening = db.select({ tier: sql<string>`json_extract(${work.payload}, '$.screening.tier')`, count: sql<number>`count(*)`,
      fileBytes: sql<number>`sum(json_extract(${work.payload}, '$.screening.fileBytes'))`,
      sampledBytes: sql<number>`sum(json_extract(${work.payload}, '$.screening.sampledBytes'))`,
      sampledFiles: sql<number>`sum(case when json_extract(${work.payload}, '$.screening.sampledBytes') > 0 then 1 else 0 end)` })
      .from(work).where(and(eq(work.jobId, job.id), eq(work.kind, "local_file"),
        sql`case when json_valid(${work.payload}) then json_extract(${work.payload}, '$.screening.version') = 1 else 0 end`))
      .groupBy(sql`json_extract(${work.payload}, '$.screening.tier')`).all();
    return { job, counts, items, itemTotal, latestFailures, screening, total: rows.reduce((sum, row) => sum + row.count, 0) };
  }),
  recheck: protectedProcedure.input(identity.extend({ workId: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(async ({ ctx, input }) => {
    const { db, job } = await ownedJob(ctx.user.id, input.id);
    db.transaction(tx => {
      const item = tx.select().from(work).where(and(eq(work.id, input.workId), eq(work.jobId, job.id), eq(work.userId, ctx.user.id))).get();
      if (!item) throw new TRPCError({ code: "NOT_FOUND", message: "Source item not found" });
      if (item.kind === "inbox_analysis" || !["skipped", "needs_review", "failed", "deferred"].includes(item.status)) {
        throw new TRPCError({ code: "CONFLICT", message: "Only stopped source intake items can be checked again" });
      }
      tx.update(work).set({ status: "queued", error: null, leaseToken: null, leaseUntil: null,
        ...(item.status === "deferred" ? { payload: JSON.stringify({ ...JSON.parse(item.payload), allowLowPriority: true }) } : {}),
        updatedAt: new Date() }).where(eq(work.id, item.id)).run();
      // Respect an operator pause; queueing a check must not unpause the source.
      tx.update(jobs).set({ status: job.status === "paused" ? "paused" : "running", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
      writeAuditLogOrThrow(tx, { userId: ctx.user.id, action: "source.item_recheck_requested", entityType: "document_source_work",
        entityId: item.id, details: { jobId: job.id, previousStatus: item.status, previousReason: item.error, allowLowPriority: item.status === "deferred" } });
    });
    if (job.status !== "paused") wakeSourceQueue();
    return { queued: true, paused: job.status === "paused" };
  }),
  pause: protectedProcedure.input(identity).mutation(async ({ ctx, input }) => {
    const { db, job } = await ownedJob(ctx.user.id, input.id);
    db.transaction((tx) => {
      const changed = tx.update(jobs).set({ status: "paused", updatedAt: new Date() }).where(and(eq(jobs.id, job.id), eq(jobs.status, "running"))).run();
      if (!changed.changes) return;
      writeAuditLogOrThrow(tx, { userId: ctx.user.id, action: "source.paused", entityType: "document_source_job", entityId: job.id });
    });
    return { success: true };
  }),
  resume: protectedProcedure.input(identity).mutation(async ({ ctx, input }) => {
    const { db, job } = await ownedJob(ctx.user.id, input.id);
    db.transaction((tx) => {
      const current = tx.select().from(jobs).where(eq(jobs.id, job.id)).get();
      if (!current || !["paused", "completed_with_errors", "completed_with_attention"].includes(current.status)) return;
      if (current.status !== "paused") tx.update(work).set({ status: "queued", error: null, updatedAt: new Date() })
        .where(and(eq(work.jobId, job.id), or(inArray(work.status, ["failed", "needs_review"]), and(eq(work.kind, "inbox_analysis"), eq(work.status, "deferred"))))).run();
      tx.update(jobs).set({ status: "running", updatedAt: new Date() }).where(eq(jobs.id, job.id)).run();
      writeAuditLogOrThrow(tx, { userId: ctx.user.id, action: "source.resumed", entityType: "document_source_job", entityId: job.id });
    });
    wakeSourceQueue(); return { success: true };
  }),
});
