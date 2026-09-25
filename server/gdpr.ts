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
import { enqueueStorageDeletions, processQueuedStorageDeletions } from "./storageDeletionQueue";
import { nanoid } from "nanoid";
import { createHash } from 'node:crypto';
import { writeAuditLogOrThrow } from "./audit";
import { systemConfig } from "./schema";
import {
  prepareProviderConnectionsForErasure,
  type ProviderErasureRevocationSummary,
} from "./providerConnections";

type DesktopScannerPrivacyProvider = {
  export: (userId: string) => { scans: unknown[]; files: unknown[] };
  erase: (userId: string) => Promise<{ scans: number; files: number }>;
};

// Installed only by the integrated Electron process. A standalone/hosted API
// has no direct authority over private scanner state on a connected desktop.
let desktopScannerPrivacyProvider: DesktopScannerPrivacyProvider | null = null;

export function registerDesktopScannerPrivacyProvider(provider: DesktopScannerPrivacyProvider | null): void {
  desktopScannerPrivacyProvider = provider;
}

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

function ownerConfigKeys(userId: string): string[] {
  const digest = createHash('sha256').update(userId).digest('hex');
  const rateLimitKeys = ['erasureCodeRequest', 'erasureReauthenticate'].map((scope) =>
    `rate-limit:${createHash('sha256').update(`${scope}:user:${userId}`).digest('hex')}`);
  return [
    `onboarding:state:${userId}`, `onboarding:complete:${userId}`,
    `caseDraft:${userId}`, `session:revokedAfter:${userId}`,
    `acceptance:outbound-email:${userId}`,
    `acceptance:google-evidence:${userId}`,
    `acceptance:google-drive-evidence:${userId}`,
    ...rateLimitKeys,
    ...(['global', 'local', 'external'] as const).flatMap((scope) =>
      (['requests', 'inputCharacters', 'outputTokens'] as const)
        .map((metric) => `llm-budget:v1:${digest}:${scope}:${metric}`)),
  ];
}

function ownedIds(sqlite: any, table: string, userId: string): string[] {
  return (sqlite.prepare(`SELECT id FROM "${table}" WHERE userId = ?`).all(userId) as Array<{ id: string }>).map((row) => row.id);
}

function rowsForIds(sqlite: any, table: string, column: string, ids: string[]): unknown[] {
  if (ids.length === 0) return [];
  const rows: unknown[] = [];
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    rows.push(...sqlite.prepare(`SELECT * FROM "${table}" WHERE "${column}" IN (${chunk.map(() => '?').join(',')})`).all(...chunk));
  }
  return rows;
}

