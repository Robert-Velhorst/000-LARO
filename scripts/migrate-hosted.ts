import { pathToFileURL } from 'url';
import { createHostedDatabase } from '../server/persistence/hostedDatabase';
import { applyHostedMigrations } from '../server/persistence/hostedMigrations';

export function assertHostedPostgresUrl(value: string | undefined): string {
  const databaseUrl = (value || '').trim();
  try {
    const parsed = new URL(databaseUrl);
    if ((parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:') && parsed.hostname) {
      return databaseUrl;
    }
  } catch {
    // The public error below deliberately does not echo a potentially sensitive URL.
  }
  throw new Error('DATABASE_URL must be a PostgreSQL URL before hosted migrations can run.');
}

export async function runHostedMigrations(databaseUrl = process.env.DATABASE_URL): Promise<string[]> {
  const database = createHostedDatabase({ connectionString: assertHostedPostgresUrl(databaseUrl) });
  try {
    return await applyHostedMigrations(database);
  } finally {
    await database.close();
  }
}

async function main(): Promise<void> {
  const applied = await runHostedMigrations();
  console.log(applied.length === 0
    ? 'Hosted PostgreSQL schema is already current.'
    : `Applied hosted PostgreSQL migrations: ${applied.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Hosted migration failed.');
    process.exitCode = 1;
  });
}
