import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHostedDatabase } from '../../server/persistence/hostedDatabase';
import { createHostedCaseRepository, createHostedEvidenceRepository, createHostedUserRepository } from '../../server/persistence/hostedCaseRepository';
import { applyHostedMigrations } from '../../server/persistence/hostedMigrations';

const connectionString = process.env.LARO_HOSTED_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let database: ReturnType<typeof createHostedDatabase> | undefined;

suite('hosted PostgreSQL connection', () => {
  beforeEach(async () => {
    database ??= createHostedDatabase({ connectionString: connectionString! });
    await database.transaction(async (client) => {
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');
    });
  });

  afterAll(async () => {
    await database?.close();
  });

  it('connects to the configured PostgreSQL service and commits a transaction', async () => {
    database = createHostedDatabase({ connectionString: connectionString! });
    await expect(database.healthCheck()).resolves.toEqual({ healthy: true });
    await expect(database.transaction(async (client) => {
      const result = await client.query<{ value: number }>('SELECT 42 AS value');
      return result.rows[0]?.value;
    })).resolves.toBe(42);
  });

  it('applies the complete LARO baseline and exposes its core tables', async () => {
    database ??= createHostedDatabase({ connectionString: connectionString! });
    await expect(applyHostedMigrations(database)).resolves.toEqual(['0001_laro_baseline.sql']);
    await expect(applyHostedMigrations(database)).resolves.toEqual([]);
    const tables = await database.transaction(async (client) => {
      const result = await client.query<{ table_name: string }>(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('users', 'cases', 'evidence', 'document_analyses', 'outreach_status', 'storage_deletion_queue')
        ORDER BY table_name
      `);
      return result.rows.map((row) => row.table_name);
    });
    expect(tables).toEqual([
      'cases',
      'document_analyses',
      'evidence',
      'outreach_status',
      'storage_deletion_queue',
      'users',
    ]);

    await database.transaction(async (client) => {
      await client.query(`
        INSERT INTO "users" ("id", "email", "role", "createdAt", "lastSignedIn")
        VALUES ('owner-a', 'Owner@Example.test', 'user', 1, 1)
      `);
    });
    const userRepository = createHostedUserRepository({
      query: (sql, values) => database!.transaction((client) => client.query(sql, values)),
    });
    await expect(userRepository.findByEmail('owner@example.test')).resolves.toMatchObject({ id: 'owner-a' });

    const repository = createHostedCaseRepository({
      query: (sql, values) => database!.transaction((client) => client.query(sql, values)),
    });
    await repository.createCase({
      id: 'CASE-hosted-test', userId: 'owner-a', clientName: 'Hosted client', caseType: 'Housing',
      caseSummary: 'Owner-scoped PostgreSQL integration test', urgency: 'High', legalAreas: '["Housing"]',
    });
    await expect(repository.findOwnedCase('owner-a', 'CASE-hosted-test')).resolves.toMatchObject({ id: 'CASE-hosted-test' });
    await expect(repository.findOwnedCase('owner-b', 'CASE-hosted-test')).resolves.toBeNull();

    await database.transaction(async (client) => {
      await client.query(`
        INSERT INTO "evidence" ("id", "caseId", "userId", "type", "title", "relevant", "createdAt", "updatedAt")
        VALUES ('evidence-hosted-test', 'CASE-hosted-test', 'owner-a', 'document', 'Source letter', 1, 1, 1)
      `);
    });
    const evidenceRepository = createHostedEvidenceRepository({
      query: (sql, values) => database!.transaction((client) => client.query(sql, values)),
    });
    await expect(evidenceRepository.findOwnedEvidence('owner-a', 'CASE-hosted-test', 'evidence-hosted-test')).resolves.toMatchObject({ id: 'evidence-hosted-test' });
    await expect(evidenceRepository.findOwnedEvidence('owner-b', 'CASE-hosted-test', 'evidence-hosted-test')).resolves.toBeNull();
  });
});
