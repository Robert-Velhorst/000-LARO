#!/usr/bin/env node
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SQLITE_MIGRATIONS = path.join(ROOT, 'drizzle');
const OUTPUT_DIRECTORY = path.join(ROOT, 'deploy', 'postgres', 'migrations');
const OUTPUT_FILE = path.join(OUTPUT_DIRECTORY, '0001_laro_baseline.sql');

function splitStatements(sql) {
  return sql.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
}

function applySqliteMigrations(database) {
  const files = fs.readdirSync(SQLITE_MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const file of files) {
    for (const statement of splitStatements(fs.readFileSync(path.join(SQLITE_MIGRATIONS, file), 'utf8'))) {
      database.exec(statement);
    }
  }
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function orderTables(tables) {
  const remaining = new Map(tables.map((table) => [table.name, table]));
  const result = [];
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((table) => table.foreignKeys.every((foreignKey) => !remaining.has(foreignKey.table)))
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    if (ready.length === 0) {
      throw new Error(`Unable to order hosted tables with foreign-key dependencies: ${[...remaining.keys()].join(', ')}`);
    }
    for (const table of ready) {
      remaining.delete(table.name);
      result.push(table);
    }
  }
  return result;
}

function postgresType(sqliteType) {
  if (/^integer$/i.test(sqliteType)) return 'bigint';
  if (/^text$/i.test(sqliteType)) return 'text';
  throw new Error(`Unsupported SQLite type in hosted baseline: ${sqliteType}`);
}

function postgresDefault(value) {
  if (value === null) return '';
  if (/^'?"?\d{4}-\d{2}-\d{2}T.*Z"?'?$/i.test(value)) {
    return ' DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint)';
  }
  if (/^true$/i.test(value)) return ' DEFAULT 1';
  if (/^false$/i.test(value)) return ' DEFAULT 0';
  return ` DEFAULT ${value}`;
}

function translateSqliteIndexToPostgres(sql) {
  return sql
    .replace(/^CREATE (UNIQUE )?INDEX /i, (_match, unique = '') => `CREATE ${unique}INDEX IF NOT EXISTS `)
    .replace(/`/g, '"');
}

function describeTable(database, name) {
  const escapedName = name.replaceAll('"', '""');
  return {
    name,
    columns: database.prepare(`PRAGMA table_info("${escapedName}")`).all(),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list("${escapedName}")`).all(),
  };
}

function translateSqliteTableToPostgres(table) {
  const definitions = table.columns.map((column) => {
    const notNull = column.notnull ? ' NOT NULL' : '';
    return `${quoteIdentifier(column.name)} ${postgresType(column.type)}${postgresDefault(column.dflt_value)}${notNull}`;
  });
  const primaryKey = table.columns.filter((column) => column.pk).sort((left, right) => left.pk - right.pk);
  if (primaryKey.length > 0) {
    definitions.push(`PRIMARY KEY (${primaryKey.map((column) => quoteIdentifier(column.name)).join(', ')})`);
  }
  for (const foreignKey of table.foreignKeys) {
    definitions.push(
      `FOREIGN KEY (${quoteIdentifier(foreignKey.from)}) REFERENCES ${quoteIdentifier(foreignKey.table)} (${quoteIdentifier(foreignKey.to)}) ON UPDATE ${foreignKey.on_update} ON DELETE ${foreignKey.on_delete}`
    );
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (\n  ${definitions.join(',\n  ')}\n)`;
}

function main() {
  const temporaryFile = path.join(os.tmpdir(), `laro-hosted-baseline-${process.pid}.sqlite`);
  const database = new Database(temporaryFile);
  try {
    applySqliteMigrations(database);
    const rows = database.prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE type IN ('table', 'index')
        AND name NOT LIKE 'sqlite_%'
        AND sql IS NOT NULL
      ORDER BY type, name
    `).all();
    const tables = orderTables(rows.filter((row) => row.type === 'table').map((row) => describeTable(database, row.name)));
    const indexes = rows.filter((row) => row.type === 'index').sort((left, right) => left.name.localeCompare(right.name, 'en'));
    const statements = [
      ...tables.map(translateSqliteTableToPostgres),
      ...indexes.map((row) => translateSqliteIndexToPostgres(row.sql)),
    ];
    fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
    fs.writeFileSync(
      OUTPUT_FILE,
      [
        '-- Generated from the final checked-in SQLite migration state.',
        '-- Review this baseline with every local schema evolution before hosted deployment.',
        ...statements.map((statement) => `${statement};`),
        '',
      ].join('\n'),
      'utf8'
    );
    console.log(`Wrote ${OUTPUT_FILE} with ${tables.length} tables and ${indexes.length} indexes.`);
  } finally {
    database.close();
    fs.rmSync(temporaryFile, { force: true });
  }
}

main();
