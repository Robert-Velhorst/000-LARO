import Database from "better-sqlite3";
import {
  numericColumnKey,
  numericColumnPolicies,
  type NumericColumnPolicy,
} from "./numericColumns";

type SqliteClient = InstanceType<typeof Database>;

export type NumericFieldIssue = {
  field: string;
  invalidValues: number;
};

export type NumericNormalizationResult = {
  columns: number;
  tablesRebuilt: number;
};

const BASELINE_TABLE = "laro_numeric_baseline";
const BASELINE_VERSION = 1;
const NUMERIC_PATTERN = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function tableExists(sqlite: SqliteClient, table: string): boolean {
  return Boolean(sqlite.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

function tableColumns(sqlite: SqliteClient, table: string): Map<string, string> {
  return new Map((sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
    name: string;
    type: string;
  }>).map((column) => [column.name, column.type.trim().toLowerCase()]));
}

function availablePolicies(sqlite: SqliteClient): NumericColumnPolicy[] {
  const byTable = new Map<string, Map<string, string>>();
  return numericColumnPolicies.filter((policy) => {
    if (!byTable.has(policy.table)) byTable.set(policy.table, tableColumns(sqlite, policy.table));
    return byTable.get(policy.table)?.has(policy.column);
  });
}

export function parseLegacyNumericValue(
  policy: NumericColumnPolicy,
  value: unknown,
): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const source = typeof value === "number" ? String(value) : value.trim();
  if (source === "") return null;
  if (!NUMERIC_PATTERN.test(source)) return undefined;
  const parsed = Number(source);
  if (!Number.isFinite(parsed)) return undefined;
  if (policy.storage === "integer" && !Number.isSafeInteger(parsed)) return undefined;
  if (parsed < policy.minimum || parsed > policy.maximum) return undefined;
  return parsed;
}

export function legacyNumericIssueReport(sqlite: SqliteClient): NumericFieldIssue[] {
  const issues: NumericFieldIssue[] = [];
  const policies = availablePolicies(sqlite);
  const byTable = new Map<string, NumericColumnPolicy[]>();
  for (const policy of policies) {
    const entries = byTable.get(policy.table) ?? [];
    entries.push(policy);
    byTable.set(policy.table, entries);
  }

  for (const [table, tablePolicies] of byTable) {
    const columns = tablePolicies.map((policy) => quoteIdentifier(policy.column)).join(", ");
    const counts = new Map(tablePolicies.map((policy) => [policy.column, 0]));
    for (const row of sqlite.prepare(`SELECT ${columns} FROM ${quoteIdentifier(table)}`).iterate() as Iterable<Record<string, unknown>>) {
      for (const policy of tablePolicies) {
        if (parseLegacyNumericValue(policy, row[policy.column]) === undefined) {
          counts.set(policy.column, (counts.get(policy.column) ?? 0) + 1);
        }
      }
    }
    for (const policy of tablePolicies) {
      const invalidValues = counts.get(policy.column) ?? 0;
      if (invalidValues > 0) issues.push({ field: numericColumnKey(policy), invalidValues });
    }
  }
  return issues;
}

export function assertNumericNormalizationReady(sqlite: SqliteClient): void {
  const issues = legacyNumericIssueReport(sqlite);
  if (issues.length === 0) return;
  throw new Error(
    `Numeric normalization requires reviewed legacy-value repair before upgrade: ${issues
      .map((issue) => `${issue.field} (${issue.invalidValues})`).join(", ")}`,
  );
}

export function numericNormalizationIsReconciled(sqlite: SqliteClient): boolean {
  if (!tableExists(sqlite, BASELINE_TABLE)) return false;
  const marker = sqlite.prepare(
    `SELECT reconciledAt FROM ${BASELINE_TABLE} WHERE version = ? AND name = 'numeric-normalization-v1'`,
  ).get(BASELINE_VERSION) as { reconciledAt: number | null } | undefined;
  return Boolean(marker?.reconciledAt);
}

export function numericNormalizationNeedsReconciliation(sqlite: SqliteClient): boolean {
  if (!tableExists(sqlite, "users")) return false;
  if (!numericNormalizationIsReconciled(sqlite)) return true;
  const byTable = new Map<string, Map<string, string>>();
  for (const policy of numericColumnPolicies) {
    if (!byTable.has(policy.table)) byTable.set(policy.table, tableColumns(sqlite, policy.table));
    if (byTable.get(policy.table)?.get(policy.column) !== policy.storage) return true;
  }
  return false;
}

