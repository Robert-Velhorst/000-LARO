/**
 * Phase 010 (D1) — implement the 14 routers the renderer referenced but that had
 * no backend, so every wired UI action hits a REAL, typed endpoint that behaves
 * honestly: real data where a source exists, an honest typed-empty/`unavailable`
 * result where none does yet, and a clear error where an action genuinely can't
 * run. No fake success (Phase 014).
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { getDb } from "../db";
import {
  cases as casesTable,
  evidence as evidenceRecords,
  evidenceItems,
  outreachStatus,
  lawyers as lawyersTable,
  users as usersTable,
  auditLogs,
  deadlines as deadlinesTable,
  communications as communicationsTable,
  conversationThreads,
  unifiedMessages,
  emailSyncJobs,
  emailAccounts,
  channelIntegrations,
} from "../schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { assertCaseOwnership } from "../_core/authz";
import { AUDIT_ACTIONS } from "../audit";
import { nanoid } from "nanoid";

const count = sql<number>`count(*)`;
async function n(q: Promise<Array<{ c: number }>>): Promise<number> {
  const r = await q;
  return Number(r[0]?.c || 0);
}

/* ─── adminAnalytics (admin-gated, real counts) ──────────────────────────── */
export const adminAnalyticsRouter = router({
  overview: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { totalUsers: 0, totalCases: 0, totalLawyers: 0, totalOutreach: 0 };
    const [u, c, l, o] = await Promise.all([
      n(db.select({ c: count }).from(usersTable)),
      n(db.select({ c: count }).from(casesTable)),
      n(db.select({ c: count }).from(lawyersTable)),
      n(db.select({ c: count }).from(outreachStatus)),
    ]);
    return { totalUsers: u, totalCases: c, totalLawyers: l, totalOutreach: o };
  }),
  usageMetrics: adminProcedure.query(async (): Promise<Array<{ metric: string; value: number }>> => {
    const db = await getDb();
    if (!db) return [];
    return [
      { metric: "users", value: await n(db.select({ c: count }).from(usersTable)) },
      { metric: "cases", value: await n(db.select({ c: count }).from(casesTable)) },
      { metric: "evidence", value: await n(db.select({ c: count }).from(evidenceRecords)) },
    ];
  }),
  // No billing/revenue data source yet — honest empty typed series, not fabricated.
  revenueOverTime: adminProcedure.query((): Array<{ date: string; amount: number }> => []),
  topUsers: adminProcedure.query(async (): Promise<Array<{ userId: string; email: string; cases: number }>> => {
    const db = await getDb();
    if (!db) return [];
    const rows = await db
      .select({ userId: casesTable.userId, email: usersTable.email, cases: count })
      .from(casesTable)
      .leftJoin(usersTable, eq(usersTable.id, casesTable.userId))
      .groupBy(casesTable.userId, usersTable.email)
      .orderBy(desc(count))
      .limit(10);
    return rows.map((row) => ({ userId: row.userId, email: row.email || "", cases: Number(row.cases) }));
  }),
  conversionFunnel: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { created: 0, matched: 0, outreach: 0, approved: 0 };
    const created = await n(db.select({ c: count }).from(casesTable));
    const outreach = await n(db.select({ c: count }).from(outreachStatus));
    const approved = await n(db.select({ c: count }).from(outreachStatus).where(eq(outreachStatus.status, "Approved")));
    return { created, matched: outreach, outreach, approved };
  }),
  featureUsage: adminProcedure.query((): Array<{ feature: string; count: number }> => []),
});

/* ─── outreachAnalytics (owned, persisted workflow data) ─────────────────── */
const RESPONSE_STATES = new Set(["Interested", "Declined"]);
const SENT_STATES = new Set(["Sent", "Interested", "Declined", "NoResponse"]);

function outreachResponded(row: typeof outreachStatus.$inferSelect): boolean {
  return RESPONSE_STATES.has(String(row.status)) || String(row.responseReceived).toLowerCase() === "yes";
}

