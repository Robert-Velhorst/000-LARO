/**
 * Phase 106 — multi-user teams. A teammate gains shared access to the owner's
 * cases; a stranger is still refused (isolation preserved).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser, buildCase } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phase 106 — teams / shared case access', () => {
  let app: TestApp;
  const OWNER = { id: 'OWNER_T', name: 'Owner', role: 'user', email: 'owner@example.com' };
  const MATE = { id: 'MATE_T', name: 'Mate', role: 'user', email: 'mate@example.com' };
  const STRANGER = { id: 'STRANGER_T', name: 'Str', role: 'user', email: 'stranger@example.com' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(OWNER), buildUser(MATE), buildUser(STRANGER)]);
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_TEAM', userId: OWNER.id }));
  });
  afterAll(() => app?.cleanup());

  it('a stranger cannot access the owner\'s case (isolation holds)', async () => {
    await expect(app.makeCaller(STRANGER).cases.export({ caseId: 'CASE_TEAM' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('owner adds a member by email; the member then has access', async () => {
    const res = await app.makeCaller(OWNER).teams.addMember({ email: MATE.email });
    expect(res.members).toContain(MATE.id);

    // Member can now read the owner's case.
    const exported = await app.makeCaller(MATE).cases.export({ caseId: 'CASE_TEAM' });
    expect(exported.format).toBe('laro-case-export/v1');

    // Shared access is consistent for mutations as well as reads.
    await app.makeCaller(MATE).cases.update({ id: 'CASE_TEAM', caseSummary: 'Updated by teammate' });
    const [updated] = await app.db.select().from(app.schema.cases);
    expect(updated.caseSummary).toBe('Updated by teammate');

    // The stranger is STILL blocked.
    await expect(app.makeCaller(STRANGER).cases.export({ caseId: 'CASE_TEAM' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(app.makeCaller(STRANGER).cases.update({ id: 'CASE_TEAM', caseSummary: 'Blocked' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });

    // listMembers reflects it.
    const members = await app.makeCaller(OWNER).teams.listMembers();
    expect(members.some((m: any) => m.id === MATE.id)).toBe(true);
  });

  it('removing the member revokes access', async () => {
    await app.makeCaller(OWNER).teams.removeMember({ userId: MATE.id });
    await expect(app.makeCaller(MATE).cases.export({ caseId: 'CASE_TEAM' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
