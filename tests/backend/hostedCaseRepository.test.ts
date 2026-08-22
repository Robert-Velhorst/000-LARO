import { describe, expect, it } from 'vitest';
import { createHostedCaseRepository } from '../../server/persistence/hostedCaseRepository';

describe('hosted case repository', () => {
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
});
