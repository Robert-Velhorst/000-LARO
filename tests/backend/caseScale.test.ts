import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('10,000-case query scale', () => {
  let app: TestApp;
  let sqlite: any;
  const owner = { id: 'SCALE_OWNER', name: 'Scale Owner', role: 'user', email: 'scale@example.invalid' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: owner.id, email: owner.email }));
    sqlite = app.db.$client;
    const insert = sqlite.prepare(`
      INSERT INTO cases (
        id, userId, clientName, caseType, caseSummary, urgency, status, legalAreas, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const load = sqlite.transaction(() => {
      for (let index = 0; index < 10_000; index += 1) {
        insert.run(
          `SCALE_${index}`,
          owner.id,
          `Client ${String(index).padStart(5, '0')}`,
          'Administrative',
          'Scale verification case',
          index % 3 === 0 ? 'High' : index % 3 === 1 ? 'Medium' : 'Low',
          index % 2 === 0 ? 'Matching' : 'Review',
          '["Administrative Law"]',
          Date.now() - index * 1000,
          Date.now() - index * 500,
        );
      }
    });
    load();
    sqlite.exec('ANALYZE');
  }, 60_000);

  afterAll(async () => {
    const { closeDatabaseForMaintenance } = await import('../../server/db');
    closeDatabaseForMaintenance();
    app?.cleanup();
  });

  it('uses the owner-and-created index for the deepest supported page', async () => {
    const plan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM cases WHERE userId = ? ORDER BY createdAt DESC LIMIT 100 OFFSET 9900
    `).all(owner.id).map((row: any) => row.detail).join('\n');
    expect(plan).toContain('cases_userId_createdAt_idx');
    expect(plan).not.toContain('USE TEMP B-TREE');

    const started = performance.now();
    const result = await app.makeCaller(owner).cases.list({
      page: 100,
      limit: 100,
      sortBy: 'createdAt',
      sortDir: 'desc',
    });
    const durationMs = performance.now() - started;
    expect(result.cases).toHaveLength(100);
    expect(result.pagination.total).toBe(10_000);
    expect(durationMs).toBeLessThan(2_000);
  });

  it('uses composite indexes for filtered timeline views', () => {
    const statusPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM cases WHERE userId = ? AND status = ? ORDER BY createdAt DESC LIMIT 100
    `).all(owner.id, 'Matching').map((row: any) => row.detail).join('\n');
    expect(statusPlan).toContain('cases_userId_status_createdAt_idx');
    expect(statusPlan).not.toContain('USE TEMP B-TREE');

    const combinedPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM cases WHERE userId = ? AND status = ? AND urgency = ? ORDER BY createdAt DESC LIMIT 100
    `).all(owner.id, 'Matching', 'High').map((row: any) => row.detail).join('\n');
    expect(combinedPlan).toContain('cases_userId_status_urgency_createdAt_idx');
    expect(combinedPlan).not.toContain('USE TEMP B-TREE');
  });
});