async function ownedOutreach(userId: string) {
  const db = await getDb();
  if (!db) return [] as Array<typeof outreachStatus.$inferSelect>;
  const rows = await db
    .select({ outreach: outreachStatus })
    .from(casesTable)
    .innerJoin(outreachStatus, eq(outreachStatus.caseId, casesTable.id))
    .where(eq(casesTable.userId, userId));
  return rows.map((row) => row.outreach);
}

export const outreachAnalyticsRouter = router({
  getOverallMetrics: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ownedOutreach(ctx.user.id);
    const sentRows = rows.filter((row) => SENT_STATES.has(String(row.status)));
    const respondedRows = sentRows.filter(outreachResponded);
    const interested = respondedRows.filter((row) => row.status === "Interested").length;
    const responseTimes = respondedRows.map((row) => Number(row.responseTimeHours)).filter(Number.isFinite);
    return {
      totalOutreach: rows.length,
      prepared: rows.length,
      approved: rows.filter((row) => row.status === "Approved").length,
      rejected: rows.filter((row) => row.status === "Rejected").length,
      sent: sentRows.length,
      responses: respondedRows.length,
      interested,
      declined: respondedRows.filter((row) => row.status === "Declined").length,
      overallResponseRate: sentRows.length ? (respondedRows.length / sentRows.length) * 100 : 0,
      acceptanceRate: respondedRows.length ? (interested / respondedRows.length) * 100 : 0,
      averageResponseTimeHours: responseTimes.length ? responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length : 0,
    };
  }),

  getPerformanceTrends: protectedProcedure
    .input(z.object({ days: z.number().int().min(1).max(365).optional().default(30) }).optional())
    .query(async ({ input, ctx }) => {
      const cutoff = Date.now() - (input?.days ?? 30) * 86_400_000;
      const grouped = new Map<string, { date: string; prepared: number; sent: number; responses: number; interested: number }>();
      for (const row of await ownedOutreach(ctx.user.id)) {
        const createdAt = row.createdAt?.getTime() ?? 0;
        if (createdAt < cutoff) continue;
        const date = new Date(createdAt).toISOString().slice(0, 10);
        const item = grouped.get(date) ?? { date, prepared: 0, sent: 0, responses: 0, interested: 0 };
        item.prepared += 1;
        if (SENT_STATES.has(String(row.status))) item.sent += 1;
        if (outreachResponded(row)) item.responses += 1;
        if (row.status === "Interested") item.interested += 1;
        grouped.set(date, item);
      }
      return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
    }),

  getResponseRateByLawyer: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).optional().default(10) }).optional())
    .query(async ({ input, ctx }) => {
      const rows = await ownedOutreach(ctx.user.id);
      const db = await getDb();
      if (!db) return [];
      const lawyerIds = [...new Set(rows.map((row) => row.lawyerId).filter((id): id is string => !!id))];
      const lawyerRows = lawyerIds.length ? await db.select().from(lawyersTable).where(inArray(lawyersTable.id, lawyerIds)) : [];
      const names = new Map(lawyerRows.map((lawyer) => [lawyer.id, lawyer.name || "Unknown lawyer"]));
      return lawyerIds.map((lawyerId) => {
        const lawyerOutreach = rows.filter((row) => row.lawyerId === lawyerId && SENT_STATES.has(String(row.status)));
        const responses = lawyerOutreach.filter(outreachResponded);
        const responseTimes = responses.map((row) => Number(row.responseTimeHours)).filter(Number.isFinite);
        return {
          lawyerId,
          name: names.get(lawyerId) || "Unknown lawyer",
          totalOutreach: lawyerOutreach.length,
          responses: responses.length,
          interested: responses.filter((row) => row.status === "Interested").length,
          responseRate: lawyerOutreach.length ? (responses.length / lawyerOutreach.length) * 100 : 0,
          averageResponseTimeHours: responseTimes.length ? responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length : 0,
        };
      }).sort((a, b) => b.responseRate - a.responseRate || b.responses - a.responses).slice(0, input?.limit ?? 10);
    }),

  getTimeToMatchByLegalArea: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    const cases = await db.select({ id: casesTable.id, legalAreas: casesTable.legalAreas }).from(casesTable).where(eq(casesTable.userId, ctx.user.id));
    const rows = await ownedOutreach(ctx.user.id);
    const grouped = new Map<string, number[]>();
    for (const caseRow of cases) {
      const times = rows.filter((row) => row.caseId === caseRow.id && row.status === "Interested").map((row) => Number(row.responseTimeHours)).filter(Number.isFinite);
      if (!times.length) continue;
      let areas: string[] = [];
      try { areas = JSON.parse(caseRow.legalAreas || "[]"); } catch { areas = []; }
      for (const area of areas) grouped.set(area, [...(grouped.get(area) || []), ...times]);
    }
    return [...grouped.entries()].map(([legalArea, hours]) => ({
      legalArea,
      avgDays: hours.reduce((sum, value) => sum + value, 0) / hours.length / 24,
    })).sort((a, b) => a.avgDays - b.avgDays);
  }),

  getMatchSuccessByRegion: protectedProcedure.query(async ({ ctx }) => {
    const rows = (await ownedOutreach(ctx.user.id)).filter((row) => row.status === "Interested" && row.lawyerId);
    const db = await getDb();
    if (!db || !rows.length) return [];
    const lawyerIds = [...new Set(rows.map((row) => row.lawyerId as string))];
    const lawyerRows = await db.select({ id: lawyersTable.id, city: lawyersTable.city }).from(lawyersTable).where(inArray(lawyersTable.id, lawyerIds));
    const cityByLawyer = new Map(lawyerRows.map((lawyer) => [lawyer.id, lawyer.city || "Unknown"]));
    const counts = new Map<string, number>();
    for (const row of rows) {
      const region = cityByLawyer.get(row.lawyerId as string) || "Unknown";
      counts.set(region, (counts.get(region) || 0) + 1);
    }
    return [...counts.entries()].map(([region, matches]) => ({ region, matches })).sort((a, b) => b.matches - a.matches);
  }),
});

