/**
 * Phases 071–080 — help/error-catalog endpoints + red-team fix verification.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser, buildLawyer } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phases 071–080', () => {
  let app: TestApp;
  const U = { id: 'USER_78', name: 'U78', role: 'user', email: 'u78@example.com' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: U.id, email: U.email }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: 'LWYR_78', legalAreas: JSON.stringify(['Employment Law']) }));
  });
  afterAll(() => app?.cleanup());

  it('Phase 071 — help topics are served, ordered by step', async () => {
    const topics = await app.makeCaller(null).help.topics();
    expect(topics.length).toBeGreaterThan(3);
    const steps = topics.filter((t: any) => t.step != null).map((t: any) => t.step);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(topics.find((t: any) => t.id === 'disclaimer')).toBeTruthy();
  });

  it('Phase 072 — error catalog maps codes to remedies', async () => {
    const cat = await app.makeCaller(null).help.errorCatalog();
    const forbidden = cat.find((e: any) => e.code === 'FORBIDDEN');
    expect(forbidden?.remedy).toBeTruthy();
    expect(cat.find((e: any) => e.code === 'TOO_MANY_REQUESTS')).toBeTruthy();
  });

  it('Phase 079 (red-team) — providerChecklist requires auth', async () => {
    await expect(app.makeCaller(null).system.providerChecklist()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const ok = await app.makeCaller(U).system.providerChecklist();
    expect(ok.total).toBeGreaterThan(0);
  });

  it('refuses GDPR erasure if the confirmed account differs from the current session', async () => {
    await expect(app.makeCaller(U).gdpr.deleteData({ confirm: true, expectedUserId: 'OTHER_ACCOUNT' }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await app.makeCaller(U).auth.me())?.id).toBe(U.id);
  });

  it('case deletion removes managed evidence objects before metadata', async () => {
    const caseUser = { id: 'USER_CASE_DELETE', name: 'Case delete', role: 'user', email: 'case-delete@example.com' };
    await app.db.insert(app.schema.users).values(buildUser({ id: caseUser.id, email: caseUser.email }));
    const caller = app.makeCaller(caseUser);
    const created = await caller.cases.create({
      clientName: 'Delete Case', clientEmail: 'delete@x.com', caseType: 'Employment',
      caseSummary: 'Delete case and its managed evidence', urgency: 'Medium',
    });
    const { storagePut, storageRead } = await import('../../server/storage');
    const blob = await storagePut(`evidence/${created.id}/manual/delete.txt`, 'delete with case', 'text/plain');
    await app.db.insert(app.schema.evidence).values({
      id: 'EV_CASE_DELETE', caseId: created.id, userId: caseUser.id, type: 'document', title: 'Delete me',
      metadata: JSON.stringify({ storageKey: blob.key }), fileUrl: blob.url,
    });

    await expect(storageRead(blob.key)).resolves.toBeInstanceOf(Buffer);
    await expect(caller.cases.delete({ id: created.id })).resolves.toMatchObject({ success: true });
    await expect(storageRead(blob.key)).rejects.toThrow('not found');
    await expect(caller.cases.byId(created.id)).resolves.toBeNull();
  });

  it('Phase 078 (red-team) — GDPR erasure removes caseId-scoped children too', async () => {
    const caller = app.makeCaller(U);
    // Create a case, prepare outreach drafts (caseId-scoped rows in outreach_status).
    const c = await caller.cases.create({
      clientName: 'Erase Me', clientEmail: 'e@x.com', caseType: 'Employment',
      caseSummary: 'werknemer ontslag', urgency: 'High',
    });
    const caseId = c.id;
    await caller.workflow.prepareDrafts({ caseId });

    const { storagePut, storageRead } = await import('../../server/storage');
    const canonicalBlob = await storagePut(`evidence/${caseId}/manual/canonical.txt`, 'canonical evidence', 'text/plain');
    const scannerBlob = await storagePut(`evidence/${caseId}/scanner/scanner.txt`, 'scanner evidence', 'text/plain');
    await app.db.insert(app.schema.evidence).values({
      id: 'EV_GDPR_78', caseId, userId: U.id, type: 'document', title: 'Erase blob',
      metadata: JSON.stringify({ storageKey: canonicalBlob.key }), fileUrl: canonicalBlob.url,
    });
    await app.db.insert(app.schema.evidenceFiles).values({
      id: 'EV_FILE_GDPR_78', caseId, userId: U.id, fileName: 'scanner.txt',
      storageKey: scannerBlob.key,
    });
    await expect(storageRead(canonicalBlob.key)).resolves.toBeInstanceOf(Buffer);
    await expect(storageRead(scannerBlob.key)).resolves.toBeInstanceOf(Buffer);

    // Precondition: outreach rows exist for this case.
    const before = await app.db.select().from(app.schema.outreachStatus).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.caseId, caseId)
    );
    expect(before.length).toBeGreaterThan(0);

    // Erase the account.
    const del = await caller.gdpr.deleteData({ confirm: true });
    expect(del.deleted.users).toBe(1);

    // The caseId-scoped outreach rows must be gone (no orphans left behind).
    const after = await app.db.select().from(app.schema.outreachStatus).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.caseId, caseId)
    );
    expect(after.length).toBe(0);
    await expect(storageRead(canonicalBlob.key)).rejects.toThrow('not found');
    await expect(storageRead(scannerBlob.key)).rejects.toThrow('not found');
  });
});