function deleteForIds(sqlite: any, table: string, column: string, ids: string[]): number {
  let removed = 0;
  for (let offset = 0; offset < ids.length; offset += 400) {
    const chunk = ids.slice(offset, offset + 400);
    removed += sqlite.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (${chunk.map(() => '?').join(',')})`).run(...chunk).changes;
  }
  return removed;
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
  // Onboarding presentation state is owner-scoped through its config key rather
  // than a userId column, so include it explicitly in access and erasure rights.
  const ownerKeys = ownerConfigKeys(userId);
  const ownerConfig = sqlite.prepare(
    `SELECT * FROM system_config WHERE configKey IN (${ownerKeys.map(() => '?').join(',')})`,
  ).all(...ownerKeys);
  if (ownerConfig.length > 0) out.system_config = redactExportRows(ownerConfig);
  const caseIds = ownedIds(sqlite, 'cases', userId);
  const accountIds = ownedIds(sqlite, 'email_accounts', userId);
  const evidenceFileIds = ownedIds(sqlite, 'evidence_files', userId);
  const tagIds = ownedIds(sqlite, 'evidence_tags', userId);
  for (const table of listUserTables(sqlite)) {
    if (tableColumns(sqlite, table).includes('userId')) continue;
    const columns = tableColumns(sqlite, table);
    const rows = [
      ...(columns.includes('caseId') ? rowsForIds(sqlite, table, 'caseId', caseIds) : []),
      ...(columns.includes('accountId') ? rowsForIds(sqlite, table, 'accountId', accountIds) : []),
      ...(table === 'evidence_file_tags' ? [
        ...rowsForIds(sqlite, table, 'evidenceFileId', evidenceFileIds),
        ...rowsForIds(sqlite, table, 'tagId', tagIds),
      ] : []),
    ] as Array<{ id?: string }>;
    const distinct = [...new Map(rows.map((row) => [row.id, row])).values()];
    if (distinct.length > 0) out[table] = redactExportRows(distinct);
  }
  if (desktopScannerPrivacyProvider) {
    const scanner = desktopScannerPrivacyProvider.export(userId);
    out.desktop_scanner_scans = scanner.scans;
    out.desktop_scanner_files = scanner.files;
  }
  return out;
}

/**
 * Permanently delete all data owned by the user, then the user row. Returns the
 * per-table deletion counts. Runs in a transaction so a partial failure rolls
 * back.
 */
async function performDeleteUserData(userId: string): Promise<{
  deleted: Record<string, number>;
  storageCleanupPending: number;
  erasureStatus: "completed" | "storage_cleanup_pending" | "revocation_pending";
  erasureRequestId: string;
  providerRevocation: ProviderErasureRevocationSummary;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const sqlite = rawClient(db);
  if (!sqlite) throw new Error("Storage engine not available for deletion");

  // Remote grants must be revoked before their encrypted local copies disappear.
  // If upstream is unavailable, keep credentials and return a retryable state.
  const providerRevocation = await prepareProviderConnectionsForErasure(userId);
  const existingState = sqlite.prepare(
    'SELECT configValue FROM system_config WHERE configKey = ?',
  ).get(`erasure:pending:${userId}`) as { configValue: string | null } | undefined;
  let erasureRequestId = `ERASURE-${nanoid(16)}`;
  try {
    const previous = JSON.parse(existingState?.configValue || '{}') as { erasureRequestId?: string };
    if (typeof previous.erasureRequestId === 'string' && /^ERASURE-[A-Za-z0-9_-]{16}$/.test(previous.erasureRequestId)) {
      erasureRequestId = previous.erasureRequestId;
    }
  } catch { /* replace invalid legacy state */ }
  if (providerRevocation.failed > 0) {
    db.transaction((tx) => {
      tx.insert(systemConfig).values({
        configKey: `erasure:pending:${userId}`,
        configValue: JSON.stringify({ erasureRequestId, erasureStatus: 'revocation_pending', providerRevocation }),
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: systemConfig.configKey,
        set: { configValue: JSON.stringify({ erasureRequestId, erasureStatus: 'revocation_pending', providerRevocation }), updatedAt: new Date() },
      }).run();
      writeAuditLogOrThrow(tx, {
        userId,
        action: 'gdpr.erasure_revocation_pending',
        entityType: 'gdpr_erasure',
        entityId: erasureRequestId,
        details: { erasureRequestId, providerRevocation, localCredentialsRetained: true },
      });
    });
    return {
      deleted: {},
      storageCleanupPending: 0,
      erasureStatus: 'revocation_pending',
      erasureRequestId,
      providerRevocation,
    };
  }

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

  const userCaseIds = ownedIds(sqlite, 'cases', userId);
  const accountIds = ownedIds(sqlite, 'email_accounts', userId);
  const evidenceFileIds = ownedIds(sqlite, 'evidence_files', userId);
  const tagIds = ownedIds(sqlite, 'evidence_tags', userId);
  const ownerOutreachIds = rowsForIds(sqlite, 'outreach_status', 'caseId', userCaseIds)
    .map((row: any) => row.id).filter((id): id is string => typeof id === 'string');
  const storageKeys = collectManagedStorageKeys(sqlite, { userId, caseIds: userCaseIds });

  const deleted: Record<string, number> = {};
  // Erase the separate desktop store first. If later server erasure fails, the
  // user can retry; private scanner paths are not left behind in an inaccessible
  // database after the account is removed. Cross-database rollback is not
  // represented as atomic.
  if (desktopScannerPrivacyProvider) {
    const scanner = await desktopScannerPrivacyProvider.erase(userId);
    if (scanner.scans) deleted.desktop_scanner_scans = scanner.scans;
    if (scanner.files) deleted.desktop_scanner_files = scanner.files;
  }
  const tx = sqlite.transaction(() => {
    enqueueStorageDeletions(sqlite, storageKeys);
    for (const [table, column, ids] of [
      ['email_sync_jobs', 'accountId', accountIds],
      ['email_messages', 'accountId', accountIds],
      ['evidence_file_tags', 'evidenceFileId', evidenceFileIds],
      ['evidence_file_tags', 'tagId', tagIds],
    ] as const) {
      const count = deleteForIds(sqlite, table, column, ids);
      if (count > 0) deleted[table] = (deleted[table] ?? 0) + count;
    }
    // 1. Purge caseId-scoped children for the cases captured above.
    if (userCaseIds.length > 0) {
      for (const table of caseScoped) {
        const count = deleteForIds(sqlite, table, 'caseId', userCaseIds);
        if (count) deleted[table] = (deleted[table] ?? 0) + count;
      }
    }

    // 2. Delete userId-scoped rows (includes cases).
    for (const table of userScoped) {
      const info = sqlite.prepare(`DELETE FROM "${table}" WHERE userId = ?`).run(userId);
      if (info.changes) deleted[table] = (deleted[table] ?? 0) + info.changes;
    }

    // Presentation state has no userId column but still belongs to this owner.
    const configKeys = [
      ...ownerConfigKeys(userId),
      `erasure:pending:${userId}`, `erasure:code:${userId}`, `erasure:proof:${userId}`,
      ...ownerOutreachIds.map((id) => `sent:${id}`),
    ];
    const configRemoved = deleteForIds(sqlite, 'system_config', 'configKey', configKeys);
    if (configRemoved) deleted.system_config = configRemoved;

    // 3. Delete the user record itself.
    const userInfo = sqlite.prepare(`DELETE FROM "users" WHERE id = ?`).run(userId);
    if (userInfo.changes) deleted.users = userInfo.changes;

    // The durable erasure receipt intentionally has no user identifier. It is
    // written after user-scoped audit rows are erased, but inside the same
    // transaction so an audit failure restores the account and every row.
    writeAuditLogOrThrow(db, {
      action: "gdpr.delete",
      entityType: "gdpr_erasure",
      entityId: erasureRequestId,
      details: {
        erasureRequestId,
        deletedRowsByTable: deleted,
        storageObjectsQueued: storageKeys.length,
        providerRevocation,
        actor: "self_service_account_owner",
      },
      idempotencyKey: `gdpr-delete:${erasureRequestId}`,
    });
    sqlite.prepare(`INSERT INTO system_config (configKey, configValue, updatedAt)
      VALUES (?, ?, ?)
      ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`
    ).run(`erasure:request:${erasureRequestId}`, JSON.stringify({
      erasureRequestId,
      erasureStatus: 'storage_cleanup_pending',
      storageKeys,
      providerRevocation,
    }), Math.floor(Date.now() / 1_000));
  });
  tx();

  let requestedPending: number;
  try {
    const cleanup = await processQueuedStorageDeletions({ storageKeys });
    requestedPending = cleanup.requestedPending;
  } catch {
    // The account is already gone. Keep the durable queue/receipt pending for
    // the scheduled worker instead of surfacing an ambiguous deletion failure.
    requestedPending = storageKeys.length;
  }
  const erasureStatus = requestedPending > 0 ? 'storage_cleanup_pending' : 'completed';
  sqlite.prepare('UPDATE system_config SET configValue = ?, updatedAt = ? WHERE configKey = ?').run(
    JSON.stringify({ erasureRequestId, erasureStatus, storageKeys: erasureStatus === 'completed' ? [] : storageKeys, providerRevocation }),
    Math.floor(Date.now() / 1_000),
    `erasure:request:${erasureRequestId}`,
  );

  return {
    deleted,
    storageCleanupPending: requestedPending,
    erasureStatus,
    erasureRequestId,
    providerRevocation,
  };
}

export async function deleteUserData(userId: string): ReturnType<typeof performDeleteUserData> {
  try {
    return await performDeleteUserData(userId);
  } catch (error) {
    // A failed relational/scanner stage retains the account. Record a durable,
    // retryable state without persisting exception text or private source data.
    try {
      const db = await getDb();
      const sqlite = rawClient(db);
      if (sqlite && sqlite.prepare('SELECT id FROM users WHERE id = ?').get(userId)) {
        const key = `erasure:pending:${userId}`;
        const existing = sqlite.prepare('SELECT configValue FROM system_config WHERE configKey = ?')
          .get(key) as { configValue: string | null } | undefined;
        let requestId = `ERASURE-${nanoid(16)}`;
        try {
          const parsed = JSON.parse(existing?.configValue || '{}') as { erasureRequestId?: string };
          if (typeof parsed.erasureRequestId === 'string' && /^ERASURE-[A-Za-z0-9_-]{16}$/.test(parsed.erasureRequestId)) {
            requestId = parsed.erasureRequestId;
          }
        } catch { /* ignore malformed prior state */ }
        sqlite.prepare(`INSERT INTO system_config (configKey, configValue, updatedAt)
          VALUES (?, ?, ?)
          ON CONFLICT(configKey) DO UPDATE SET configValue = excluded.configValue, updatedAt = excluded.updatedAt`
        ).run(key, JSON.stringify({ erasureRequestId: requestId, erasureStatus: 'failed' }), Math.floor(Date.now() / 1_000));
      }
    } catch {
      console.error('[GDPR] Could not persist failed erasure state');
    }
    throw error;
  }
}