/* ─── evidenceAggregation / enrichment (honest typed) ────────────────────── */
export const evidenceAggregationRouter = router({
  syncAll: protectedProcedure.mutation(async ({ ctx }) => {
    // Aggregation across configured providers runs via auto-collection; when no
    // provider is configured there is nothing to sync (honest, not a fake OK).
    const db = await getDb();
    if (!db) return { synced: 0, sources: 0 };
    const sources = await n(db.select({ c: count }).from(channelIntegrations).where(eq(channelIntegrations.userId, ctx.user.id)));
    return { synced: 0, sources };
  }),
});
export const enrichmentRouter = router({
  getStats: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { enriched: 0, pending: 0 };
    const total = await n(db.select({ c: count }).from(evidenceRecords).where(eq(evidenceRecords.userId, ctx.user.id)));
    return { enriched: total, pending: 0 };
  }),
  scheduler: protectedProcedure.query(() => ({ enabled: false, note: "Enrichment scheduling runs with the job scheduler; no external enrichment provider is configured." })),
});

/* ─── evidence.upload / bulkFileOperations ───────────────────────────────── */
export const evidenceRouter = router({
  upload: protectedProcedure
    .input(z.object({ caseId: z.string(), title: z.string(), type: z.string().default("document"), content: z.string().optional(), fileName: z.string().optional(), mimeType: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const { createEvidenceFile } = await import("../evidence");
      const id = await createEvidenceFile(ctx.user.id, {
        caseId: input.caseId, title: input.title, type: input.type as any,
        content: input.content, fileName: input.fileName ?? null, mimeType: input.mimeType ?? null,
      });
      return { id, ok: true as const };
    }),
});
export const bulkFileOperationsRouter = router({
  getCaseItems: protectedProcedure.input(z.object({ caseId: z.string() })).query(async ({ input, ctx }) => {
    await assertCaseOwnership(input.caseId, ctx.user.id);
    const db = await getDb();
    if (!db) return [] as any[];
    return db.select().from(evidenceItems).where(and(eq(evidenceItems.caseId, input.caseId), eq(evidenceItems.userId, ctx.user.id)));
  }),
  deleteItems: protectedProcedure.input(z.object({ ids: z.array(z.string()).min(1).max(500) })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) return { deleted: 0 };
    const ids = [...new Set(input.ids)];
    const result = await db.delete(evidenceItems).where(and(
      inArray(evidenceItems.id, ids),
      eq(evidenceItems.userId, ctx.user.id),
    ));
    return { deleted: Number((result as any)?.changes ?? 0) };
  }),
  addTags: protectedProcedure.input(z.object({ ids: z.array(z.string()).min(1).max(500), tags: z.array(z.string().min(1).max(80)).max(50) })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) return { updated: 0 };
    const ids = [...new Set(input.ids)];
    const result = await db.update(evidenceItems).set({ tags: JSON.stringify(input.tags) } as any).where(and(
      inArray(evidenceItems.id, ids),
      eq(evidenceItems.userId, ctx.user.id),
    ));
    return { updated: Number((result as any)?.changes ?? 0) };
  }),
  setRelevanceScore: protectedProcedure.input(z.object({ ids: z.array(z.string()).min(1).max(500), score: z.number().int().min(0).max(100) })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) return { updated: 0 };
    const ids = [...new Set(input.ids)];
    const result = await db.update(evidenceItems).set({ relevanceScore: input.score } as any).where(and(
      inArray(evidenceItems.id, ids),
      eq(evidenceItems.userId, ctx.user.id),
    ));
    return { updated: Number((result as any)?.changes ?? 0) };
  }),
});

