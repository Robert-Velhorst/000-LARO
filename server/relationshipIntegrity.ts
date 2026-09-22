type SqliteClient = {
  prepare: (sql: string) => any;
  exec: (sql: string) => void;
};

export interface Relationship {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
}

const SPECIAL_RELATIONSHIPS: Relationship[] = [
  { childTable: "email_sync_jobs", childColumn: "accountId", parentTable: "email_accounts", parentColumn: "id" },
  { childTable: "email_messages", childColumn: "accountId", parentTable: "email_accounts", parentColumn: "id" },
  { childTable: "google_drive_files", childColumn: "accountId", parentTable: "email_accounts", parentColumn: "id" },
  { childTable: "email_activity", childColumn: "lawyerId", parentTable: "lawyers", parentColumn: "id" },
  { childTable: "outreach_status", childColumn: "lawyerId", parentTable: "lawyers", parentColumn: "id" },
  { childTable: "auto_collection_logs", childColumn: "settingsId", parentTable: "auto_collection_settings", parentColumn: "id" },
  { childTable: "evidence_file_tags", childColumn: "evidenceFileId", parentTable: "evidence_files", parentColumn: "id" },
  { childTable: "evidence_file_tags", childColumn: "tagId", parentTable: "evidence_tags", parentColumn: "id" },
  { childTable: "unified_messages", childColumn: "threadId", parentTable: "conversation_threads", parentColumn: "id" },
];

// Audit rows identify an actor but are not user-owned child records. Keeping
// that identifier after account removal is necessary for an honest audit trail.
const USER_RELATIONSHIP_EXCLUSIONS = new Set(["audit_logs"]);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function triggerStem(relationship: Relationship): string {
  return `laro_ri_${relationship.childTable}_${relationship.childColumn}`.replace(/[^a-zA-Z0-9_]/g, "_");
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

export function requiredRelationships(sqlite: SqliteClient): Relationship[] {
  const tables = new Set(listTables(sqlite));
  const columns = new Map<string, Set<string>>();
  for (const table of tables) columns.set(table, new Set(tableColumns(sqlite, table)));

  const relationships: Relationship[] = [];
  for (const table of tables) {
    if (table !== "cases" && columns.get(table)?.has("caseId")) {
      relationships.push({ childTable: table, childColumn: "caseId", parentTable: "cases", parentColumn: "id" });
    }
    if (
      table !== "users" &&
      !USER_RELATIONSHIP_EXCLUSIONS.has(table) &&
      columns.get(table)?.has("userId")
    ) {
      relationships.push({ childTable: table, childColumn: "userId", parentTable: "users", parentColumn: "id" });
    }
  }

  for (const relationship of SPECIAL_RELATIONSHIPS) {
    if (
      tables.has(relationship.childTable) &&
      tables.has(relationship.parentTable) &&
      columns.get(relationship.childTable)?.has(relationship.childColumn) &&
      columns.get(relationship.parentTable)?.has(relationship.parentColumn)
    ) {
      relationships.push(relationship);
    }
  }

  return relationships.sort((a, b) =>
    `${a.childTable}.${a.childColumn}`.localeCompare(`${b.childTable}.${b.childColumn}`),
  );
}

export function requiredRelationshipTriggerNames(sqlite: SqliteClient): string[] {
  return requiredRelationships(sqlite).flatMap((relationship) => {
    const stem = triggerStem(relationship);
    return [`${stem}_insert`, `${stem}_update`, `${stem}_delete`];
  });
}

export function ensureRelationshipIntegrityTriggers(sqlite: SqliteClient): number {
  const relationships = requiredRelationships(sqlite);
  const requiredNames = new Set(requiredRelationshipTriggerNames(sqlite));
  const installed = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'laro_ri_%'",
  ).all() as Array<{ name: string }>;
  // Older migrations may retire a table while leaving a generated caseId or
  // userId delete trigger on its former parent. Such a trigger compiles but
  // fails at runtime when the parent is deleted (for example, GDPR erasure).
  for (const { name } of installed) {
    if (!requiredNames.has(name)) sqlite.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
  }
  for (const relationship of relationships) {
    const childTable = quoteIdentifier(relationship.childTable);
    const childColumn = quoteIdentifier(relationship.childColumn);
    const parentTable = quoteIdentifier(relationship.parentTable);
    const parentColumn = quoteIdentifier(relationship.parentColumn);
    const stem = triggerStem(relationship);
    const message = `relationship violation: ${relationship.childTable}.${relationship.childColumn}`.replaceAll("'", "''");

    sqlite.exec(`
      CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${stem}_insert`)}
      BEFORE INSERT ON ${childTable}
      WHEN NEW.${childColumn} IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ${parentTable} parent WHERE parent.${parentColumn} = NEW.${childColumn}
       )
      BEGIN
        SELECT RAISE(ABORT, '${message}');
      END;

      CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${stem}_update`)}
      BEFORE UPDATE OF ${childColumn} ON ${childTable}
      WHEN NEW.${childColumn} IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ${parentTable} parent WHERE parent.${parentColumn} = NEW.${childColumn}
       )
      BEGIN
        SELECT RAISE(ABORT, '${message}');
      END;

      CREATE TRIGGER IF NOT EXISTS ${quoteIdentifier(`${stem}_delete`)}
      BEFORE DELETE ON ${parentTable}
      BEGIN
        DELETE FROM ${childTable} WHERE ${childColumn} = OLD.${parentColumn};
      END;
    `);
  }
  return relationships.length * 3;
}

export function relationshipIntegrityReport(sqlite: SqliteClient): {
  ok: boolean;
  expected: number;
  installed: number;
  missing: string[];
} {
  const required = requiredRelationshipTriggerNames(sqlite);
  const installedRows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'laro_ri_%'")
    .all() as Array<{ name: string }>;
  const installedNames = new Set(installedRows.map((row) => row.name));
  const missing = required.filter((name) => !installedNames.has(name));
  return {
    ok: missing.length === 0,
    expected: required.length,
    installed: required.length - missing.length,
    missing,
  };
}
