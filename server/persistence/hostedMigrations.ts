import fs from 'fs';
import path from 'path';
import type { HostedDatabase, PostgresClient } from './hostedDatabase';

export type HostedMigration = {
  name: string;
  sql: string;
};

function migrationDirectory(): string {
  const candidates = [
    path.join(process.cwd(), 'deploy', 'postgres', 'migrations'),
    path.join(__dirname, '..', '..', 'deploy', 'postgres', 'migrations'),
  ];
  const directory = candidates.find((candidate) => fs.existsSync(candidate));
  if (!directory) {
    throw new Error('Hosted PostgreSQL migration directory is unavailable.');
  }
  return directory;
}

/**
 * Reads only reviewable, checked-in PostgreSQL migrations. A hosted launch
 * must never infer schema from a local SQLite file or execute generated SQL
 * that has not been committed with the release.
 */
export function readHostedMigrations(): HostedMigration[] {
  const directory = migrationDirectory();
  const migrations = fs.readdirSync(directory)
    .filter((name) => /^\d+_.+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((name) => ({ name, sql: fs.readFileSync(path.join(directory, name), 'utf8').trim() }));

  if (migrations.length === 0 || migrations.some((migration) => !migration.sql)) {
    throw new Error('Hosted PostgreSQL migrations are missing or empty.');
  }
  return migrations;
}

async function ensureMigrationLedger(client: PostgresClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS laro_schema_migrations (
      name text PRIMARY KEY NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Applies the hosted baseline in a transaction and records the exact filename
 * only after its SQL completes. Local SQLite migrations are never read or
 * modified at runtime by this runner.
 */
export async function applyHostedMigrations(database: Pick<HostedDatabase, 'transaction'>): Promise<string[]> {
  const migrations = readHostedMigrations();
  return await database.transaction(async (client) => {
    await ensureMigrationLedger(client);
    const applied = await client.query<{ name: string }>('SELECT name FROM laro_schema_migrations');
    const alreadyApplied = new Set(applied.rows.map((row) => row.name));
    const newlyApplied: string[] = [];

    for (const migration of migrations) {
      if (alreadyApplied.has(migration.name)) continue;
      await client.query(migration.sql);
      await client.query('INSERT INTO laro_schema_migrations (name) VALUES ($1)', [migration.name]);
      newlyApplied.push(migration.name);
    }
    return newlyApplied;
  });
}