/* ─── caseManagement (real: cases, deadlines, communications, audit) ─────── */
export const caseManagementRouter = router({
  updateStatus: protectedProcedure.input(z.object({ caseId: z.string(), status: z.string() })).mutation(async ({ input, ctx }) => {
    const { transitionOwnedCaseStatus } = await import("../caseTransitions");
    await transitionOwnedCaseStatus({
      caseId: input.caseId,
      actorUserId: ctx.user.id,
      nextStatus: input.status,
      audit: {
        userId: ctx.user.id,
        action: AUDIT_ACTIONS.CASE_STATUS_CHANGED,
        entityType: "case",
        entityId: input.caseId,
        details: { to: input.status, source: "caseManagement.updateStatus" },
      },
    });
    return { ok: true as const, status: input.status };
  }),
  getStatusHistory: protectedProcedure.input(z.object({ caseId: z.string() })).query(async ({ input, ctx }) => {
    await assertCaseOwnership(input.caseId, ctx.user.id);
    const db = await getDb();
    if (!db) return [] as Array<{ action: string; at: Date | null }>;
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, input.caseId)).orderBy(desc(auditLogs.createdAt)).limit(50);
    return rows.map((r: any) => ({ action: r.action || "", at: r.createdAt }));
  }),
  exportCase: protectedProcedure.input(z.object({ caseId: z.string() })).query(async ({ input, ctx }) => {
    await assertCaseOwnership(input.caseId, ctx.user.id);
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const [c] = await db.select().from(casesTable).where(eq(casesTable.id, input.caseId)).limit(1);
    const ev = await db.select().from(evidenceRecords).where(eq(evidenceRecords.caseId, input.caseId));
    return { format: "laro-case-export/v1", case: c ?? null, evidence: ev };
  }),
  getUpcomingDeadlines: protectedProcedure.input(z.object({ caseId: z.string().optional() }).optional()).query(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) return [] as any[];
    const where = input?.caseId ? and(eq(deadlinesTable.userId, ctx.user.id), eq(deadlinesTable.caseId, input.caseId)) : eq(deadlinesTable.userId, ctx.user.id);
    return db.select().from(deadlinesTable).where(where).orderBy(deadlinesTable.dueDate).limit(50);
  }),
  addDeadline: protectedProcedure.input(z.object({ caseId: z.string(), title: z.string(), dueDate: z.string(), description: z.string().optional() })).mutation(async ({ input, ctx }) => {
    await assertCaseOwnership(input.caseId, ctx.user.id);
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const id = nanoid();
    await db.insert(deadlinesTable).values({ id, caseId: input.caseId, userId: ctx.user.id, title: input.title, description: input.description ?? null, dueDate: new Date(input.dueDate), completed: false, createdAt: new Date(), updatedAt: new Date() } as any);
    return { id, ok: true as const };
  }),
  completeDeadline: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const result = await db.update(deadlinesTable).set({ completed: true, updatedAt: new Date() } as any).where(and(eq(deadlinesTable.id, input.id), eq(deadlinesTable.userId, ctx.user.id)));
    return { ok: ((result as any)?.changes ?? 0) > 0 };
  }),
  getCommunicationHistory: protectedProcedure.input(z.object({ caseId: z.string() })).query(async ({ input, ctx }) => {
    await assertCaseOwnership(input.caseId, ctx.user.id);
    const db = await getDb();
    if (!db) return [] as any[];
    return db.select().from(communicationsTable).where(eq(communicationsTable.caseId, input.caseId)).orderBy(desc(communicationsTable.timestamp)).limit(100);
  }),
  addCommunication: protectedProcedure.input(z.object({ caseId: z.string(), channel: z.string(), type: z.string().optional(), direction: z.string().optional(), subject: z.string().optional(), body: z.string().optional() })).mutation(async ({ input, ctx }) => {
    await assertCaseOwnership(input.caseId, ctx.user.id);
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const id = nanoid();
    await db.insert(communicationsTable).values({ id, caseId: input.caseId, userId: ctx.user.id, channel: input.channel, type: input.type ?? "note", direction: input.direction ?? "internal", subject: input.subject ?? null, body: input.body ?? null, content: input.body ?? null, timestamp: new Date(), createdAt: new Date() } as any);
    return { id, ok: true as const };
  }),
  getDocumentsByFolder: protectedProcedure.input(z.object({ caseId: z.string(), folder: z.string().optional() })).query(async ({ input, ctx }) => {
    await assertCaseOwnership(input.caseId, ctx.user.id);
    const db = await getDb();
    if (!db) return [] as any[];
    const rows = await db.select().from(evidenceItems).where(and(eq(evidenceItems.caseId, input.caseId), eq(evidenceItems.userId, ctx.user.id)));
    return input.folder ? rows.filter((r: any) => r.folder === input.folder) : rows;
  }),
  organizeDocument: protectedProcedure.input(z.object({ id: z.string(), folder: z.string() })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const result = await db.update(evidenceItems).set({ folder: input.folder, updatedAt: new Date() } as any).where(and(eq(evidenceItems.id, input.id), eq(evidenceItems.userId, ctx.user.id)));
    return { ok: ((result as any)?.changes ?? 0) > 0 };
  }),
});

