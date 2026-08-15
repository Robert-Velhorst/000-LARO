/**
 * Phase 046 — cross-user isolation tests.
 *
 * User B must never be able to read, mutate, export, or match on User A's case.
 * Exercised through the real API (createCaller) so the ownership guards and
 * protected procedures are actually invoked.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phase 046 — cross-user isolation', () => {
  let app: TestApp;
  const A = { id: 'USER_A', name: 'A', role: 'user', email: 'a@example.com' };
  const B = { id: 'USER_B', name: 'B', role: 'user', email: 'b@example.com' };
  let caseId: string;

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: A.id, email: A.email }));
    await app.db.insert(app.schema.users).values(buildUser({ id: B.id, email: B.email }));

    const res = await app.makeCaller(A).cases.create({
      clientName: 'A Client', clientEmail: 'ac@example.com',
      caseType: 'Employment', caseSummary: 'ontslag zaak', urgency: 'High',
    });
    caseId = res.id;
  });

  afterAll(() => app?.cleanup());

  it('B cannot read A\'s case by id (returns null)', async () => {
    const got = await app.makeCaller(B).cases.byId(caseId);
    expect(got).toBeNull();
  });

  it('B\'s case list does not include A\'s case', async () => {
    const list = await app.makeCaller(B).cases.list({});
    expect(list.cases.find((c: any) => c.id === caseId)).toBeUndefined();
  });

  it('B cannot delete A\'s case', async () => {
    await expect(app.makeCaller(B).cases.delete({ id: caseId })).rejects.toBeTruthy();
    // A's case still exists.
    const still = await app.makeCaller(A).cases.byId(caseId);
    expect(still?.id).toBe(caseId);
  });

  it('B cannot run matching or read outreach/gap data on A\'s case', async () => {
    await expect(app.makeCaller(B).matching.findLawyers({ caseId })).rejects.toBeTruthy();
    await expect(app.makeCaller(B).outreach.byCaseId(caseId)).rejects.toBeTruthy();
    await expect(app.makeCaller(B).gapAnalysis.getGaps({ caseId })).rejects.toBeTruthy();
    await expect(app.makeCaller(B).cases.progress({ caseId })).rejects.toBeTruthy();
  });

  it('B cannot disconnect Trello from A\'s case', async () => {
    await app.db.insert(app.schema.evidenceSources).values({
      id: 'VICTIM_TRELLO_SOURCE',
      caseId,
      userId: A.id,
      sourceType: 'Trello',
      sourceName: 'Victim board',
      status: 'connected',
    });

    await expect(app.makeCaller(B).trelloEnhanced.disconnect({ caseId })).rejects.toBeTruthy();

    const remaining = await app.db.select()
      .from(app.schema.evidenceSources)
      .where((await import('drizzle-orm')).eq(app.schema.evidenceSources.id, 'VICTIM_TRELLO_SOURCE'));
    expect(remaining).toHaveLength(1);
  });

  it('B cannot reach Trello through any route scoped to A\'s case', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const caller = app.makeCaller(B).trelloEnhanced;
    try {
      await expect(caller.listBoards({ caseId, token: 'attacker-token' })).rejects.toBeTruthy();
      await expect(caller.listLists({ caseId, boardId: 'board', token: 'attacker-token' })).rejects.toBeTruthy();
      await expect(caller.listCards({ caseId, boardId: 'board', listId: 'list', token: 'attacker-token' })).rejects.toBeTruthy();
      await expect(caller.syncBoards({ caseId, token: 'attacker-token' })).rejects.toBeTruthy();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('B cannot read, configure, or start evidence collection on A\'s case', async () => {
    const caller = app.makeCaller(B);
    await expect(caller.autoCollection.getSettings({ caseId })).rejects.toBeTruthy();
    await expect(caller.autoCollection.getLogs({ caseId, limit: 10 })).rejects.toBeTruthy();
    await expect(caller.autoCollection.getKeywordMatches({ caseId })).rejects.toBeTruthy();
    await expect(caller.autoCollection.getLocalFolders({ caseId })).rejects.toBeTruthy();
    await expect(caller.autoCollection.setLocalFolders({ caseId, paths: [] })).rejects.toBeTruthy();
    await expect(caller.autoCollection.runCollection({ caseId })).rejects.toBeTruthy();
    await expect(caller.autoCollection.startPullByKeywords({
      caseId,
      keywords: ['private'],
      matchMode: 'any',
    })).rejects.toBeTruthy();
  });

  it('keyword pull jobs are resumable for A and invisible to B', async () => {
    const started = await app.makeCaller(A).autoCollection.startPullByKeywords({
      caseId,
      keywords: ['no-provider-match'],
      matchMode: 'any',
    });
    expect(started.job.id).toBeTruthy();

    let job = await app.makeCaller(A).autoCollection.pullJobStatus({ jobId: started.job.id });
    for (let attempt = 0; attempt < 50 && (job?.status === 'queued' || job?.status === 'running'); attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      job = await app.makeCaller(A).autoCollection.pullJobStatus({ jobId: started.job.id });
    }

    expect(['completed', 'completed_with_errors']).toContain(job?.status);
    expect(job?.estimatedSecondsRemaining).toBe(0);
    expect(JSON.parse(job?.result || '{}')).toMatchObject({
      gmailMessages: 0,
      driveFiles: 0,
      localFiles: 0,
    });
    await expect(app.makeCaller(B).autoCollection.pullJobStatus({ jobId: started.job.id }))
      .resolves.toBeNull();
  });

  it('B\'s GDPR export does not contain A\'s case', async () => {
    const exp = await app.makeCaller(B).gdpr.exportData();
    const cases = exp.data?.cases ?? [];
    expect(cases.find((c: any) => c.id === caseId)).toBeUndefined();
  });
});
