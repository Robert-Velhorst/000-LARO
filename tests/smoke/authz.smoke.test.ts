import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildCase, buildUser } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('authorization through live tRPC procedures', () => {
  let app: TestApp;
  const owner = buildUser({ id: 'AUTHZ_OWNER', email: 'authz-owner@example.com' });
  const intruder = buildUser({ id: 'AUTHZ_INTRUDER', email: 'authz-intruder@example.com' });
  const caseRow = buildCase({ id: 'AUTHZ_CASE', userId: owner.id });

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([owner, intruder]);
    await app.db.insert(app.schema.cases).values(caseRow);
  });

  afterAll(() => app?.cleanup());

  it('rejects anonymous callers at the real protected-procedure boundary', async () => {
    const anonymous = app.makeCaller(null);
    await expect(anonymous.cases.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anonymous.evidenceFiles.byCase({ caseId: caseRow.id }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('allows the owner while keeping case existence private from another user', async () => {
    await expect(app.makeCaller(owner).cases.byId(caseRow.id))
      .resolves.toMatchObject({ id: caseRow.id, userId: owner.id });
    await expect(app.makeCaller(intruder).cases.byId(caseRow.id)).resolves.toBeNull();
  });

  it('blocks cross-owner reads, exports, analysis, and writes through their live routers', async () => {
    const caller = app.makeCaller(intruder);
    const forbidden = { code: 'FORBIDDEN' };

    await expect(caller.cases.export({ caseId: caseRow.id })).rejects.toMatchObject(forbidden);
    await expect(caller.outreach.byCaseId(caseRow.id)).rejects.toMatchObject(forbidden);
    await expect(caller.gapAnalysis.getGaps({ caseId: caseRow.id })).rejects.toMatchObject(forbidden);
    await expect(caller.evidenceFiles.create({
      caseId: caseRow.id,
      title: 'Cross-owner write',
      type: 'document',
      fileName: 'forbidden.txt',
      mimeType: 'text/plain',
    })).rejects.toMatchObject(forbidden);
  });
});