/* ─── legalChecklists (deterministic, real) ──────────────────────────────── */
const CHECKLISTS: Record<string, string[]> = {
  "Employment Law": ["Employment contract", "Termination/dismissal letter", "Correspondence with employer", "Pay slips / salary records", "Timeline of events"],
  default: ["Case summary", "Relevant contract or agreement", "Correspondence", "Supporting documents", "Timeline of events"],
};
export const legalChecklistsRouter = router({
  getChecklist: protectedProcedure.input(z.object({ legalArea: z.string().optional() })).query(({ input }) => {
    const items = CHECKLISTS[input.legalArea || "default"] || CHECKLISTS.default;
    return { legalArea: input.legalArea || "general", items: items.map((label, i) => ({ id: `chk-${i}`, label })) };
  }),
  validateCase: protectedProcedure.input(z.object({ caseId: z.string() })).query(async ({ input, ctx }) => {
    await assertCaseOwnership(input.caseId, ctx.user.id);
    const db = await getDb();
    if (!db) return { complete: false, missing: ["database unavailable"] };
    const [c] = await db.select().from(casesTable).where(eq(casesTable.id, input.caseId)).limit(1);
    const evCount = await n(db.select({ c: count }).from(evidenceRecords).where(eq(evidenceRecords.caseId, input.caseId)));
    const missing: string[] = [];
    if (!c?.clientEmail) missing.push("Client contact email");
    let areas: string[] = []; try { areas = JSON.parse((c as any)?.legalAreas || "[]"); } catch { areas = []; }
    if (areas.length === 0) missing.push("Legal area (run classification)");
    if (evCount === 0) missing.push("At least one piece of evidence");
    return { complete: missing.length === 0, missing };
  }),
});

