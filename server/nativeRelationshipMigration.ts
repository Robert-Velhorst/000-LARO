import Database from "better-sqlite3";
import {
  installedNativeRelationships,
  missingNativeRelationships,
  relationshipIntegrityReport,
  relationshipKey,
  requiredRelationships,
  type Relationship,
} from "./relationshipIntegrity";

type SqliteClient = InstanceType<typeof Database>;

export type RelationshipOrphan = {
  relationship: string;
  rows: number;
};

export type NativeRelationshipMigrationResult = {
  relationships: number;
  tablesRebuilt: number;
};

const BASELINE_TABLE = "laro_relationship_baseline";
const BASELINE_VERSION = 1;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(sqlite: SqliteClient, table: string): boolean {
  return Boolean(sqlite.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function legacyRelationshipTriggers(sqlite: SqliteClient): string[] {
  return (sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'laro_ri_%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);
}

export function relationshipOrphanReport(sqlite: SqliteClient): RelationshipOrphan[] {
  const orphans: RelationshipOrphan[] = [];
  for (const relationship of requiredRelationships(sqlite)) {
    const row = sqlite.prepare(`
      SELECT count(*) AS count
      FROM ${quoteIdentifier(relationship.childTable)} child
      WHERE child.${quoteIdentifier(relationship.childColumn)} IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM ${quoteIdentifier(relationship.parentTable)} parent
          WHERE parent.${quoteIdentifier(relationship.parentColumn)} = child.${quoteIdentifier(relationship.childColumn)}
        )
    `).get() as { count: number };
    if (row.count > 0) orphans.push({ relationship: relationshipKey(relationship), rows: row.count });
  }
  return orphans;
}

export function assertNoRelationshipOrphans(sqlite: SqliteClient): void {
  const orphans = relationshipOrphanReport(sqlite);
  if (orphans.length === 0) return;
  const summary = orphans.map((orphan) => `${orphan.relationship} (${orphan.rows})`).join(", ");
  throw new Error(
    `Native relationship migration requires reviewed orphan reconciliation before upgrade: ${summary}`,
  );
}

export function assertNativeRelationshipReconciliationReady(sqlite: SqliteClient): void {
  assertNoRelationshipOrphans(sqlite);
  const installedByRelationship = new Set(
    installedNativeRelationships(sqlite).map((relationship) => relationshipKey(relationship)),
  );
  const policyMismatches = missingNativeRelationships(sqlite)
    .filter((relationship) => installedByRelationship.has(relationshipKey(relationship)));
  if (policyMismatches.length > 0) {
    throw new Error(
      `Native relationship policy drift requires an explicit migration: ${policyMismatches.map(relationshipKey).join(", ")}`,
    );
  }
}

export function nativeRelationshipsNeedReconciliation(sqlite: SqliteClient): boolean {
  if (!tableExists(sqlite, "users")) return false;
  if (missingNativeRelationships(sqlite).length > 0) return true;
  if (legacyRelationshipTriggers(sqlite).length > 0) return true;
  if (!tableExists(sqlite, BASELINE_TABLE)) return true;
  const marker = sqlite.prepare(
    `SELECT reconciledAt FROM ${BASELINE_TABLE} WHERE version = ?`,
  ).get(BASELINE_VERSION) as { reconciledAt: number | null } | undefined;
  return !marker?.reconciledAt;
}

function constraintSql(relationship: Relationship): string {
  const name = `laro_fk_${relationship.childTable}_${relationship.childColumn}_${relationship.parentTable}`;
  return `CONSTRAINT ${quoteIdentifier(name)} FOREIGN KEY (${quoteIdentifier(relationship.childColumn)}) `
    + `REFERENCES ${quoteIdentifier(relationship.parentTable)} (${quoteIdentifier(relationship.parentColumn)}) `
    + `ON UPDATE ${relationship.onUpdate} ON DELETE ${relationship.onDelete}`;
}

function rebuiltTableSql(
  originalSql: string,
  temporaryTable: string,
  relationships: Relationship[],
): string {
  const openingParenthesis = originalSql.indexOf("(");
  const closingParenthesis = originalSql.lastIndexOf(")");
  if (openingParenthesis < 0 || closingParenthesis <= openingParenthesis) {
    throw new Error("Could not parse the existing SQLite table definition.");
  }
  const body = originalSql.slice(openingParenthesis + 1, closingParenthesis).trimEnd();
  const suffix = originalSql.slice(closingParenthesis + 1);
  const constraints = relationships.map(constraintSql).join(",\n\t");
  return `CREATE TABLE ${quoteIdentifier(temporaryTable)} (${body},\n\t${constraints}\n)${suffix}`;
}

function tableArtifacts(sqlite: SqliteClient, table: string): string[] {
  return (sqlite.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE tbl_name = ?
      AND type IN ('index', 'trigger')
      AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'index' THEN 0 ELSE 1 END, name
  `).all(table) as Array<{ type: string; name: string; sql: string }>)
    .filter((row) => row.type !== "trigger" || !row.name.startsWith("laro_ri_"))
    .map((row) => row.sql);
}

function rebuildTableWithRelationships(
  sqlite: SqliteClient,
  table: string,
  relationships: Relationship[],
): void {
  const original = sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string | null } | undefined;
  if (!original?.sql) throw new Error(`Cannot rebuild ${table}: table definition is unavailable.`);
  const columns = (sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
    .map((column) => quoteIdentifier(column.name));
  if (columns.length === 0) throw new Error(`Cannot rebuild ${table}: no columns were found.`);
  const artifacts = tableArtifacts(sqlite, table);
  const temporaryTable = `__laro_native_${table}`;
  sqlite.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(temporaryTable)}`);
  sqlite.exec(rebuiltTableSql(original.sql, temporaryTable, relationships));
  const columnList = columns.join(", ");
  sqlite.exec(
    `INSERT INTO ${quoteIdentifier(temporaryTable)} (${columnList}) SELECT ${columnList} FROM ${quoteIdentifier(table)}`,
  );
  sqlite.exec(`DROP TABLE ${quoteIdentifier(table)}`);
  sqlite.exec(`ALTER TABLE ${quoteIdentifier(temporaryTable)} RENAME TO ${quoteIdentifier(table)}`);
  for (const sql of artifacts) sqlite.exec(sql);
}

export function reconcileNativeRelationships(sqlite: SqliteClient): NativeRelationshipMigrationResult {
  if (!tableExists(sqlite, BASELINE_TABLE)) {
    throw new Error("The native-relationship migration marker is missing.");
  }
  assertNativeRelationshipReconciliationReady(sqlite);

  const missing = missingNativeRelationships(sqlite);
  const byTable = new Map<string, Relationship[]>();
  for (const relationship of missing) {
    const relationships = byTable.get(relationship.childTable) ?? [];
    relationships.push(relationship);
    byTable.set(relationship.childTable, relationships);
  }

  const foreignKeysWereEnabled = Number(sqlite.pragma("foreign_keys", { simple: true })) === 1;
  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    for (const trigger of legacyRelationshipTriggers(sqlite)) {
      sqlite.exec(`DROP TRIGGER ${quoteIdentifier(trigger)}`);
    }
    for (const [table, relationships] of [...byTable.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      rebuildTableWithRelationships(sqlite, table, relationships);
    }

    const report = relationshipIntegrityReport(sqlite);
    if (!report.ok) {
      const failures = [
        ...report.missing,
        ...report.violations.map((violation) => `${violation.table} row ${violation.rowid ?? "unknown"}`),
      ];
      throw new Error(`Native relationship verification failed: ${failures.join(", ")}`);
    }
    sqlite.prepare(`
      UPDATE ${BASELINE_TABLE}
      SET relationshipCount = ?, tablesRebuilt = ?, reconciledAt = ?
      WHERE version = ? AND name = 'native-relationships-v1'
    `).run(report.expected, byTable.size, Date.now(), BASELINE_VERSION);
    sqlite.exec("COMMIT");
    return { relationships: report.expected, tablesRebuilt: byTable.size };
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.pragma(`foreign_keys = ${foreignKeysWereEnabled ? "ON" : "OFF"}`);
  }
}
