import { describe, expect, it } from 'vitest';
import { applyHostedMigrations, readHostedMigrations } from '../../server/persistence/hostedMigrations';

describe('hosted PostgreSQL migrations', () => {
  it('provides a PostgreSQL baseline for every core public-workspace domain', () => {
    const migrations = readHostedMigrations();
    expect(migrations).toHaveLength(1);

    const sql = migrations[0].sql;
    for (const table of [
      'users',
      'cases',
      'evidence',
      'document_analyses',
      'email_accounts',
      'outreach_status',
      'audit_logs',
      'storage_deletion_queue',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
    expect(sql).not.toContain('`');
    expect(sql).not.toMatch(/\bPRAGMA\b/i);
  });

  it('records a baseline migration after applying it in one transaction', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const database = {
      transaction: async <T>(work: (client: { query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ name: string }> }>; }) => Promise<T>) =>
        await work({
          query: async (sql, values) => {
            queries.push({ sql, values });
            return { rows: [] };
          },
        }),
    };

    await expect(applyHostedMigrations(database)).resolves.toEqual(['0001_laro_baseline.sql']);
    expect(queries[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS laro_schema_migrations');
    expect(queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS "users"'))).toBe(true);
    expect(queries.at(-1)).toMatchObject({
      sql: expect.stringContaining('INSERT INTO laro_schema_migrations'),
      values: ['0001_laro_baseline.sql'],
    });
  });
});
