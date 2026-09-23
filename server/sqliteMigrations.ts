import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

type SqliteClient = InstanceType<typeof Database>;

type SchemaColumn = {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
};

type SchemaSnapshot = Map<string, Map<string, SchemaColumn>>;

type AppliedMigration = {
  hash: string;
  createdAt: number;
};

export type SqliteMigrationResult = {
  backupPath: string | null;
  migrationsApplied: number;
  schemaSignature: string;
};

const BASELINE_VERSION = 1;
const BASELINE_TABLE = "laro_schema_baseline";
const REQUIRED_BACKUP_TABLES = ["users", "lawyers", "cases", "evidence", "audit_logs", "system_config"];
const INTERNAL_TABLES = new Set(["__drizzle_migrations", "sqlite_sequence"]);
const BASELINE_COMPATIBILITY_COLUMNS: Record<string, SchemaColumn> = {
  resetCodeHash: {
    name: "resetCodeHash",
    type: "text",
    notNull: false,
    primaryKey: false,
  },
  resetCodeExpiresAt: {
    name: "resetCodeExpiresAt",
    type: "text",
    notNull: false,
    primaryKey: false,
  },
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeType(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function listTables(sqlite: SqliteClient): string[] {
  return (sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  ).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && !INTERNAL_TABLES.has(name));
}

function readColumns(sqlite: SqliteClient, table: string): Map<string, SchemaColumn> {
  const rows = sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  return new Map(rows.map((row) => [row.name, {
    name: row.name,
    type: normalizeType(row.type),
    notNull: Boolean(row.notnull),
    primaryKey: Boolean(row.pk),
  }]));
}

function captureSchema(sqlite: SqliteClient): SchemaSnapshot {
  return new Map(listTables(sqlite).map((table) => [table, readColumns(sqlite, table)]));
}

function columnDescription(column: SchemaColumn): string {
  return `${column.type}${column.notNull ? " not null" : ""}${column.primaryKey ? " primary key" : ""}`;
}

function compareColumns(actual: SchemaColumn, expected: SchemaColumn): boolean {
  return normalizeType(actual.type) === normalizeType(expected.type)
    && actual.notNull === expected.notNull
    && actual.primaryKey === expected.primaryKey;
}

function compareSnapshots(
  actual: SchemaSnapshot,
  expected: SchemaSnapshot,
  allowBaselineCompatibilityColumns = false,
): string[] {
  const drift: string[] = [];
  const tableNames = new Set([...actual.keys(), ...expected.keys()]);
  for (const table of [...tableNames].sort()) {
    const actualColumns = actual.get(table);
    const expectedColumns = expected.get(table);
    if (!actualColumns) {
      drift.push(`missing table ${table}`);
      continue;
    }
    if (!expectedColumns) {
      drift.push(`unexpected table ${table}`);
      continue;
    }

    const columnNames = new Set([...actualColumns.keys(), ...expectedColumns.keys()]);
    for (const columnName of [...columnNames].sort()) {
      const actualColumn = actualColumns.get(columnName);
      const expectedColumn = expectedColumns.get(columnName);
      if (!expectedColumn && allowBaselineCompatibilityColumns && table === "users") {
        const compatibilityColumn = BASELINE_COMPATIBILITY_COLUMNS[columnName];
        if (actualColumn && compatibilityColumn && compareColumns(actualColumn, compatibilityColumn)) continue;
      }
      if (!actualColumn) {
        drift.push(`missing column ${table}.${columnName}`);
      } else if (!expectedColumn) {
        drift.push(`unexpected column ${table}.${columnName}`);
      } else if (!compareColumns(actualColumn, expectedColumn)) {
        drift.push(
          `column ${table}.${columnName} is ${columnDescription(actualColumn)}; expected ${columnDescription(expectedColumn)}`,
        );
      }
    }
  }
  return drift;
}

function declaredSchemaSnapshot(): SchemaSnapshot {
  const snapshot: SchemaSnapshot = new Map();
  for (const exported of Object.values(schema)) {
    try {
      const config = getTableConfig(exported as never);
      if (!config?.name || !config.columns) continue;
      snapshot.set(config.name, new Map(config.columns.map((column) => [column.name, {
        name: column.name,
        type: normalizeType(column.getSQLType()),
        notNull: Boolean(column.notNull),
        primaryKey: Boolean(column.primary),
      }])));
    } catch {
      // schema.ts also exports inferred types and helpers; only tables reflect.
    }
  }
  return snapshot;
}

function stableSignature(snapshot: SchemaSnapshot): string {
  return [...snapshot.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([table, columns]) => `${table}(${[...columns.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((column) => `${column.name}:${columnDescription(column)}`)
      .join(",")})`)
    .join("\n");
}

export function validateDeclaredSqliteSchema(sqlite: SqliteClient): {
  ok: boolean;
  drift: string[];
  signature: string;
} {
  const actual = captureSchema(sqlite);
  actual.delete(BASELINE_TABLE);
  const expected = declaredSchemaSnapshot();
  const drift = compareSnapshots(actual, expected);
  return { ok: drift.length === 0, drift, signature: stableSignature(actual) };
}

function migrationHistory(sqlite: SqliteClient): AppliedMigration[] {
  const exists = sqlite.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
  ).get() as { present: number } | undefined;
  if (!exists) return [];
  return (sqlite.prepare(
    "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at, id",
  ).all() as Array<{ hash: string; createdAt: number | string }>).map((row) => ({
    hash: row.hash,
    createdAt: Number(row.createdAt),
  }));
}

