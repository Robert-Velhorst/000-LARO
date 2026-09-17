import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { getJobStatus } from "../cronScheduler";
import { ENV } from "../_core/env";
import { isEmergencyStopped, setEmergencyStop } from "../systemState";
import { runRetentionSweep, previewRetentionSweep, RETENTION_POLICY } from "../retention";
import { getAllFlags } from "../featureFlags";
import { writeAuditLogOrThrow } from "../audit";
import { APP_VERSION } from "../_core/version";
import { resolveOutboundEmailConfiguration } from "../emailConfig";
import { getLLMProviderDescriptors } from "../llm";
import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { accountEmailConflicts, users } from "../schema";
import { normalizeAccountEmail } from "../emailIdentity";

/**
 * Phase 036 — admin/operator diagnostics.
 *
 * Gated by `adminProcedure` (role === 'admin'; the OWNER_ID account is admin).
 * Exposes operational internals WITHOUT leaking any secret values — only
 * booleans for whether each integration is configured.
 */
export const adminRouter = router({
  diagnostics: adminProcedure.query(async () => {
    let dbReady = false;
    try {
      dbReady = !!(await getDb());
    } catch {
      dbReady = false;
    }
    return {
      system: {
        node: process.version,
        platform: process.platform,
        uptimeSeconds: Math.round(process.uptime()),
        env: ENV.NODE_ENV,
        isProduction: ENV.isProd,
        demoMode: ENV.isDemo,
      },
      db: { ready: dbReady },
      jobs: getJobStatus(),
      integrations: {
        ai: getLLMProviderDescriptors().some((provider) => provider.configured),
        s3: !!ENV.AWS_S3_BUCKET,
        google: !!(ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET),
        microsoft: !!(ENV.MICROSOFT_CLIENT_ID && ENV.MICROSOFT_CLIENT_SECRET),
        email: resolveOutboundEmailConfiguration().configured,
      },
    };
  }),

  // Row counts per table (operator visibility into data volume).
  tableCounts: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) return {} as Record<string, number>;
    const sqlite: any = (db as any).$client ?? (db as any).session?.client;
    if (!sqlite) return {} as Record<string, number>;

    const tables = (
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    ).filter((t) => !t.name.startsWith("sqlite_") && !t.name.startsWith("__"));
    const counts: Record<string, number> = {};
    for (const t of tables) {
      try {
        const row = sqlite.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number };
        counts[t.name] = row.c;
      } catch {
        /* skip unreadable tables */
      }
    }
    return counts;
  }),

  // Phase 061 — data invariant verification (read-only).
  invariants: adminProcedure.query(async () => {
    const { verifyInvariants } = await import("../invariants");
    return verifyInvariants();
  }),

  // Phase 054 — data reconciliation report (read-only) + repair (admin only).
  reconcileReport: adminProcedure.query(async () => {
    const { reconcileReport } = await import("../reconcile");
    return reconcileReport();
  }),
  repairOrphans: adminProcedure.mutation(async () => {
    const { repairOrphans } = await import("../reconcile");
    return repairOrphans();
  }),

  emailIdentityConflicts: adminProcedure.query(async () => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
    return db.select().from(accountEmailConflicts)
      .where(eq(accountEmailConflicts.status, "pending"));
  }),
  resolveEmailIdentityConflict: adminProcedure
    .input(z.object({ conflictId: z.string().min(1), email: z.string().trim().email() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const normalizedEmail = normalizeAccountEmail(input.email);
      return db.transaction((tx) => {
        const conflict = tx.select().from(accountEmailConflicts).where(and(
          eq(accountEmailConflicts.id, input.conflictId),
          eq(accountEmailConflicts.status, "pending"),
        )).get();
        if (!conflict) throw new TRPCError({ code: "NOT_FOUND", message: "Pending email identity conflict not found" });
        const existing = tx.select({ id: users.id }).from(users)
          .where(sql`lower(trim(${users.email})) = ${normalizedEmail}`).get();
        if (existing && existing.id !== conflict.userId) {
          throw new TRPCError({ code: "CONFLICT", message: "That email identity is already assigned" });
        }
        tx.update(users).set({ email: normalizedEmail }).where(eq(users.id, conflict.userId)).run();
        tx.update(accountEmailConflicts)
          .set({ status: "resolved", resolvedAt: new Date() })
          .where(eq(accountEmailConflicts.id, conflict.id)).run();
        writeAuditLogOrThrow(tx, {
          userId: ctx.user.id,
          action: "account.email_identity_conflict_resolved",
          entityType: "user",
          entityId: conflict.userId,
          details: { conflictId: conflict.id },
        });
        return { resolved: true as const, userId: conflict.userId, email: normalizedEmail };
      });
    }),

  // Phase 104 — operator emergency stop (kill switch) for all outreach actions.
  emergencyStopStatus: adminProcedure.query(async () => ({ engaged: await isEmergencyStopped() })),
  setEmergencyStop: adminProcedure
    .input(z.object({ engaged: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const result = await setEmergencyStop(input.engaged, ctx.user.id);
      return { engaged: input.engaged, changed: result.changed };
    }),

  // Phase 102 — data retention: preview (dry run) and run the sweep.
  retentionPreview: adminProcedure.query(async () => previewRetentionSweep()),
  retentionRun: adminProcedure.mutation(async ({ ctx }) => {
    return runRetentionSweep(new Date(), ctx.user.id);
  }),

  uncertainOutreachDispatches: adminProcedure.query(async () => {
    const { listUncertainOutreachDispatches } = await import("../outreachSend");
    return listUncertainOutreachDispatches();
  }),
  resolveUncertainOutreachDispatch: adminProcedure
    .input(z.object({
      outreachId: z.string().min(1),
      outcome: z.enum(["delivered", "not_delivered"]),
      providerVerified: z.literal(true),
      providerReference: z.string().trim().max(200).optional(),
      note: z.string().trim().min(10).max(1000),
    }))
    .mutation(async ({ input, ctx }) => {
      const { resolveUncertainOutreachDispatch } = await import("../outreachSend");
      return resolveUncertainOutreachDispatch({
        operatorUserId: ctx.user.id,
        outreachId: input.outreachId,
        outcome: input.outcome,
        providerReference: input.providerReference,
        note: input.note,
      });
    }),

  // Phase 101 — support/debug bundle: a redacted diagnostic snapshot an operator
  // can attach to a support ticket. Contains NO secret values and NO user PII —
  // only system state, table counts, invariant results, flags, and job status.
  debugBundle: adminProcedure.query(async () => {
    let dbReady = false;
    try { dbReady = !!(await getDb()); } catch { dbReady = false; }
    const { verifyInvariants } = await import("../invariants");
    const db = await getDb();
    const counts: Record<string, number> = {};
    if (db) {
      const sqlite: any = (db as any).$client ?? (db as any).session?.client;
      if (sqlite) {
        const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
          .filter((t) => !t.name.startsWith("sqlite_") && !t.name.startsWith("__"));
        for (const t of tables) {
          try { counts[t.name] = (sqlite.prepare(`SELECT COUNT(*) AS c FROM "${t.name}"`).get() as { c: number }).c; } catch { /* skip */ }
        }
      }
    }
    return {
      generatedAt: new Date().toISOString(),
      redacted: true,
      system: {
        node: process.version, platform: process.platform,
        uptimeSeconds: Math.round(process.uptime()),
        env: ENV.NODE_ENV, isProduction: ENV.isProd, demoMode: ENV.isDemo,
        appVersion: APP_VERSION,
      },
      db: { ready: dbReady },
      tableCounts: counts,
      invariants: await verifyInvariants(),
      flags: await getAllFlags(),
      emergencyStop: await isEmergencyStopped(),
      retentionPolicy: RETENTION_POLICY,
      jobs: getJobStatus(),
    };
  }),
});
