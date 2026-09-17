/**
 * Phase 102 — data retention & archival policy.
 *
 * A real, runnable retention sweep. Audit-log rows older than the retention
 * window are the primary target: they accumulate indefinitely and hold IP/user
 * metadata that should not be kept forever (privacy minimization — see DPIA).
 *
 * The policy is conservative and reversible-by-configuration:
 *   - AUDIT_RETENTION_DAYS (default 365): audit_logs older than this are deleted.
 * The sweep is a no-op when nothing is old enough, and reports exactly what it
 * removed. It never touches user-owned business data (cases/evidence/outreach) —
 * that lifecycle is governed by the user (GDPR erasure) not by retention.
 */
import { getDb } from "./db";
import { auditLogs } from "./schema";
import { lt } from "drizzle-orm";
import { ENV } from "./_core/env";
import { writeAuditLogOrThrow } from "./audit";
import { createHash } from "node:crypto";

export const RETENTION_POLICY = {
  auditLogDays: ENV.AUDIT_RETENTION_DAYS,
} as const;

export interface RetentionReport {
  cutoffISO: string;
  auditLogsDeleted: number;
  policy: typeof RETENTION_POLICY;
}

/**
 * Run the retention sweep. `now` is injectable so the pure cutoff maths can be
 * tested deterministically (no ambient Date in the hot path).
 */
export async function runRetentionSweep(now: Date = new Date(), actorUserId?: string): Promise<RetentionReport> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const cutoff = new Date(now.getTime() - RETENTION_POLICY.auditLogDays * 24 * 60 * 60 * 1000);
  return db.transaction((tx) => {
    // Count, delete and record the mandatory retention event as one transaction.
    const stale = tx.select({ id: auditLogs.id }).from(auditLogs).where(lt(auditLogs.createdAt, cutoff)).all();
    const report = {
      cutoffISO: cutoff.toISOString(),
      auditLogsDeleted: stale.length,
      policy: RETENTION_POLICY,
    };
    const staleDigest = createHash("sha256")
      .update(stale.map((item) => item.id).sort().join("\0"))
      .digest("hex");
    if (stale.length > 0) tx.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff)).run();
    writeAuditLogOrThrow(tx, {
      userId: actorUserId,
      action: "retention.sweep",
      entityType: "system",
      entityId: "audit_logs",
      details: report,
      idempotencyKey: `retention:${report.cutoffISO}:${staleDigest}`,
    });
    return report;
  });
}

/** Report what a sweep WOULD remove, without deleting (dry run). */
export async function previewRetentionSweep(now: Date = new Date()): Promise<RetentionReport> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const cutoff = new Date(now.getTime() - RETENTION_POLICY.auditLogDays * 24 * 60 * 60 * 1000);
  const stale = await db.select({ id: auditLogs.id }).from(auditLogs).where(lt(auditLogs.createdAt, cutoff));
  return { cutoffISO: cutoff.toISOString(), auditLogsDeleted: stale.length, policy: RETENTION_POLICY };
}
