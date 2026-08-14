/**
 * Phases 051–060 — DB-backed behavioural tests (real temp DB).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser, buildLawyer, buildCase } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phases 051–060 — services', () => {
  let app: TestApp;
  const U = { id: 'USER_5X', name: '5X', role: 'user', email: 'x5@example.com' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: U.id, email: U.email }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: 'LWYR_5X', legalAreas: JSON.stringify(['Employment Law']) }));
  });
  afterAll(() => app?.cleanup());

  it('Phase 052 — pagination is complete and non-overlapping over a large set', async () => {
    const caller = app.makeCaller(U);
    // Insert 55 cases directly (bypass rate limit) for the pagination test.
    const rows = Array.from({ length: 55 }, (_, i) => ({
      id: `PGC${i}`, userId: U.id, clientName: `Client ${i}`, clientEmail: `c${i}@x.com`,
      caseType: 'Employment', caseSummary: 'ontslag', urgency: i % 2 ? 'High' : 'Low',
      status: 'Matching', legalAreas: JSON.stringify(['Employment Law']),
      createdAt: new Date(Date.now() - i * 1000), updatedAt: new Date(),
    }));
    await app.db.insert(app.schema.cases).values(rows as any);

    const seen = new Set<string>();
    let page = 1; let total = 0;
    for (;;) {
      const res = await caller.cases.list({ page, limit: 10, sortBy: 'createdAt', sortDir: 'desc' });
      total = res.pagination.total;
      for (const c of res.cases) {
        expect(seen.has(c.id)).toBe(false); // no overlap across pages
        seen.add(c.id);
      }
      if (page >= res.pagination.totalPages) break;
      page++;
    }
    expect(total).toBe(55);
    expect(seen.size).toBe(55);
  });

  it('Phase 022/051 — filters narrow the result set', async () => {
    const caller = app.makeCaller(U);
    const high = await caller.cases.list({ urgency: 'High', limit: 100 });
    expect(high.cases.every((c: any) => c.urgency === 'High')).toBe(true);
    const search = await caller.cases.list({ search: 'Client 3', limit: 100 });
    expect(search.cases.length).toBeGreaterThan(0);
  });

  it('ports lawyer directory filtering with accurate totals before pagination', async () => {
    await app.db.insert(app.schema.lawyers).values([
      buildLawyer({
        id: 'LWDIR1',
        name: 'Ada Directory',
        legalAreas: JSON.stringify(['Port Audit Employment']),
        experienceYears: '12',
        currentlyAccepting: 'Yes',
        officialProfileUrl: 'https://zoekeenadvocaat.advocatenorde.nl/advocaten/ada',
      }),
      buildLawyer({
        id: 'LWDIR2',
        name: 'Bram Directory',
        legalAreas: JSON.stringify(['Port Audit Employment']),
        experienceYears: '3',
        currentlyAccepting: 'Limited',
        officialProfileUrl: null,
      }),
      buildLawyer({
        id: 'LWDIR3',
        name: 'Cato Directory',
        legalAreas: JSON.stringify(['Port Audit Employment']),
        experienceYears: '25',
        currentlyAccepting: 'No',
        officialProfileUrl: 'https://zoekeenadvocaat.advocatenorde.nl/advocaten/cato',
      }),
      buildLawyer({
        id: 'LWDIR4',
        name: 'Percent % Specialist',
        legalAreas: 'Tax Law',
        experienceYears: 'unknown',
      }),
    ] as any);

    const caller = app.makeCaller(U);
    const first = await caller.lawyers.list({ legalArea: 'Port Audit Employment', page: 1, limit: 2 });
    const second = await caller.lawyers.list({ legalArea: 'Port Audit Employment', page: 2, limit: 2 });

    expect(first.pagination).toMatchObject({ total: 3, totalPages: 2, page: 1, limit: 2 });
    expect(first.officialRecordCount).toBe(2);
    expect(first.lawyers).toHaveLength(2);
    expect(second.lawyers).toHaveLength(1);
    expect(new Set([...first.lawyers, ...second.lawyers].map((lawyer: any) => lawyer.id)).size).toBe(3);

    const precise = await caller.lawyers.list({
      query: 'Ada',
      experience: '11-20',
      accepting: 'Yes',
      officialOnly: true,
    });
    expect(precise.pagination.total).toBe(1);
    expect(precise.lawyers[0]?.id).toBe('LWDIR1');

    const literalWildcard = await caller.lawyers.list({ query: '%' });
    expect(literalWildcard.pagination.total).toBe(1);
    expect(literalWildcard.lawyers[0]?.id).toBe('LWDIR4');

    const numericExperience = await caller.lawyers.list({ experience: '0-5' });
    expect(numericExperience.lawyers.some((lawyer: any) => lawyer.id === 'LWDIR4')).toBe(false);
  });

  it('keeps the lawyer directory behind authentication', async () => {
    const anonymous = app.makeCaller(null);
    await expect(anonymous.lawyers.list({ page: 1, limit: 10 })).rejects.toBeTruthy();
  });

  it('Phase 059 — cases.update rejects an illegal status transition', async () => {
    const caller = app.makeCaller(U);
    const created = await app.db.insert(app.schema.cases).values({
      id: 'SMCASE', userId: U.id, clientName: 'SM', clientEmail: 's@x.com', caseType: 'Employment',
      caseSummary: 'x', urgency: 'Low', status: 'Closed', legalAreas: '[]', createdAt: new Date(), updatedAt: new Date(),
    } as any);
    void created;
    // Closed is terminal — any transition must be rejected.
    await expect(caller.cases.update({ id: 'SMCASE', status: 'Matching' })).rejects.toBeTruthy();
  });

  it('Phase 058 — feature flags default correctly and can be toggled', async () => {
    const { getFlag, setFlag } = await import('../../server/featureFlags');
    expect(await getFlag('outreach.send.enabled')).toBe(false); // default OFF
    await setFlag('outreach.send.enabled', true);
    expect(await getFlag('outreach.send.enabled')).toBe(true);
    await setFlag('outreach.send.enabled', false);
  });

  it('Phase 055 — analytics are computed from real data (local-first)', async () => {
    const caller = app.makeCaller(U);
    const stats = await caller.analytics.getOverallStats();
    expect(stats.totalCases).toBeGreaterThan(0);
    const dist = await caller.analytics.getLegalAreaDistribution();
    expect(dist.find((d: any) => d.area === 'Employment Law')).toBeTruthy();

    await app.db.insert(app.schema.users).values(buildUser({ id: 'ANALYTICS_OTHER', email: 'analytics-other@example.com' }));
    await app.db.insert(app.schema.cases).values(buildCase({
      id: 'ANALYTICS_CASE_OTHER',
      userId: 'ANALYTICS_OTHER',
      clientName: 'Must remain private',
    }));
    await app.db.insert(app.schema.outreachStatus).values([
      {
        id: 'ANALYTICS_OUTREACH_OWN', caseId: 'PGC0', lawyerId: 'LWYR_5X', status: 'Interested',
        responseReceived: 'Yes', responseTimeHours: '3.5', initialContact: new Date('2026-08-10T10:00:00Z'),
        createdAt: new Date('2026-08-10T10:00:00Z'), updatedAt: new Date('2026-08-10T13:30:00Z'),
      },
      {
        id: 'ANALYTICS_OUTREACH_OTHER', caseId: 'ANALYTICS_CASE_OTHER', lawyerId: 'LWYR_5X', status: 'Declined',
        responseReceived: 'Yes', responseTimeHours: '9', initialContact: new Date('2026-08-11T10:00:00Z'),
        createdAt: new Date('2026-08-11T10:00:00Z'), updatedAt: new Date('2026-08-11T19:00:00Z'),
      },
    ] as any);

    expect(await caller.analytics.getOutreachTrends()).toEqual([{ date: '2026-08-10', count: 1 }]);
    const performance = await caller.analytics.getLawyerPerformance();
    expect(performance).toHaveLength(1);
    expect(performance[0]).toMatchObject({ sent: 1, responses: 1, accepted: 1, averageResponseTimeHours: 3.5 });
    expect(await caller.analytics.getLawyerCapacity()).toHaveLength(1);
    const workload = await caller.analytics.getWorkloadMetrics();
    expect(workload.some((row: any) => row.caseId === 'ANALYTICS_CASE_OTHER')).toBe(false);
  });

  it('Phase 054 — database guards reject new orphans and reconciliation stays clean', async () => {
    const { reconcileReport } = await import('../../server/reconcile');
    await expect(app.db.insert(app.schema.outreachStatus).values({
      id: 'ORPHAN1', caseId: 'NONEXISTENT_CASE', lawyerId: 'LWYR_5X', status: 'PendingApproval',
      createdAt: new Date(), updatedAt: new Date(),
    } as any)).rejects.toThrow(/relationship violation: outreach_status\.caseId/);
    const report = await reconcileReport();
    expect(report.orphanedByCaseId['outreach_status'] ?? 0).toBe(0);
  });

  it('Phase 053 — backup produces a valid restorable SQLite file', async () => {
    const { backupDatabase, validateBackup } = await import('../../server/backup');
    const dest = join(app.tmpDir, 'backup.sqlite');
    const res = await backupDatabase(dest);
    expect(existsSync(res.path)).toBe(true);
    expect(res.bytes).toBeGreaterThan(0);
    const check = validateBackup(dest);
    expect(check.valid).toBe(true);
    expect(check.tables).toContain('cases');

    const corrupt = join(app.tmpDir, 'corrupt.sqlite');
    writeFileSync(corrupt, 'not a sqlite database');
    expect(validateBackup(corrupt).valid).toBe(false);
  });

  it('Phase 056 — billing status reports local unmetered operation', async () => {
    const caller = app.makeCaller(U);
    const b = await caller.billing.status();
    expect(b.plan).toBe('local');
    expect(b.billingConfigured).toBe(false);
    expect(b.forcedBilling).toBe(false);
  });
});
