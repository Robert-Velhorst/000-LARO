import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { HostedDatabase, PostgresClient } from './hostedDatabase';

export type HostedMigration = {
  name: string;
  sql: string;
  checksum: string;
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
    .map((name) => {
      const sql = fs.readFileSync(path.join(directory, name), 'utf8').trim();
      return { name, sql, checksum: crypto.createHash('sha256').update(sql, 'utf8').digest('hex') };
    });

  if (migrations.length === 0 || migrations.some((migration) => !migration.sql)) {
    throw new Error('Hosted PostgreSQL migrations are missing or empty.');
  }
  return migrations;
}

async function ensureMigrationLedger(client: PostgresClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS laro_schema_migrations (
      name text PRIMARY KEY NOT NULL,
      checksum text,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.query('ALTER TABLE laro_schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
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
    const applied = await client.query<{ name: string; checksum: string | null }>('SELECT name, checksum FROM laro_schema_migrations');
    const alreadyApplied = new Map(applied.rows.map((row) => [row.name, row.checksum]));
    const newlyApplied: string[] = [];

    for (const migration of migrations) {
      const recordedChecksum = alreadyApplied.get(migration.name);
      if (recordedChecksum !== undefined) {
        if (recordedChecksum !== migration.checksum) {
          throw new Error(`Hosted migration checksum mismatch: ${migration.name}`);
        }
        continue;
      }
      await client.query(migration.sql);
      await client.query('INSERT INTO laro_schema_migrations (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
      newlyApplied.push(migration.name);
    }
    return newlyApplied;
  });
}
