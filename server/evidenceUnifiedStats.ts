import { eq, sql, and } from "drizzle-orm";
import { evidence, evidenceFiles } from "./schema";

/** Drizzle sqlite instance from `getDb()` */
type AnyDb = any;

function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Aggregate counts from legacy `evidence` rows (Collect / manual) and `evidence_files` (scanner). */
export async function getUnifiedEvidenceStats(db: AnyDb, userId: string) {
  const [legacy] = await db
    .select({
      totalFiles: sql<number>`count(*)`,
      totalSize: sql<number>`coalesce(sum(${evidence.fileSize}), 0)`,
    })
    .from(evidence)
    .where(eq(evidence.userId, userId));

  const [scanned] = await db
    .select({
      totalFiles: sql<number>`count(*)`,
      totalSize: sql<number>`coalesce(sum(${evidenceFiles.fileSize}), 0)`,
    })
    .from(evidenceFiles)
    .where(eq(evidenceFiles.userId, userId));

  const manualLegacy = n(legacy?.totalFiles);
  const manualScanned = n(scanned?.totalFiles);
  const sizeLegacy = n(legacy?.totalSize);
  const sizeScanned = n(scanned?.totalSize);

  return {
    totalFiles: manualLegacy + manualScanned,
    totalSize: sizeLegacy + sizeScanned,
    manualUploads: manualLegacy,
    agentUploads: manualScanned,
  };
}

export async function getUnifiedFileTypeDistribution(db: AnyDb, userId: string) {
  const legacyRows = await db
    .select({
      fileType: evidence.type,
      count: sql<number>`count(*)`,
    })
    .from(evidence)
    .where(eq(evidence.userId, userId))
    .groupBy(evidence.type);

  const scannedRows = await db
    .select({
      fileType: evidenceFiles.fileType,
      count: sql<number>`count(*)`,
    })
    .from(evidenceFiles)
    .where(eq(evidenceFiles.userId, userId))
    .groupBy(evidenceFiles.fileType);

  const map = new Map<string, number>();
  for (const r of legacyRows) {
    const k = String(r.fileType || "unknown");
    map.set(k, (map.get(k) ?? 0) + n(r.count));
  }
  for (const r of scannedRows) {
    const k = String(r.fileType || "unknown");
    map.set(k, (map.get(k) ?? 0) + n(r.count));
  }
  return [...map.entries()].map(([fileType, count]) => ({ fileType, count }));
}

export async function getUnifiedUploadTimeline(
  db: AnyDb,
  userId: string,
  startMs: number
) {
  const legacy = await db
    .select({
      date: sql<string>`date(${evidence.createdAt} / 1000, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(evidence)
    .where(and(eq(evidence.userId, userId), sql`${evidence.createdAt} >= ${startMs}`))
    .groupBy(sql`date(${evidence.createdAt} / 1000, 'unixepoch')`);

  const scanned = await db
    .select({
      date: sql<string>`date(${evidenceFiles.uploadedAt} / 1000, 'unixepoch')`,
      count: sql<number>`count(*)`,
    })
    .from(evidenceFiles)
    .where(and(eq(evidenceFiles.userId, userId), sql`${evidenceFiles.uploadedAt} >= ${startMs}`))
    .groupBy(sql`date(${evidenceFiles.uploadedAt} / 1000, 'unixepoch')`);

  const byDate = new Map<string, number>();
  for (const r of legacy) {
    if (r.date) byDate.set(r.date, (byDate.get(r.date) ?? 0) + n(r.count));
  }
  for (const r of scanned) {
    if (r.date) byDate.set(r.date, (byDate.get(r.date) ?? 0) + n(r.count));
  }
  return [...byDate.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getUnifiedStorageByCase(db: AnyDb, userId: string, limit = 10) {
  const legacy = await db
    .select({
      caseId: evidence.caseId,
      totalSize: sql<number>`sum(${evidence.fileSize})`,
    })
    .from(evidence)
    .where(eq(evidence.userId, userId))
    .groupBy(evidence.caseId);

  const scanned = await db
    .select({
      caseId: evidenceFiles.caseId,
      totalSize: sql<number>`sum(${evidenceFiles.fileSize})`,
    })
    .from(evidenceFiles)
    .where(eq(evidenceFiles.userId, userId))
    .groupBy(evidenceFiles.caseId);

  const map = new Map<string, number>();
  for (const r of legacy) {
    const id = r.caseId || "unassigned";
    map.set(id, (map.get(id) ?? 0) + n(r.totalSize));
  }
  for (const r of scanned) {
    const id = r.caseId || "unassigned";
    map.set(id, (map.get(id) ?? 0) + n(r.totalSize));
  }
  return [...map.entries()]
    .map(([caseId, totalSize]) => ({ caseId, totalSize }))
    .sort((a, b) => b.totalSize - a.totalSize)
    .slice(0, limit);
}

export async function getUnifiedUploadSourceBreakdown(db: AnyDb, userId: string) {
  const legacy = await db
    .select({
      uploadSource: evidence.source,
      count: sql<number>`count(*)`,
    })
    .from(evidence)
    .where(eq(evidence.userId, userId))
    .groupBy(evidence.source);

  const scanned = await db
    .select({
      uploadSource: evidenceFiles.uploadSource,
      count: sql<number>`count(*)`,
    })
    .from(evidenceFiles)
    .where(eq(evidenceFiles.userId, userId))
    .groupBy(evidenceFiles.uploadSource);

  const map = new Map<string, number>();
  for (const r of legacy) {
    const k = String(r.uploadSource || "manual");
    map.set(k, (map.get(k) ?? 0) + n(r.count));
  }
  for (const r of scanned) {
    const k = String(r.uploadSource || "manual");
    map.set(k, (map.get(k) ?? 0) + n(r.count));
  }
  return [...map.entries()].map(([uploadSource, count]) => ({ uploadSource, count }));
}