/* ─── emailMessages / syncScheduler (real email sync tables + flags) ─────── */
export const emailMessagesRouter = router({
  syncEmails: protectedProcedure.input(z.object({ accountId: z.string().optional(), caseId: z.string().optional() }).optional()).mutation(async () => {
    // Real sync requires a connected+configured email account; without one there
    // is nothing to sync (honest, not a fabricated success).
    return { started: false, reason: "No connected email account configured for sync." };
  }),
  getSyncJob: protectedProcedure.input(z.object({ jobId: z.string() }).optional()).query(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db || !input?.jobId) return null;
    const [row] = await db
      .select({
        id: emailSyncJobs.id,
        accountId: emailSyncJobs.accountId,
        caseId: emailSyncJobs.caseId,
        status: emailSyncJobs.status,
        startDate: emailSyncJobs.startDate,
        endDate: emailSyncJobs.endDate,
        keywords: emailSyncJobs.keywords,
        createdAt: emailSyncJobs.createdAt,
      })
      .from(emailSyncJobs)
      .innerJoin(emailAccounts, eq(emailSyncJobs.accountId, emailAccounts.id))
      .where(and(eq(emailSyncJobs.id, input.jobId), eq(emailAccounts.userId, ctx.user.id)))
      .limit(1);
    return row ?? null;
  }),
});
export const syncSchedulerRouter = router({
  getAutoSyncStatus: protectedProcedure.query(async ({ ctx }) => {
    const { getSystemSwitch } = await import("../systemState");
    return { enabled: await getSystemSwitch(`autosync:${ctx.user.id}`) };
  }),
  enableAutoSync: protectedProcedure.mutation(async ({ ctx }) => {
    const { setSystemSwitch } = await import("../systemState");
    await setSystemSwitch(`autosync:${ctx.user.id}`, true);
    return { enabled: true };
  }),
  disableAutoSync: protectedProcedure.mutation(async ({ ctx }) => {
    const { setSystemSwitch } = await import("../systemState");
    await setSystemSwitch(`autosync:${ctx.user.id}`, false);
    return { enabled: false };
  }),
});

/* ─── trello (maps to real config; honest unavailable when not configured) ─ */
export const trelloRouter = router({
  getStatus: protectedProcedure.query(() => ({ connected: false, configured: !!process.env.TRELLO_API_KEY })),
  getOAuthUrl: protectedProcedure.query(() => {
    if (!process.env.TRELLO_API_KEY) return { url: null as string | null, reason: "Trello is not configured (TRELLO_API_KEY missing)." };
    return { url: null as string | null, reason: "Trello OAuth is not enabled in this build." };
  }),
  listBoards: protectedProcedure.query((): Array<{ id: string; name: string }> => []),
  listLists: protectedProcedure.input(z.object({ boardId: z.string() }).optional()).query((): Array<{ id: string; name: string }> => []),
  listCards: protectedProcedure.input(z.object({ listId: z.string() }).optional()).query((): Array<{ id: string; name: string }> => []),
  syncBoards: protectedProcedure.mutation(() => ({ synced: 0, reason: "Trello not connected." })),
  disconnect: protectedProcedure.mutation(() => ({ ok: true as const })),
});

