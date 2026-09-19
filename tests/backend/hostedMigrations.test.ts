import { describe, expect, it } from 'vitest';
import { applyHostedMigrations, readHostedMigrations } from '../../server/persistence/hostedMigrations';

describe('hosted PostgreSQL migrations', () => {
  it('provides a PostgreSQL baseline for every core public-workspace domain', () => {
    const migrations = readHostedMigrations();
    expect(migrations).toHaveLength(9);

    const sql = migrations.map((migration) => migration.sql).join('\n');
    expect(migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum))).toBe(true);
    for (const table of [
      'users',
      'cases',
      'evidence',
      'document_analyses',
      'email_accounts',
      'outreach_status',
      'audit_logs',
      'storage_deletion_queue',
      'case_shares',
      'account_email_conflicts',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "${table}"`);
    }
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "outreach_status_case_lawyer_unique"');
    expect(migrations.at(-1)?.name).toBe('0009_retire_gap_scoring.sql');
    expect(migrations.at(-1)?.sql).toContain("'legacy-case-strength-v0'");
    expect(migrations.at(-1)?.sql).toContain("evidence-coverage-v1");
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

    await expect(applyHostedMigrations(database)).resolves.toEqual([
      '0001_laro_baseline.sql',
      '0002_case_shares.sql',
      '0003_account_email_identity.sql',
      '0004_password_reset_budget.sql',
      '0005_typed_clarifications.sql',
      '0006_atomic_outreach_initiation.sql',
      '0007_retire_lawyer_rating.sql',
      '0008_remove_dead_feature_flags.sql',
      '0009_retire_gap_scoring.sql',
    ]);
    expect(queries[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS laro_schema_migrations');
    expect(queries.some((query) => query.sql.includes('CREATE TABLE IF NOT EXISTS "users"'))).toBe(true);
    expect(queries.at(-1)).toMatchObject({
      sql: expect.stringContaining('INSERT INTO laro_schema_migrations'),
      values: ['0009_retire_gap_scoring.sql', expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
  });

  it('refuses a changed migration that shares an already-recorded filename', async () => {
    const queries: string[] = [];
    const database = {
      transaction: async <T>(work: (client: { query(sql: string): Promise<{ rows: Array<{ name: string; checksum: string }> }>; }) => Promise<T>) =>
        await work({
          query: async (sql) => {
            queries.push(sql);
            return sql.startsWith('SELECT')
              ? { rows: [{ name: '0001_laro_baseline.sql', checksum: '0'.repeat(64) }] }
              : { rows: [] };
          },
        }),
    };

    await expect(applyHostedMigrations(database)).rejects.toThrow('Hosted migration checksum mismatch');
    expect(queries.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS "users"'))).toBe(false);
  });
});
