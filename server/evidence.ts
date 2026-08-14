import { randomUUID } from "crypto";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { evidence } from "./schema";
import { emitRealtimeDataChange } from "./realtime";

export type EvidenceFileRow = typeof evidence.$inferSelect;
export type EvidenceFileView = EvidenceFileRow & {
  contentHash: string | null;
  hashAlgo: string | null;
};

function withProvenance(row: EvidenceFileRow): EvidenceFileView {
  let metadata: Record<string, unknown> = {};
  if (typeof row.metadata === "string" && row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { metadata = {}; }
  }
  return {
    ...row,
    contentHash: typeof metadata.contentHash === "string" ? metadata.contentHash : null,
    hashAlgo: typeof metadata.hashAlgo === "string" ? metadata.hashAlgo : null,
  };
}

export async function searchEvidenceFiles(opts: {
  userId: string;
  caseId?: string;
  query?: string;
  limit?: number;
  offset?: number;
}): Promise<{ files: EvidenceFileView[]; total: number }> {
  const db = await getDb();
  if (!db) return { files: [], total: 0 };

  const conditions = [eq(evidence.userId, opts.userId)];
  if (opts.caseId) conditions.push(eq(evidence.caseId, opts.caseId));
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    conditions.push(or(like(evidence.title, q), like(evidence.description, q), like(evidence.fileName, q))!);
  }

  const whereClause = and(...conditions);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const [countRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(evidence)
    .where(whereClause);
  const total = Number(countRow?.c ?? 0);

  const files = await db
    .select()
    .from(evidence)
    .where(whereClause)
    .orderBy(desc(evidence.createdAt))
    .limit(limit)
    .offset(offset);

  return { files: files.map(withProvenance), total };
}

export async function getEvidenceFile(userId: string, id: string): Promise<EvidenceFileView | null> {
  const db = await getDb();
  if (!db) return null;
  const [row] = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.id, id), eq(evidence.userId, userId)))
    .limit(1);
  return row ? withProvenance(row) : null;
}

export async function createEvidenceFile(
  userId: string,
  data: Partial<EvidenceFileRow> & {
    caseId: string;
    title: string;
    type: EvidenceFileRow["type"];
    // Phase 015 — provenance: pass raw bytes to hash, or a precomputed sha256
    // (e.g. the one returned by storeObject). The content hash is persisted in
    // metadata so every evidence write carries verifiable provenance.
    content?: Buffer | string;
    contentHash?: string;
  }
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const id = data.id ?? randomUUID();

  // Compute/attach the content hash (Phase 015). Fold it into the metadata JSON
  // without dropping any metadata the caller already provided.
  const { hashBuffer } = await import("./storage");
  const contentHash = data.contentHash ?? (data.content != null ? hashBuffer(data.content) : undefined);
  let metadata = data.metadata ?? null;
  if (contentHash) {
    let parsed: Record<string, unknown> = {};
    if (typeof metadata === "string" && metadata) {
      try { parsed = JSON.parse(metadata); } catch { parsed = { _raw: metadata }; }
    }
    parsed.contentHash = contentHash;
    parsed.hashAlgo = "sha256";
    metadata = JSON.stringify(parsed);
  }

  await db.insert(evidence).values({
    id,
    caseId: data.caseId,
    userId,
    type: data.type,
    source: data.source ?? null,
    title: data.title,
    description: data.description ?? null,
    fileUrl: data.fileUrl ?? null,
    fileName: data.fileName ?? null,
    fileSize: data.fileSize ?? null,
    mimeType: data.mimeType ?? null,
    metadata,
    tags: data.tags ?? null,
    relevant: data.relevant ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  emitRealtimeDataChange(userId, { scope: "evidence", caseId: data.caseId });
  return id;
}

export async function deleteEvidenceFile(userId: string, id: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const res = await db.delete(evidence).where(and(eq(evidence.id, id), eq(evidence.userId, userId)));
  const deleted = Number((res as unknown as { changes?: number }).changes ?? 0) > 0;
  if (deleted) emitRealtimeDataChange(userId, { scope: "evidence" });
  return deleted;
}

export async function getEvidenceFilesByCase(userId: string, caseId: string): Promise<EvidenceFileView[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.userId, userId), eq(evidence.caseId, caseId)))
    .orderBy(desc(evidence.createdAt));
  return rows.map(withProvenance);
}

export async function getEvidenceStats(userId: string): Promise<{
  total: number;
  byType: Record<string, number>;
}> {
  const db = await getDb();
  if (!db) return { total: 0, byType: {} };

  const [tot] = await db
    .select({ c: sql<number>`count(*)` })
    .from(evidence)
    .where(eq(evidence.userId, userId));

  const rows = await db
    .select({ type: evidence.type, c: sql<number>`count(*)` })
    .from(evidence)
    .where(eq(evidence.userId, userId))
    .groupBy(evidence.type);

  const byType: Record<string, number> = {};
  for (const r of rows) byType[String(r.type)] = Number(r.c);
  return { total: Number(tot?.c ?? 0), byType };
}