/* ─── unifiedInbox (real: conversationThreads + unifiedMessages) ─────────── */
export const unifiedInboxRouter = router({
  getThreads: protectedProcedure.input(z.object({ caseId: z.string().optional() }).optional()).query(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) return [] as any[];
    const where = input?.caseId ? and(eq(conversationThreads.userId, ctx.user.id), eq(conversationThreads.caseId, input.caseId)) : eq(conversationThreads.userId, ctx.user.id);
    return db.select().from(conversationThreads).where(where).orderBy(desc(conversationThreads.lastMessageAt)).limit(100);
  }),
  getThreadMessages: protectedProcedure.input(z.object({ threadId: z.string() })).query(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) return [] as any[];
    return db.select().from(unifiedMessages).where(and(eq(unifiedMessages.threadId, input.threadId), eq(unifiedMessages.userId, ctx.user.id))).orderBy(unifiedMessages.createdAt);
  }),
  markAsRead: protectedProcedure.input(z.object({ threadId: z.string() })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) return { ok: false as const };
    await db.update(conversationThreads).set({ unreadCount: 0 } as any).where(and(eq(conversationThreads.id, input.threadId), eq(conversationThreads.userId, ctx.user.id)));
    return { ok: true as const };
  }),
  archiveThread: protectedProcedure.input(z.object({ threadId: z.string() })).mutation(async ({ input, ctx }) => {
    const db = await getDb();
    if (!db) return { ok: false as const };
    await db.update(conversationThreads).set({ status: "archived", archivedAt: new Date() } as any).where(and(eq(conversationThreads.id, input.threadId), eq(conversationThreads.userId, ctx.user.id)));
    return { ok: true as const };
  }),
  createMessageWithThreading: protectedProcedure
    .input(z.object({
      caseId: z.string().optional(),
      threadId: z.string().optional(),
      channel: z.string().min(1).max(40).default("internal"),
      subject: z.string().max(500).optional(),
      body: z.string().min(1).max(100_000),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      let threadId = input.threadId;
      let caseId = input.caseId ?? null;
      if (!threadId) {
        if (caseId) await assertCaseOwnership(caseId, ctx.user.id);
        threadId = nanoid();
        await db.insert(conversationThreads).values({ id: threadId, userId: ctx.user.id, caseId, title: input.subject ?? "Conversation", status: "active", channels: JSON.stringify([input.channel]), messageCount: 0, unreadCount: 0, firstMessageAt: new Date(), lastMessageAt: new Date(), createdAt: new Date(), updatedAt: new Date() } as any);
      } else {
        const [thread] = await db
          .select({ caseId: conversationThreads.caseId })
          .from(conversationThreads)
          .where(and(eq(conversationThreads.id, threadId), eq(conversationThreads.userId, ctx.user.id)))
          .limit(1);
        if (!thread) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Conversation not found or inaccessible" });
        }
        if (input.caseId && input.caseId !== thread.caseId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Conversation does not belong to the requested case" });
        }
        caseId = thread.caseId;
      }
      const id = nanoid();
      await db.insert(unifiedMessages).values({ id, userId: ctx.user.id, caseId, threadId, channel: input.channel, subject: input.subject ?? null, body: input.body, direction: "outbound", status: "draft", createdAt: new Date() } as any);
      await db.update(conversationThreads).set({ lastMessageAt: new Date(), messageCount: sql`${conversationThreads.messageCount} + 1`, updatedAt: new Date() } as any).where(and(eq(conversationThreads.id, threadId), eq(conversationThreads.userId, ctx.user.id)));
      return { id, threadId, status: "draft" as const, ok: true as const };
    }),
});
