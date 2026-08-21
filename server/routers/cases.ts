import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { assertCaseOwnership } from "../_core/authz";
import { enforceRateLimit, RATE_LIMITS } from "../rateLimit";
import { createAuditLog, AUDIT_ACTIONS } from "../audit";
import { cases as casesTable, outreachStatus, lawyers, evidence, systemConfig } from '../schema';
import { eq, desc, asc, and, sql } from "drizzle-orm";
import { sanitizeLegalAreas } from "../legalAreasValidator";
import { classifyLegalAreas } from "../classification";
import { createNotification } from "../notifications";
import { caseIntakeSchema } from "../../shared/validation";
import { assertCaseTransition } from "../stateMachines";
import { createCaseId } from "../ids";
import { collectManagedStorageKeys } from "../managedStorage";
import { enqueueStorageDeletions, processQueuedStorageDeletions } from "../storageDeletionQueue";
import { emitRealtimeDataChange } from "../realtime";

export const casesRouter = router({
  // Phase 022 — search, filters, sorting, pagination. All server-side and
  // owner-scoped. Filters and sort are validated enums; search matches the
  // client name and case summary.
  list: protectedProcedure
    .input(z.object({
      page: z.number().min(1).optional().default(1),
      limit: z.number().min(1).max(100).optional().default(10),
      status: z.string().optional(),
      urgency: z.enum(["Low", "Medium", "High"]).optional(),
      search: z.string().optional(),
      sortBy: z.enum(["createdAt", "updatedAt", "urgency", "clientName", "status"]).optional().default("createdAt"),
      sortDir: z.enum(["asc", "desc"]).optional().default("desc"),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return { cases: [], pagination: { total: 0, totalPages: 0, page: 1, limit: 10 } };

      const userId = ctx.user.id;
      const page = input?.page || 1;
      const limit = input?.limit || 10;
      const offset = (page - 1) * limit;

      const conditions: any[] = [eq(casesTable.userId, userId)];
      if (input?.status) conditions.push(eq(casesTable.status, input.status));
      if (input?.urgency) conditions.push(eq(casesTable.urgency, input.urgency));
      if (input?.search?.trim()) {
        const q = `%${input.search.trim().toLowerCase()}%`;
        conditions.push(
          sql`(lower(cases.clientName) LIKE ${q} OR lower(cases.caseSummary) LIKE ${q})`
        );
      }
      const where = and(...conditions);

      const sortCol =
        input?.sortBy === "urgency" ? casesTable.urgency :
        input?.sortBy === "clientName" ? casesTable.clientName :
        input?.sortBy === "status" ? casesTable.status :
        input?.sortBy === "updatedAt" ? casesTable.updatedAt :
        casesTable.createdAt;
      const order = input?.sortDir === "asc" ? asc(sortCol) : desc(sortCol);

      const userCases = await db
        .select()
        .from(casesTable)
        .where(where)
        .orderBy(order)
        .limit(limit)
        .offset(offset);

      const totalResult = await db.select({ count: sql<number>`count(*)` }).from(casesTable).where(where);
      const total = Number(totalResult[0]?.count || 0);

      return {
        cases: userCases.map((c) => ({
          ...c,
          legalAreas: typeof c.legalAreas === "string" ? c.legalAreas : JSON.stringify(c.legalAreas || []),
        })),
        pagination: {
          total,
          totalPages: Math.ceil(total / limit),
          page,
          limit,
        }
      };
    }),


  byId: protectedProcedure
    .input(z.string())
    .query(async ({ input: caseId, ctx }) => {
      const db = await getDb();
      if (!db) return null;
      const result = await db.select().from(casesTable).where(and(eq(casesTable.id, caseId), eq(casesTable.userId, ctx.user.id))).limit(1);
      if (!result.length) return null;
      return result[0];
    }),

  create: protectedProcedure
    .input(caseIntakeSchema) // Phase 021: shared validation contract
    .mutation(async ({ input, ctx }) => {
      enforceRateLimit(ctx, "caseCreate", RATE_LIMITS.caseCreate); // Phase 018
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const caseId = createCaseId();
      const userId = ctx.user.id;

      // Phase 025: deterministically classify the case into legal areas from its
      // description + type, so lawyer matching (Phase 011) has areas to work with
      // instead of the case being unclassified.
      const classification = classifyLegalAreas(input.caseSummary, input.caseType);

      await db.insert(casesTable).values({
        id: caseId,
        userId,
        clientName: input.clientName,
        clientEmail: input.clientEmail,
        clientPhone: input.clientPhone,
        clientAddress: input.clientAddress,
        caseType: input.caseType,
        caseSummary: input.caseSummary,
        urgency: input.urgency,
        status: "Matching",
        legalAreas: sanitizeLegalAreas(classification.areas),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);

      await createAuditLog({ // Phase 019
        userId,
        action: AUDIT_ACTIONS.CASE_CREATED,
        entityType: "case",
        entityId: caseId,
        details: { caseType: input.caseType, urgency: input.urgency, legalAreas: classification.areas },
      });

      await createNotification({ // Phase 027
        userId,
        title: `Case created for ${input.clientName}`,
        body: `Classified as: ${classification.areas.join(", ")}. Review matched lawyers next.`,
      });
      emitRealtimeDataChange(userId, { scope: "case", caseId });

      return { id: caseId, success: true, legalAreas: classification.areas, classificationConfidence: classification.confidence };
    }),

  // Phase 023 — export a single case as a complete JSON package (case details +
  // evidence + outreach), owner-scoped. This is a real export, not the previous
  // empty GDPR stub.
  export: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const [caseRows, evidenceRows, outreachRows] = await Promise.all([
        db.select().from(casesTable).where(eq(casesTable.id, input.caseId)).limit(1),
        db.select().from(evidence).where(eq(evidence.caseId, input.caseId)),
        db.select().from(outreachStatus).where(eq(outreachStatus.caseId, input.caseId)),
      ]);

      return {
        format: "laro-case-export/v1",
        exportedAt: new Date().toISOString(),
        case: caseRows[0] ?? null,
        evidence: evidenceRows,
        outreach: outreachRows,
      };
    }),

  // Phase 023 — issue an owner-scoped URL for the streamed evidence package.
  exportZip: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      enforceRateLimit(ctx, "evidence-export", RATE_LIMITS.evidenceExport);
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const { issueCaseZipDownloadTicket } = await import("../evidenceExport");
      const ticket = issueCaseZipDownloadTicket(ctx.user.id, input.caseId);
      return {
        format: "laro-case-zip/v2",
        filename: `case-${input.caseId}-evidence.zip`,
        url: `/api/case-export/${ticket}.zip`,
      };
    }),

  // Phase 023 — export the user's case list as CSV text (client-downloadable).
  exportCsv: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { csv: "" };
    const rows = await db
      .select()
      .from(casesTable)
      .where(eq(casesTable.userId, ctx.user.id))
      .orderBy(desc(casesTable.createdAt));

    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ["id", "clientName", "caseType", "urgency", "status", "legalAreas"];
    const lines = [header.join(",")];
    for (const c of rows) {
      lines.push([c.id, c.clientName, c.caseType, c.urgency, c.status, c.legalAreas].map(esc).join(","));
    }
    return { csv: lines.join("\n"), count: rows.length };
  }),

  // Phase 021 — case intake autosave. The in-progress form is persisted
  // per-user (keyed in system_config) so a refresh/crash does not lose input.
  saveDraft: protectedProcedure
    .input(z.object({ draft: z.record(z.any()) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const key = `caseDraft:${ctx.user.id}`;
      await db
        .insert(systemConfig)
        .values({ configKey: key, configValue: JSON.stringify(input.draft), updatedAt: new Date() } as any)
        .onConflictDoUpdate({
          target: systemConfig.configKey,
          set: { configValue: JSON.stringify(input.draft), updatedAt: new Date() },
        });
      return { success: true };
    }),

  getDraft: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return { draft: null };
    const key = `caseDraft:${ctx.user.id}`;
    const row = (await db.select().from(systemConfig).where(eq(systemConfig.configKey, key)).limit(1))[0];
    if (!row?.configValue) return { draft: null };
    try {
      return { draft: JSON.parse(row.configValue) };
    } catch {
      return { draft: null };
    }
  }),

  clearDraft: protectedProcedure.mutation(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    await db.delete(systemConfig).where(eq(systemConfig.configKey, `caseDraft:${ctx.user.id}`));
    return { success: true };
  }),

  // Phase 025: (re)classify an existing case from its current description.
  classify: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const rows = await db.select().from(casesTable).where(eq(casesTable.id, input.caseId)).limit(1);
      const c = rows[0];
      if (!c) throw new Error("Case not found");

      const classification = classifyLegalAreas(c.caseSummary || "", c.caseType || undefined);
      const updateResult = await db
        .update(casesTable)
        .set({ legalAreas: sanitizeLegalAreas(classification.areas), updatedAt: new Date() })
        .where(eq(casesTable.id, input.caseId));
      if (!Number((updateResult as any)?.changes ?? 0)) {
        throw new TRPCError({ code: "CONFLICT", message: "Case changed before classification could be saved" });
      }

      await createAuditLog({
        userId: ctx.user.id,
        action: AUDIT_ACTIONS.CASE_UPDATED,
        entityType: "case",
        entityId: input.caseId,
        details: { classified: classification.areas, confidence: classification.confidence },
      });
      emitRealtimeDataChange(ctx.user.id, { scope: "case", caseId: input.caseId });

      return { success: true, ...classification };
    }),


  update: protectedProcedure
    .input(z.object({
      id: z.string(),
      status: z.string().optional(),
      caseSummary: z.string().optional(),
      urgency: z.enum(["Low", "Medium", "High"]).optional(),
      legalAreas: z.any().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      await assertCaseOwnership(input.id, ctx.user.id);

      // Phase 059: validate the status transition against the case state machine.
      if (input.status) {
        const cur = (await db.select({ status: casesTable.status }).from(casesTable).where(eq(casesTable.id, input.id)).limit(1))[0];
        assertCaseTransition(cur?.status ?? null, input.status);
      }

      const updateData: any = { updatedAt: new Date() };
      if (input.status) updateData.status = input.status;
      if (input.caseSummary) updateData.caseSummary = input.caseSummary;
      if (input.urgency) updateData.urgency = input.urgency;
      if (input.legalAreas) {
        updateData.legalAreas = sanitizeLegalAreas(input.legalAreas);
      }

      const updateResult = await db.update(casesTable)
        .set(updateData)
        .where(eq(casesTable.id, input.id));
      if (!Number((updateResult as any)?.changes ?? 0)) {
        throw new TRPCError({ code: "CONFLICT", message: "Case changed before the update could be saved" });
      }

      await createAuditLog({ // Phase 019
        userId: ctx.user.id,
        action: input.status ? AUDIT_ACTIONS.CASE_STATUS_CHANGED : AUDIT_ACTIONS.CASE_UPDATED,
        entityType: "case",
        entityId: input.id,
        details: { status: input.status, fields: Object.keys(updateData) },
      });
      emitRealtimeDataChange(ctx.user.id, { scope: "case", caseId: input.id });

      return { success: true };
    }),

  // Hard-delete a case and cascade through every related table that has a
  // `caseId` column. Schema-introspection driven so it stays correct as the
  // schema grows. Ownership-checked so a user can only delete their own cases.
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const existing = await db
        .select({ id: casesTable.id })
        .from(casesTable)
        .where(and(eq(casesTable.id, input.id), eq(casesTable.userId, ctx.user.id)))
        .limit(1);

      if (!existing.length) {
        throw new Error("Case not found or you do not have permission to delete it");
      }

      // Find every table (other than `cases` itself) that has a `caseId`
      // column, then DELETE FROM each WHERE caseId = ?. Wrapped in a
      // transaction so partial failures roll back.
      const sqliteDb: any = (db as any).$client ?? (db as any).session?.client;
      if (!sqliteDb) {
        throw new Error("Storage engine not available for complete case deletion");
      }

      const storageKeys = collectManagedStorageKeys(sqliteDb, { caseIds: [input.id] });

      // NB: filter internal tables in JS. A SQL `LIKE '__%'` would treat `_` as
      // a wildcard and exclude EVERY table (breaking the cascade) — that was a
      // latent bug; caught by the Phase 040 backend test.
      const tables = (
        sqliteDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      ).filter((t) => !t.name.startsWith("sqlite_") && !t.name.startsWith("__") && t.name !== "cases");

      const tablesWithCaseId: string[] = [];
      for (const t of tables) {
        try {
          const cols = sqliteDb
            .prepare(`PRAGMA table_info("${t.name}")`)
            .all() as Array<{ name: string }>;
          if (cols.some((c) => c.name === "caseId")) {
            tablesWithCaseId.push(t.name);
          }
        } catch {
          // Ignore tables we can't introspect.
        }
      }

      const tx = sqliteDb.transaction((caseId: string, userId: string) => {
        enqueueStorageDeletions(sqliteDb, storageKeys);
        for (const tableName of tablesWithCaseId) {
          sqliteDb.prepare(`DELETE FROM "${tableName}" WHERE caseId = ?`).run(caseId);
        }
        sqliteDb
          .prepare(`DELETE FROM cases WHERE id = ? AND userId = ?`)
          .run(caseId, userId);
      });

      tx(input.id, ctx.user.id);

      const cleanup = await processQueuedStorageDeletions({ storageKeys });

      await createAuditLog({ // Phase 019
        userId: ctx.user.id,
        action: AUDIT_ACTIONS.CASE_DELETED,
        entityType: "case",
        entityId: input.id,
        details: { cascadedTables: tablesWithCaseId },
      });

      return {
        success: cleanup.requestedPending === 0,
        deletionStatus: cleanup.requestedPending > 0 ? "storage_cleanup_pending" as const : "completed" as const,
        storageCleanupPending: cleanup.requestedPending,
      };
    }),

  outreachProgress: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id); // Phase 008
      const db = await getDb();
      if (!db) return { legalAreas: [], overallStats: {} };

      // Get case
      const caseData = await db.select().from(casesTable).where(eq(casesTable.id, input.caseId)).limit(1);
      if (!caseData.length) return { legalAreas: [], overallStats: {} };

      // Phase 014: compute from real outreach data instead of the previous
      // hardcoded fixed sample values. Per-legal-area outreach is not tracked,
      // so per-area counts are 0 (honest) and the real numbers live in
      // overallStats, aggregated from the outreach_status table.
      let legalAreas: string[] = [];
      try {
        legalAreas = JSON.parse(caseData[0].legalAreas || "[]");
      } catch {}

      const rows = await db
        .select({
          status: outreachStatus.status,
          response: outreachStatus.response,
          responseTimeHours: outreachStatus.responseTimeHours,
        })
        .from(outreachStatus)
        .where(eq(outreachStatus.caseId, input.caseId));

      const totalContacted = rows.length;
      const responded = rows.filter(
        (r) => r.status === "Interested" || r.status === "Declined" || (r.response != null && r.response !== "")
      );
      const totalResponses = responded.length;
      const times = rows
        .map((r) => parseFloat(r.responseTimeHours || ""))
        .filter((n) => !Number.isNaN(n));
      const avgHours = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;

      return {
        legalAreas: legalAreas.map((area) => ({
          name: area,
          status: totalContacted > 0 ? "In Progress" : "Not started",
          count: 0, // per-area outreach is not tracked
          contacted: 0,
          responded: 0,
        })),
        overallStats: {
          totalContacted,
          totalResponses,
          avgResponseTime: avgHours != null ? `${avgHours}h` : "n/a",
        },
      };
    }),
    
  getOutreachByCaseId: protectedProcedure
    .input(z.string())
    .query(async ({ input: caseId, ctx }) => {
      await assertCaseOwnership(caseId, ctx.user.id); // Phase 008
      const db = await getDb();
      if (!db) return [];

      const results = await db
        .select({
          id: outreachStatus.id,
          lawyerName: lawyers.name,
          status: outreachStatus.status,
          distanceKm: outreachStatus.distanceKm,
          initialContact: outreachStatus.initialContact,
          followUpsSent: outreachStatus.followUpsSent,
          response: outreachStatus.response,
          lastContact: outreachStatus.lastContact,
        })
        .from(outreachStatus)
        .leftJoin(lawyers, eq(outreachStatus.lawyerId, lawyers.id))
        .where(eq(outreachStatus.caseId, caseId));

      return results;
    }),

  // Derived case-progress snapshot for the Progress tab. Everything here is
  // computed from real data (case status, evidence count, outreach responses)
  // rather than stored — so it stays in sync as the user pulls evidence and
  // runs outreach.
  progress: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id); // Phase 008
      const empty = {
        caseId: input.caseId,
        caseTitle: "",
        overallProgress: 0,
        healthScore: 0,
        milestones: [] as any[],
        nextActions: [] as any[],
        deadlines: [] as any[],
        recentActivity: [] as any[],
      };

      const db = await getDb();
      if (!db) return empty;

      const c = (
        await db.select().from(casesTable).where(eq(casesTable.id, input.caseId)).limit(1)
      )[0];
      if (!c) return empty;

      const createdAt = c.createdAt ?? new Date();

      const [evCountRow] = await db
        .select({ n: sql<number>`count(*)` })
        .from(evidence)
        .where(eq(evidence.caseId, input.caseId));
      const evidenceCount = Number(evCountRow?.n ?? 0);

      const outreaches = await db
        .select()
        .from(outreachStatus)
        .where(eq(outreachStatus.caseId, input.caseId));
      const outreachCount = outreaches.length;
      const responded = outreaches.filter(
        (o) => !!o.response || String(o.responseReceived).toLowerCase() === "yes"
      ).length;
      const engaged = outreaches.some((o) =>
        ["interested", "accepted", "engaged"].includes(String(o.status || "").toLowerCase())
      );

      const status = String(c.status || "active").toLowerCase();
      const isResolved = ["closed", "resolved", "completed", "won", "settled"].some((s) =>
        status.includes(s)
      );

      const milestones = [
        {
          id: "created",
          title: "Case Created",
          description: "Case intake completed",
          status: "completed" as const,
          completedAt: createdAt,
        },
        {
          id: "evidence",
          title: "Evidence Collected",
          description:
            evidenceCount > 0
              ? `${evidenceCount} evidence item(s) collected`
              : "Collect evidence for this case",
          status: evidenceCount > 0 ? ("completed" as const) : ("current" as const),
        },
        {
          id: "matched",
          title: "Lawyers Contacted",
          description:
            outreachCount > 0
              ? `${outreachCount} lawyer(s) contacted`
              : "Match and contact lawyers",
          status:
            outreachCount > 0
              ? ("completed" as const)
              : evidenceCount > 0
              ? ("current" as const)
              : ("upcoming" as const),
        },
        {
          id: "engaged",
          title: "Lawyer Engaged",
          description: engaged
            ? "A lawyer is engaged on this case"
            : responded > 0
            ? `${responded} response(s) received`
            : "Awaiting lawyer responses",
          status: engaged
            ? ("completed" as const)
            : outreachCount > 0
            ? ("current" as const)
            : ("upcoming" as const),
        },
        {
          id: "resolved",
          title: "Case Resolved",
          description: isResolved ? "Case closed" : "Resolve the case",
          status: isResolved ? ("completed" as const) : ("upcoming" as const),
        },
      ];

      const completed = milestones.filter((m) => m.status === "completed").length;
      const overallProgress = Math.round((completed / milestones.length) * 100);

      let healthScore =
        Math.min(evidenceCount * 10, 40) +
        Math.min(outreachCount * 10, 30) +
        Math.min(responded * 10, 20) +
        (engaged ? 10 : 0);
      healthScore = Math.min(healthScore, 100);

      const nextActions: any[] = [];
      if (evidenceCount === 0)
        nextActions.push({
          id: "na-evidence",
          title: "Collect evidence",
          description: "Pull emails/Drive files or upload documents for this case.",
          priority: "high",
        });
      if (outreachCount === 0)
        nextActions.push({
          id: "na-contact",
          title: "Contact lawyers",
          description: "Match with lawyers and start outreach.",
          priority: evidenceCount > 0 ? "high" : "medium",
        });
      if (outreachCount > 0 && responded === 0)
        nextActions.push({
          id: "na-followup",
          title: "Follow up with lawyers",
          description: "No responses yet — send follow-ups.",
          priority: "medium",
        });
      if (responded > 0 && !engaged)
        nextActions.push({
          id: "na-engage",
          title: "Engage a responding lawyer",
          description: "Review responses and engage a lawyer.",
          priority: "high",
        });
      if (nextActions.length === 0 && !isResolved)
        nextActions.push({
          id: "na-resolve",
          title: "Drive toward resolution",
          description: "Keep the case moving toward closure.",
          priority: "low",
        });

      const recentEvidence = await db
        .select()
        .from(evidence)
        .where(eq(evidence.caseId, input.caseId))
        .orderBy(desc(evidence.createdAt))
        .limit(5);

      const recentActivity = [
        ...recentEvidence.map((e) => ({
          id: `ev-${e.id}`,
          type: "evidence",
          description: `Evidence added: ${e.title}`,
          timestamp: e.createdAt ?? createdAt,
        })),
        ...outreaches.map((o) => ({
          id: `or-${o.id}`,
          type: "outreach",
          description: `Outreach ${o.status || "started"}`.trim(),
          timestamp: o.initialContact ?? o.lastContact ?? createdAt,
        })),
        {
          id: "act-created",
          type: "case",
          description: "Case created",
          timestamp: createdAt,
        },
      ]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, 8);

      return {
        caseId: c.id,
        caseTitle: c.clientName || c.caseType || "Case",
        overallProgress,
        healthScore,
        milestones,
        nextActions,
        deadlines: [] as any[],
        recentActivity,
      };
    }),
});