function escapedPattern(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function constraintName(policy: NumericColumnPolicy): string {
  return `laro_numeric_${policy.table}_${policy.column}`;
}

function constraintSql(policy: NumericColumnPolicy): string {
  const column = quoteIdentifier(policy.column);
  const allowedTypes = policy.storage === "integer"
    ? `typeof(${column}) = 'integer'`
    : `typeof(${column}) IN ('integer', 'real')`;
  return `CONSTRAINT ${quoteIdentifier(constraintName(policy))} CHECK (`
    + `${column} IS NULL OR (${allowedTypes} AND ${column} >= ${policy.minimum} AND ${column} <= ${policy.maximum}))`;
}

function rebuiltTableSql(
  originalSql: string,
  temporaryTable: string,
  policies: NumericColumnPolicy[],
): string {
  const openingParenthesis = originalSql.indexOf("(");
  const closingParenthesis = originalSql.lastIndexOf(")");
  if (openingParenthesis < 0 || closingParenthesis <= openingParenthesis) {
    throw new Error("Could not parse the existing SQLite table definition.");
  }
  let body = originalSql.slice(openingParenthesis + 1, closingParenthesis).trimEnd();
  for (const policy of policies) {
    const column = escapedPattern(policy.column);
    const pattern = new RegExp(`((?:\`${column}\`|"${column}"|\\[${column}\\]|\\b${column}\\b)\\s+)(?:text|integer|real|numeric|blob)\\b`, "i");
    if (!pattern.test(body)) {
      throw new Error(`Cannot normalize ${numericColumnKey(policy)}: its column definition is unavailable.`);
    }
    body = body.replace(pattern, `$1${policy.storage}`);
  }
  const constraints = policies
    .filter((policy) => !body.includes(constraintName(policy)))
    .map(constraintSql);
  if (constraints.length > 0) body = `${body},\n\t${constraints.join(",\n\t")}`;
  const suffix = originalSql.slice(closingParenthesis + 1);
  return `CREATE TABLE ${quoteIdentifier(temporaryTable)} (${body}\n)${suffix}`;
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

function conversionExpression(column: string, policy: NumericColumnPolicy | undefined): string {
  const quoted = quoteIdentifier(column);
  if (!policy) return quoted;
  const castType = policy.storage === "integer" ? "NUMERIC" : "REAL";
  return `CASE WHEN ${quoted} IS NULL OR trim(CAST(${quoted} AS TEXT)) = '' THEN NULL `
    + `ELSE CAST(trim(CAST(${quoted} AS TEXT)) AS ${castType}) END`;
}

function rebuildTable(
  sqlite: SqliteClient,
  table: string,
  policies: NumericColumnPolicy[],
): void {
  const original = sqlite.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { sql: string | null } | undefined;
  if (!original?.sql) throw new Error(`Cannot normalize ${table}: table definition is unavailable.`);
  const columns = (sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>);
  if (columns.length === 0) throw new Error(`Cannot normalize ${table}: no columns were found.`);
  const policyByColumn = new Map(policies.map((policy) => [policy.column, policy]));
  const artifacts = tableArtifacts(sqlite, table);
  const temporaryTable = `__laro_numeric_${table}`;
  sqlite.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(temporaryTable)}`);
  sqlite.exec(rebuiltTableSql(original.sql, temporaryTable, policies));
  const columnList = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const selections = columns
    .map((column) => conversionExpression(column.name, policyByColumn.get(column.name)))
    .join(", ");
  sqlite.exec(
    `INSERT INTO ${quoteIdentifier(temporaryTable)} (${columnList}) SELECT ${selections} FROM ${quoteIdentifier(table)}`,
  );
  sqlite.exec(`DROP TABLE ${quoteIdentifier(table)}`);
  sqlite.exec(`ALTER TABLE ${quoteIdentifier(temporaryTable)} RENAME TO ${quoteIdentifier(table)}`);
  for (const sql of artifacts) sqlite.exec(sql);
}

function assertNormalizedStorage(sqlite: SqliteClient): void {
  for (const policy of numericColumnPolicies) {
    const actual = tableColumns(sqlite, policy.table).get(policy.column);
    if (actual !== policy.storage) {
      throw new Error(`Numeric storage verification failed for ${numericColumnKey(policy)}: expected ${policy.storage}.`);
    }
  }
  const issues = legacyNumericIssueReport(sqlite);
  if (issues.length > 0) {
    throw new Error(`Numeric value verification failed: ${issues.map((issue) => issue.field).join(", ")}`);
  }
}

export function reconcileNumericColumns(sqlite: SqliteClient): NumericNormalizationResult {
  if (!tableExists(sqlite, BASELINE_TABLE)) {
    throw new Error("The numeric-normalization migration marker is missing.");
  }
  assertNumericNormalizationReady(sqlite);
  const byTable = new Map<string, NumericColumnPolicy[]>();
  for (const policy of numericColumnPolicies) {
    const entries = byTable.get(policy.table) ?? [];
    entries.push(policy);
    byTable.set(policy.table, entries);
  }

  const foreignKeysWereEnabled = Number(sqlite.pragma("foreign_keys", { simple: true })) === 1;
  sqlite.pragma("foreign_keys = OFF");
  try {
    sqlite.exec("BEGIN IMMEDIATE");
    for (const [table, policies] of [...byTable.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      rebuildTable(sqlite, table, policies);
    }
    assertNormalizedStorage(sqlite);
    const foreignKeyViolations = sqlite.pragma("foreign_key_check") as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(`Numeric normalization created ${foreignKeyViolations.length} foreign-key violation(s).`);
    }
    sqlite.prepare(`
      UPDATE ${BASELINE_TABLE}
      SET columnCount = ?, tablesRebuilt = ?, reconciledAt = ?
      WHERE version = ? AND name = 'numeric-normalization-v1'
    `).run(numericColumnPolicies.length, byTable.size, Date.now(), BASELINE_VERSION);
    sqlite.exec("COMMIT");
    return { columns: numericColumnPolicies.length, tablesRebuilt: byTable.size };
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    throw error;
  } finally {
    sqlite.pragma(`foreign_keys = ${foreignKeysWereEnabled ? "ON" : "OFF"}`);
  }
}
