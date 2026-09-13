import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestApp, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

describe('Workspace case search and pagination', () => {
  let app: TestApp;
  const owner = { id: 'UI_OWNER', name: 'UI owner', role: 'user', email: 'ui@example.invalid' };
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: 'OTHER_UI_OWNER', email: 'other-ui@example.invalid' }),
    ]);
    const insert = app.db.$client.prepare('INSERT INTO cases (id, userId, clientName, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const now = Date.now();
    for (let i = 0; i < 45; i++) {
      insert.run(`UI_${String(i).padStart(2, '0')}`, owner.id, `Matter ${i}`, i === 44 ? 'Tenancy' : 'Administrative', i === 44 ? 'Rarekeyword rental disagreement' : 'Routine matter', i === 44 ? 'High' : 'Low', i === 44 ? 'Intake' : 'Matching', i === 44 ? '["Huurrecht"]' : '["Administrative law"]', now - i * 1000, now);
    }
    insert.run('OTHER_UI_CASE', 'OTHER_UI_OWNER', 'Private other matter', 'Tenancy', 'Rarekeyword', 'High', 'Intake', '["Huurrecht"]', now, now);
  }, 60000);
  afterAll(async () => {
    (await import('../../server/db')).closeDatabaseForMaintenance();
    app?.cleanup();
  });

  it('finds cases outside the first page with accurate result totals', async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.cases.list({ limit: 20 });
    expect(first.pagination.total).toBe(45);
    expect(first.cases.map((row: any) => row.id)).not.toContain('UI_44');
    const found = await caller.cases.list({ search: 'rarekeyword', limit: 20 });
    expect(found.cases.map((row: any) => row.id)).toEqual(['UI_44']);
    expect(found.pagination.total).toBe(1);
    expect(found.pagination.totalPages).toBe(1);
  });
  it('matches case types as well as names and summaries', async () => {
    const found = await app.makeCaller(owner).cases.list({ search: 'Tenancy' });
    expect(found.cases.map((row: any) => row.id)).toEqual(['UI_44']);
  });
  it('combines status, urgency, legal area, and date before pagination', async () => {
    const found = await app.makeCaller(owner).cases.list({ statusGroup: 'open', urgency: 'High', legalArea: 'real-estate', createdWithin: 'week' });
    expect(found.cases.map((row: any) => row.id)).toEqual(['UI_44']);
    expect(found.pagination.total).toBe(1);
  });
  it('never admits another owner through expanded search ids', async () => {
    const found = await app.makeCaller(owner).cases.list({ search: 'no-keyword-match', matchingIds: ['UI_43', 'OTHER_UI_CASE'] });
    expect(found.cases.map((row: any) => row.id)).toEqual(['UI_43']);
    expect(found.pagination.total).toBe(1);
  });
  it('keeps stable pages when all update dates are equal', async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.cases.list({ sortBy: 'updatedAt', page: 1, limit: 20 });
    const second = await caller.cases.list({ sortBy: 'updatedAt', page: 2, limit: 20 });
    expect(new Set([...first.cases, ...second.cases].map((row: any) => row.id)).size).toBe(40);
  });
  it('keeps exact-status callers compatible and rejects fractional pages', async () => {
    const caller = app.makeCaller(owner);
    expect((await caller.cases.list({ status: 'Matching' })).pagination.total).toBe(44);
    await expect(caller.cases.list({ page: 1.5 })).rejects.toThrow();
  });
});
