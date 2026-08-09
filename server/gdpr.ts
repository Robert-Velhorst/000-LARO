/**
 * Phase 028 — privacy controls and data deletion (GDPR access + erasure).
 *
 * Previously the gdpr.* endpoints were empty stubs returning `{}`. These helpers
 * implement the real rights:
 *  - exportUserData: a full JSON dump of every row owned by the user, gathered
 *    by introspecting which tables have a `userId` column.
 *  - deleteUserData: erases every user-owned row across those tables (plus the
 *    case-scoped child rows) and finally the user record itself, inside a
 *    transaction.
 *
 * Both are driven by sqlite_master introspection so they stay correct as the
 * schema grows, mirroring the cascade approach already used by cases.delete.
 */
import { getDb } from "./db";
import { collectManagedStorageKeys } from "./managedStorage";
import { storageDelete } from "./storage";

function rawClient(db: any): any {
  return db.$client ?? db.session?.client ?? null;
}

function listUserTables(sqlite: any): string[] {
  // NB: filter internal tables in JS — a SQL `LIKE '__%'` would treat `_` as a
  // wildcard and exclude every table name of length >= 2.
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  return tables
    .map((t) => t.name)
    .filter((n) => !n.startsWith("sqlite_") && !n.startsWith("__"));
}

function tableColumns(sqlite: any, table: string): string[] {
  try {
    const cols = sqlite.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    return cols.map((c) => c.name);
  } catch {
    return [];
  }
}

const OMIT_FROM_EXPORT = Symbol("omit-from-export");
const SENSITIVE_EXPORT_FIELDS = new Set([
  "password",
  "passwordhash",
  "resetcodehash",
  "accesstoken",
  "refreshtoken",
  "token",
  "tokenhash",
  "apikey",
  "secret",
  "clientsecret",
  "authorization",
  "cookie",
]);

function normalizedFieldName(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function redactExportValue(value: unknown, key?: string): unknown | typeof OMIT_FROM_EXPORT {
  if (key && SENSITIVE_EXPORT_FIELDS.has(normalizedFieldName(key))) {
    return OMIT_FROM_EXPORT;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => redactExportValue(item))
      .filter((item) => item !== OMIT_FROM_EXPORT);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([entryKey, entryValue]) => [entryKey, redactExportValue(entryValue, entryKey)] as const)
        .filter(([, entryValue]) => entryValue !== OMIT_FROM_EXPORT)
    );
  }
  if (typeof value === "string" && key?.toLowerCase().includes("metadata")) {
    try {
      const parsed = JSON.parse(value);
      const redacted = redactExportValue(parsed);
      return JSON.stringify(redacted === OMIT_FROM_EXPORT ? null : redacted);
    } catch {
      return value;
    }
  }
  return value;
}

function redactExportRows(rows: unknown[]): unknown[] {
  return rows.map((row) => redactExportValue(row)).filter((row) => row !== OMIT_FROM_EXPORT);
}

/**
 * Export every row owned by the user. Returns a structured object keyed by table
 * name. Tables with a `userId` column are exported by owner; the user's own row
 * is exported from `users`.
 */
export async function exportUserData(userId: string): Promise<Record<string, any>> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const sqlite = rawClient(db);
  if (!sqlite) throw new Error("Storage engine not available for export");

  const out: Record<string, any> = {
    _meta: { userId, exportedFormat: "json", generatedBy: "LARO GDPR export (Phase 028)" },
  };

  for (const table of listUserTables(sqlite)) {
    const cols = tableColumns(sqlite, table);
    try {
      if (table === "users" && cols.includes("id")) {
        out.users = redactExportRows(sqlite.prepare(`SELECT * FROM "users" WHERE id = ?`).all(userId));
      } else if (cols.includes("userId")) {
        const rows = sqlite.prepare(`SELECT * FROM "${table}" WHERE userId = ?`).all(userId);
        if (rows.length > 0) out[table] = redactExportRows(rows);
      }
    } catch (e) {
      // Skip tables we cannot read; do not fail the whole export.
      console.warn(`[GDPR] export: skipped ${table}:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/**
 * Permanently delete all data owned by the user, then the user row. Returns the
 * per-table deletion counts. Runs in a transaction so a partial failure rolls
 * back.
 */
export async function deleteUserData(userId: string): Promise<{ deleted: Record<string, number> }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const sqlite = rawClient(db);
  if (!sqlite) throw new Error("Storage engine not available for deletion");

  const tables = listUserTables(sqlite);
  const userScoped = tables.filter((t) => t !== "users" && tableColumns(sqlite, t).includes("userId"));
  // Phase 078 (red-team fix): rows keyed only by caseId (outreach_status,
  // email_activity, communication_gaps, expected_documents, suspicious_patterns,
  // legal_inferences, case_strength_analysis, …) are NOT userId-scoped, so a
  // userId-only delete left them orphaned after the user's cases were removed —
  // incomplete GDPR erasure. We now collect the user's case ids first and purge
  // every caseId-scoped child row for those cases.
  const caseScoped = tables.filter(
    (t) => t !== "cases" && !tableColumns(sqlite, t).includes("userId") && tableColumns(sqlite, t).includes("caseId")
  );

  const userCaseIds = (sqlite.prepare("SELECT id FROM cases WHERE userId = ?").all(userId) as Array<{ id: string }>).map((r) => r.id);
  const storageKeys = collectManagedStorageKeys(sqlite, { userId, caseIds: userCaseIds });

  // Storage cannot participate in the SQLite transaction. Delete every owned
  // object before removing its metadata, and abort the erasure if any provider
  // refuses a deletion. A retry is then safe because storageDelete is idempotent.
  for (const key of storageKeys) await storageDelete(key);

  const deleted: Record<string, number> = {};
  const tx = sqlite.transaction(() => {
    // 1. Purge caseId-scoped children for the cases captured above.
    if (userCaseIds.length > 0) {
      const placeholders = userCaseIds.map(() => "?").join(",");
      for (const table of caseScoped) {
        const info = sqlite.prepare(`DELETE FROM "${table}" WHERE caseId IN (${placeholders})`).run(...userCaseIds);
        if (info.changes) deleted[table] = info.changes;
      }
    }

    // 2. Delete userId-scoped rows (includes cases).
    for (const table of userScoped) {
      const info = sqlite.prepare(`DELETE FROM "${table}" WHERE userId = ?`).run(userId);
      if (info.changes) deleted[table] = (deleted[table] ?? 0) + info.changes;
    }

    // 3. Delete the user record itself.
    const userInfo = sqlite.prepare(`DELETE FROM "users" WHERE id = ?`).run(userId);
    if (userInfo.changes) deleted.users = userInfo.changes;
  });
  tx();

  return { deleted };
}
