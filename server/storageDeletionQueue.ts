import { randomUUID } from "crypto";
import { getDb } from "./db";
import { storageDelete } from "./storage";
import { collectManagedStorageKeys } from "./managedStorage";

type SqliteClient = {
  prepare: (sql: string) => any;
};

type QueueRow = {
  id: string;
  storageKey: string;
  attempts: number;
};

export type StorageDeletionReport = {
  processed: number;
  deleted: number;
  retained: number;
  failed: number;
  pending: number;
  requestedPending: number;
};

function rawClient(db: any): SqliteClient | null {
  return db?.$client ?? db?.session?.client ?? null;
}

export function enqueueStorageDeletions(sqlite: SqliteClient, storageKeys: string[]): void {
  const insert = sqlite.prepare(`
    INSERT INTO storage_deletion_queue
      (id, storageKey, attempts, lastError, nextAttemptAt, createdAt, updatedAt)
    VALUES (?, ?, 0, NULL, ?, ?, ?)
    ON CONFLICT(storageKey) DO NOTHING
  `);
  const now = Date.now();
  for (const storageKey of new Set(storageKeys.filter(Boolean))) {
    insert.run(randomUUID(), storageKey, now, now, now);
  }
}

function countQueuedStorageKeys(sqlite: SqliteClient, storageKeys: string[]): number {
  let count = 0;
  for (let offset = 0; offset < storageKeys.length; offset += 400) {
    const chunk = storageKeys.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    count += Number(
      (sqlite.prepare(`
        SELECT COUNT(*) AS count
        FROM storage_deletion_queue
        WHERE storageKey IN (${placeholders})
      `).get(...chunk) as { count: number }).count,
    );
  }
  return count;
}

function selectQueuedStorageKeys(sqlite: SqliteClient, storageKeys: string[], limit: number): QueueRow[] {
  const rows: QueueRow[] = [];
  for (let offset = 0; offset < storageKeys.length && rows.length < limit; offset += 400) {
    const chunk = storageKeys.slice(offset, offset + 400);
    const placeholders = chunk.map(() => "?").join(",");
    const remaining = limit - rows.length;
    rows.push(...sqlite.prepare(`
      SELECT id, storageKey, attempts
      FROM storage_deletion_queue
      WHERE storageKey IN (${placeholders})
      ORDER BY createdAt ASC
      LIMIT ?
    `).all(...chunk, remaining) as QueueRow[]);
  }
  return rows;
}

export async function processQueuedStorageDeletions(options: {
  storageKeys?: string[];
  limit?: number;
} = {}): Promise<StorageDeletionReport> {
  const db = await getDb();
  const sqlite = rawClient(db);
  if (!sqlite) throw new Error("Storage engine not available for queued deletion");

  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const keys = [...new Set((options.storageKeys ?? []).filter(Boolean))];
  let rows: QueueRow[];
  if (options.storageKeys !== undefined && keys.length === 0) {
    rows = [];
  } else if (keys.length > 0) {
    rows = selectQueuedStorageKeys(sqlite, keys, limit);
  } else {
    rows = sqlite.prepare(`
      SELECT id, storageKey, attempts
      FROM storage_deletion_queue
      WHERE nextAttemptAt <= ?
      ORDER BY createdAt ASC
      LIMIT ?
    `).all(Date.now(), limit) as QueueRow[];
  }

  let deleted = 0;
  let retained = 0;
  let failed = 0;
  const activeStorageKeys = new Set(collectManagedStorageKeys(sqlite, {}));
  for (const row of rows) {
    if (activeStorageKeys.has(row.storageKey)) {
      sqlite.prepare("DELETE FROM storage_deletion_queue WHERE id = ?").run(row.id);
      retained += 1;
      continue;
    }
    try {
      await storageDelete(row.storageKey);
      sqlite.prepare("DELETE FROM storage_deletion_queue WHERE id = ?").run(row.id);
      deleted += 1;
    } catch (error) {
      failed += 1;
      const attempts = row.attempts + 1;
      const delayMs = Math.min(24 * 60 * 60 * 1000, 1000 * (2 ** Math.min(attempts, 16)));
      const message = error instanceof Error ? error.message : String(error);
      sqlite.prepare(`
        UPDATE storage_deletion_queue
        SET attempts = ?, lastError = ?, nextAttemptAt = ?, updatedAt = ?
        WHERE id = ?
      `).run(attempts, message.slice(0, 1000), Date.now() + delayMs, Date.now(), row.id);
    }
  }

  const pending = Number(
    (sqlite.prepare("SELECT COUNT(*) AS count FROM storage_deletion_queue").get() as { count: number }).count,
  );
  const requestedPending = options.storageKeys === undefined
    ? pending
    : countQueuedStorageKeys(sqlite, keys);
  return { processed: rows.length, deleted, retained, failed, pending, requestedPending };
}
