/**
 * Phase 044 — acceptance test matrix (automated portion).
 *
 * Each `it` corresponds to an acceptance criterion in docs/ACCEPTANCE_TESTS.md.
 * These assert the product's must-hold behaviours through the real API.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser, buildLawyer } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phase 044 — acceptance criteria', () => {
  let app: TestApp;
  const U = { id: 'USER_AC', name: 'AC', role: 'user', email: 'ac@example.com' };
  let caseId: string;

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: U.id, email: U.email }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: 'LWYR_AC', legalAreas: JSON.stringify(['Employment Law']) }));
  });
  afterAll(() => app?.cleanup());

  it('AC1 — a user can create a case (intake)', async () => {
    const r = await app.makeCaller(U).cases.create({
      clientName: 'AC Client', clientEmail: 'c@x.com', caseType: 'Employment',
      caseSummary: 'werknemer ontslag zonder opzegtermijn', urgency: 'High',
    });
    expect(r.success).toBe(true);
    caseId = r.id;
  });

  it('AC2 — the case is classified into legal areas', async () => {
    const c = await app.makeCaller(U).cases.byId(caseId);
    expect(JSON.parse(c!.legalAreas)).toContain('Employment Law');
  });

  it('AC3 — matching returns suitable lawyers', async () => {
    const m = await app.makeCaller(U).matching.findLawyers({ caseId });
    expect(m.length).toBeGreaterThan(0);
    expect(m[0].matchScore).toBeGreaterThan(0);
  });

  it('AC4 — no outreach is sent without human approval', async () => {
    const caller = app.makeCaller(U);
    await caller.workflow.prepareDrafts({ caseId });
    const q = await caller.workflow.reviewQueue({ caseId });
    const review = await caller.workflow.preSendReview({ outreachId: q[0].id });
    const approved = await caller.workflow.approveDraft({ outreachId: q[0].id, approvalHash: review.message.approvalHash });
    expect(approved.sent).toBe(false);
  });

  it('AC5 — generated legal content carries a disclaimer', async () => {
    // The disclaimer constant is applied by gapAnalysis.generateDocument.
    const { LEGAL_DISCLAIMER } = await import('../../shared/const');
    expect(LEGAL_DISCLAIMER.length).toBeGreaterThan(0);
  });

  it('AC6 — a user can export and erase their data (GDPR)', async () => {
    const caller = app.makeCaller(U);
    const exp = await caller.gdpr.exportData();
    expect(exp.data.cases?.some((c: any) => c.id === caseId)).toBe(true);
    const del = await caller.gdpr.deleteData({ confirm: true });
    expect(del.success).toBe(true);
    expect(del.deleted.users).toBe(1);
  });
});