function validateMigrationHistory(
  applied: AppliedMigration[],
  migrations: ReturnType<typeof readMigrationFiles>,
): number {
  if (applied.length === 0) return -1;
  const expectedByTimestamp = new Map(migrations.map((migration, index) => [
    migration.folderMillis,
    { migration, index },
  ]));
  const seen = new Set<number>();
  let lastIndex = -1;
  for (const row of applied) {
    const expected = expectedByTimestamp.get(row.createdAt);
    if (!expected || expected.migration.hash !== row.hash) {
      throw new Error(
        `Unclassified SQLite migration history at ${row.createdAt}; restore a verified backup and review the schema before retrying.`,
      );
    }
    if (seen.has(row.createdAt)) {
      throw new Error(`Duplicate SQLite migration history entry at ${row.createdAt}.`);
    }
    seen.add(row.createdAt);
    lastIndex = Math.max(lastIndex, expected.index);
  }
  for (let index = 0; index <= lastIndex; index += 1) {
    if (!seen.has(migrations[index].folderMillis)) {
      throw new Error(`SQLite migration history has a gap before ${migrations[index].folderMillis}.`);
    }
  }
  return lastIndex;
}

function expectedSnapshotAt(
  migrations: ReturnType<typeof readMigrationFiles>,
  lastIndex: number,
): SchemaSnapshot {
  const probe = new Database(":memory:");
  try {
    probe.pragma("foreign_keys = ON");
    for (let index = 0; index <= lastIndex; index += 1) {
      for (const statement of migrations[index].sql) {
        if (statement.trim()) probe.exec(statement);
      }
    }
    return captureSchema(probe);
  } finally {
    probe.close();
  }
}

function baselineNeedsReconciliation(sqlite: SqliteClient): boolean {
  const userColumns = readColumns(sqlite, "users");
  for (const expected of Object.values(BASELINE_COMPATIBILITY_COLUMNS)) {
    const actual = userColumns.get(expected.name);
    if (!actual) return true;
    if (!compareColumns(actual, expected)) {
      throw new Error(
        `Unclassified SQLite schema drift: users.${expected.name} is ${columnDescription(actual)}; expected ${columnDescription(expected)}.`,
      );
    }
  }
  const baselineExists = listTables(sqlite).includes(BASELINE_TABLE);
  if (!baselineExists) return true;
  const row = sqlite.prepare(
    `SELECT reconciledAt FROM ${BASELINE_TABLE} WHERE version = ?`,
  ).get(BASELINE_VERSION) as { reconciledAt: number | null } | undefined;
  return !row?.reconciledAt;
}

function reconcileBaseline(sqlite: SqliteClient): void {
  const reconcile = sqlite.transaction(() => {
    const marker = sqlite.prepare(
      `SELECT name FROM ${BASELINE_TABLE} WHERE version = ?`,
    ).get(BASELINE_VERSION) as { name: string } | undefined;
    if (marker?.name !== "non-destructive-v1") {
      throw new Error(`SQLite baseline ${BASELINE_VERSION} is missing or unrecognized.`);
    }
    const columns = readColumns(sqlite, "users");
    for (const expected of Object.values(BASELINE_COMPATIBILITY_COLUMNS)) {
      const actual = columns.get(expected.name);
      if (!actual) {
        sqlite.exec(`ALTER TABLE users ADD COLUMN ${quoteIdentifier(expected.name)} text`);
        continue;
      }
      if (!compareColumns(actual, expected)) {
        throw new Error(
          `Unclassified SQLite schema drift: users.${expected.name} is ${columnDescription(actual)}; expected ${columnDescription(expected)}.`,
        );
      }
    }
    sqlite.prepare(
      `UPDATE ${BASELINE_TABLE} SET reconciledAt = ? WHERE version = ?`,
    ).run(Date.now(), BASELINE_VERSION);
  });
  reconcile();
}

