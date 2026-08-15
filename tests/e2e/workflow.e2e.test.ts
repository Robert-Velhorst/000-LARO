/**
 * Phase 043 — end-to-end workflow test.
 *
 * Drives the REAL tRPC API (appRouter.createCaller) against a real temp DB
 * through the critical path:
 *   signup -> create case (auto-classified) -> matching -> prepare outreach
 *   drafts -> review queue -> approve (no send) -> verify state.
 *
 * This is a true e2e test of the wired product, not a unit stub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildLawyer } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phase 043 — critical-path e2e', () => {
  let app: TestApp;
  let userId: string;

  beforeAll(async () => {
    app = await bootTestApp();
    // Seed a lawyer that will match an employment case.
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: 'LWYR_E2E', legalAreas: JSON.stringify(['Employment Law']) }));
  });

  afterAll(() => app?.cleanup());

  it('signs up a user and establishes identity', async () => {
    const anon = app.makeCaller(null);
    const res = await anon.auth.signup({ email: 'e2e@example.com', password: 'supersecret1', name: 'E2E User' });
    expect(res.success).toBe(true);

    // Find the created user id (signup does not return it).
    const rows = await app.db.select().from(app.schema.users);
    const u = rows.find((r: any) => r.email === 'e2e@example.com');
    expect(u).toBeTruthy();
    userId = u.id;
  });

  it('creates a case that is auto-classified', async () => {
    const caller = app.makeCaller({ id: userId, name: 'E2E', role: 'user', email: 'e2e@example.com' });
    const res = await caller.cases.create({
      clientName: 'Client One',
      clientEmail: 'client@example.com',
      caseType: 'Employment',
      caseSummary: 'werknemer ontslag zonder opzegtermijn door werkgever',
      urgency: 'High',
    });
    expect(res.success).toBe(true);
    expect(res.legalAreas).toContain('Employment Law');
  });

  it('matches lawyers, prepares drafts, and approves via the review gate (no send)', async () => {
    const caller = app.makeCaller({ id: userId, name: 'E2E', role: 'user', email: 'e2e@example.com' });
    const list = await caller.cases.list({});
    const caseId = list.cases[0].id;

    // Real matching returns the seeded lawyer.
    const matches = await caller.matching.findLawyers({ caseId });
    expect(matches.length).toBeGreaterThan(0);

    // One start action advances the case and prepares reviewable drafts.
    const prep = await caller.workflow.initiateOutreach({ caseId });
    expect(prep.created).toBeGreaterThan(0);
    expect(prep.alreadyInitiated).toBe(false);

    const queue = await caller.workflow.reviewQueue({ caseId });
    expect(queue.length).toBeGreaterThan(0);

    const review = await caller.workflow.preSendReview({ outreachId: queue[0].id });
    const approved = await caller.workflow.approveDraft({ outreachId: queue[0].id, approvalHash: review.message.approvalHash });
    expect(approved.status).toBe('Approved');
    expect(approved.sent).toBe(false); // safety boundary: nothing is sent

    // The approved draft leaves the pending queue.
    const queue2 = await caller.workflow.reviewQueue({ caseId });
    expect(queue2.find((q: any) => q.id === queue[0].id)).toBeUndefined();
  });
});
