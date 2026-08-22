import { describe, expect, it } from 'vitest';
import { createHostedCaseRepository, createHostedEvidenceRepository, createHostedUserRepository } from '../../server/persistence/hostedCaseRepository';

describe('hosted case repository', () => {
  it('finds an account by email through a parameterized exact match', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const repository = createHostedUserRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        return { rows: [{ id: 'user-a', email: 'person@example.test', role: 'user' }] };
      },
    });

    await expect(repository.findByEmail('person@example.test')).resolves.toMatchObject({ id: 'user-a' });
    expect(queries[0]).toMatchObject({
      sql: expect.stringContaining('WHERE lower("email") = lower($1)'),
      values: ['person@example.test'],
    });
  });

  it('reads a case only through its owning account scope', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const repository = createHostedCaseRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        return { rows: [{ id: 'CASE-1', userId: 'user-a', clientName: 'Client' }] };
      },
    });

    await expect(repository.findOwnedCase('user-a', 'CASE-1')).resolves.toMatchObject({ id: 'CASE-1' });
    expect(queries).toEqual([expect.objectContaining({
      sql: expect.stringContaining('WHERE "id" = $1 AND "userId" = $2'),
      values: ['CASE-1', 'user-a'],
    })]);
  });

  it('writes a case with explicit owner and parameterized values', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const repository = createHostedCaseRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        return { rows: [{ id: 'CASE-2' }] };
      },
    });

    await expect(repository.createCase({
      id: 'CASE-2', userId: 'user-a', clientName: 'Client', caseType: 'Housing', caseSummary: 'Summary', urgency: 'High', legalAreas: '["Housing"]',
    })).resolves.toMatchObject({ id: 'CASE-2' });
    expect(queries[0]).toMatchObject({
      sql: expect.stringContaining('INSERT INTO "cases"'),
      values: expect.arrayContaining(['CASE-2', 'user-a', 'Client', 'Housing', 'Summary', 'High']),
    });
  });

  it('reads evidence only through both its owner and case scope', async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const repository = createHostedEvidenceRepository({
      query: async (sql, values) => {
        queries.push({ sql, values });
        return { rows: [{ id: 'evidence-1', caseId: 'CASE-1', userId: 'user-a', title: 'Letter' }] };
      },
    });

    await expect(repository.findOwnedEvidence('user-a', 'CASE-1', 'evidence-1')).resolves.toMatchObject({ id: 'evidence-1' });
    expect(queries[0]).toMatchObject({
      sql: expect.stringContaining('WHERE "id" = $1 AND "caseId" = $2 AND "userId" = $3'),
      values: ['evidence-1', 'CASE-1', 'user-a'],
    });
  });
});
