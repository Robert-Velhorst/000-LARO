import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";

type SqliteClient = {
  prepare: (sql: string) => any;
};

export interface Relationship {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  onDelete: string;
  onUpdate: string;
}

type ForeignKeyCheckRow = {
  table: string;
  rowid: number | null;
  parent: string;
  fkid: number;
};

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function normalizeAction(value: string | undefined): string {
  return (value ?? "NO ACTION").replaceAll("_", " ").toUpperCase();
}

export function relationshipKey(relationship: Relationship): string {
  return `${relationship.childTable}.${relationship.childColumn}->${relationship.parentTable}.${relationship.parentColumn}`;
}

function relationshipDefinitionKey(relationship: Relationship): string {
  return `${relationshipKey(relationship)}:${relationship.onDelete}:${relationship.onUpdate}`;
}

function listTables(sqlite: SqliteClient): string[] {
  return (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_") && !name.startsWith("__"));
}

function tableColumns(sqlite: SqliteClient, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

/** Canonical relationships come from the maintained Drizzle schema, not names. */
export function declaredRelationships(): Relationship[] {
  const relationships: Relationship[] = [];
  for (const exported of Object.values(schema)) {
    try {
      const config = getTableConfig(exported as never);
      if (!config?.name) continue;
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference();
        const parent = getTableConfig(reference.foreignTable as never);
        for (let index = 0; index < reference.columns.length; index += 1) {
          relationships.push({
            childTable: config.name,
            childColumn: reference.columns[index].name,
            parentTable: parent.name,
            parentColumn: reference.foreignColumns[index].name,
            onDelete: normalizeAction(foreignKey.onDelete),
            onUpdate: normalizeAction(foreignKey.onUpdate),
          });
        }
      }
    } catch {
      // schema.ts also exports inferred types and helpers; only tables reflect.
    }
  }
  return relationships.sort((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
}

/** Relationships whose tables and columns exist in the inspected database. */
export function requiredRelationships(sqlite: SqliteClient): Relationship[] {
  const tables = new Set(listTables(sqlite));
  const columns = new Map<string, Set<string>>();
  for (const table of tables) columns.set(table, new Set(tableColumns(sqlite, table)));
  return declaredRelationships().filter((relationship) => (
    tables.has(relationship.childTable)
    && tables.has(relationship.parentTable)
    && columns.get(relationship.childTable)?.has(relationship.childColumn)
    && columns.get(relationship.parentTable)?.has(relationship.parentColumn)
  ));
}

export function installedNativeRelationships(sqlite: SqliteClient): Relationship[] {
  const relationships: Relationship[] = [];
  for (const table of listTables(sqlite)) {
    const rows = sqlite.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`).all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
      on_update: string;
    }>;
    for (const row of rows) {
      relationships.push({
        childTable: table,
        childColumn: row.from,
        parentTable: row.table,
        parentColumn: row.to,
        onDelete: normalizeAction(row.on_delete),
        onUpdate: normalizeAction(row.on_update),
      });
    }
  }
  return relationships.sort((left, right) => relationshipKey(left).localeCompare(relationshipKey(right)));
}

export function missingNativeRelationships(sqlite: SqliteClient): Relationship[] {
  const installed = new Set(installedNativeRelationships(sqlite).map(relationshipDefinitionKey));
  return requiredRelationships(sqlite).filter(
    (relationship) => !installed.has(relationshipDefinitionKey(relationship)),
  );
}

export function relationshipIntegrityReport(sqlite: SqliteClient): {
  ok: boolean;
  expected: number;
  installed: number;
  missing: string[];
  violations: ForeignKeyCheckRow[];
} {
  const required = requiredRelationships(sqlite);
  const installed = new Set(installedNativeRelationships(sqlite).map(relationshipDefinitionKey));
  const missing = required
    .filter((relationship) => !installed.has(relationshipDefinitionKey(relationship)))
    .map((relationship) => `${relationshipKey(relationship)} ON DELETE ${relationship.onDelete}`);
  const violations = sqlite.prepare("PRAGMA foreign_key_check").all() as ForeignKeyCheckRow[];
  return {
    ok: missing.length === 0 && violations.length === 0,
    expected: required.length,
    installed: required.length - missing.length,
    missing,
    violations,
  };
}