function assertBackup(sqlitePath: string): void {
  const probe = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = probe.pragma("quick_check") as Array<{ quick_check: string }>;
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
      throw new Error(`quick_check returned ${JSON.stringify(quickCheck)}`);
    }
    const foreignKeyErrors = probe.pragma("foreign_key_check") as unknown[];
    if (foreignKeyErrors.length > 0) {
      throw new Error(`foreign_key_check found ${foreignKeyErrors.length} violation(s)`);
    }
    const tables = new Set(listTables(probe));
    const missing = REQUIRED_BACKUP_TABLES.filter((table) => !tables.has(table));
    if (missing.length > 0) throw new Error(`missing core tables: ${missing.join(", ")}`);
  } finally {
    probe.close();
  }
}

async function createVerifiedMigrationBackup(
  sqlite: SqliteClient,
  databasePath: string,
): Promise<string> {
  const resolvedDatabasePath = path.resolve(databasePath);
  const backupDirectory = path.join(path.dirname(resolvedDatabasePath), "db-backups");
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const suffix = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const backupPath = path.join(
    backupDirectory,
    `${path.basename(resolvedDatabasePath)}.pre-migration-${suffix}-${process.pid}.bak`,
  );
  try {
    await sqlite.backup(backupPath);
    fs.chmodSync(backupPath, 0o600);
    assertBackup(backupPath);
  } catch (error) {
    try { fs.unlinkSync(backupPath); } catch { /* preserve verification failure */ }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Pre-migration backup verification failed: ${message}`);
  }
  return backupPath;
}

export async function runSqliteMigrations(options: {
  sqlite: SqliteClient;
  drizzleDb: Parameters<typeof migrate>[0];
  migrationsFolder: string;
  databasePath: string;
}): Promise<SqliteMigrationResult> {
  const { sqlite, drizzleDb, migrationsFolder, databasePath } = options;
  const migrations = readMigrationFiles({ migrationsFolder });
  if (migrations.length === 0) throw new Error("No SQLite migrations are available.");

  const existingTables = listTables(sqlite);
  const hasExistingApplicationSchema = existingTables.length > 0;
  const applied = migrationHistory(sqlite);
  if (hasExistingApplicationSchema && applied.length === 0) {
    throw new Error(
      "Unclassified SQLite database: application tables exist without versioned migration history. Restore a verified backup and run a reviewed compatibility migration.",
    );
  }
  if (!hasExistingApplicationSchema && applied.length > 0) {
    throw new Error("Unclassified SQLite database: migration history exists without an application schema.");
  }

  const lastAppliedIndex = validateMigrationHistory(applied, migrations);
  if (hasExistingApplicationSchema) {
    const expected = expectedSnapshotAt(migrations, lastAppliedIndex);
    const drift = compareSnapshots(captureSchema(sqlite), expected, true);
    if (drift.length > 0) {
      throw new Error(`Unclassified SQLite schema drift:\n- ${drift.join("\n- ")}`);
    }
  }

  const pendingCount = migrations.length - (lastAppliedIndex + 1);
  const compatibilityPending = hasExistingApplicationSchema && baselineNeedsReconciliation(sqlite);
  const backupPath = hasExistingApplicationSchema && (pendingCount > 0 || compatibilityPending)
    ? await createVerifiedMigrationBackup(sqlite, databasePath)
    : null;

  try {
    migrate(drizzleDb, { migrationsFolder });
    reconcileBaseline(sqlite);
    const validation = validateDeclaredSqliteSchema(sqlite);
    if (!validation.ok) {
      throw new Error(`Declared SQLite schema mismatch:\n- ${validation.drift.join("\n- ")}`);
    }
    return {
      backupPath,
      migrationsApplied: pendingCount,
      schemaSignature: crypto.createHash("sha256").update(validation.signature).digest("hex"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recovery = backupPath ? ` Verified recovery backup: ${backupPath}.` : "";
    throw new Error(`SQLite migration failed: ${message}.${recovery}`);
  }
}
