/**
 * Phase 081 — non-technical user simulation.
 *
 * Simulates a first-time, non-technical user completing the product's core job
 * using ONLY what the app itself offers for guidance (the in-app help topics and
 * error catalog — Phases 071/072). Every step a real user would take is driven
 * through the REAL tRPC API, and we assert that:
 *   - the app tells the user what to do (help topics exist and are ordered),
 *   - each step of the advertised journey actually works,
 *   - the safety boundary holds (nothing is sent without approval),
 *   - the user can get their data out and delete their account,
 *   - an action the product does NOT implement fails honestly (no fake success).
 *
 * This is a behavioural test of the shipped product from the user's seat, not a
 * unit stub. If a step here breaks, a real non-technical user is blocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildLawyer } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phase 081 — non-technical user journey simulation', () => {
  let app: TestApp;
  let userId: string;
  const me = () => app.makeCaller({ id: userId, name: 'Nora', role: 'user', email: 'nora@example.com' });

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.lawyers).values(
      buildLawyer({ id: 'LWYR_SIM', legalAreas: JSON.stringify(['Employment Law']) }),
    );
  });
  afterAll(() => app?.cleanup());

  it('Step 0 — the app explains how to start (ordered help, disclaimer present)', async () => {
    const anon = app.makeCaller(null);
    const topics = await anon.help.topics();
    // A non-technical user needs a numbered starting path.
    const steps = topics.filter((t: any) => t.step != null).map((t: any) => t.step);
    expect(steps.length).toBeGreaterThan(2);
    expect(steps).toEqual([...steps].sort((a: number, b: number) => a - b));
    // The not-legal-advice disclaimer must be discoverable up front.
    expect(topics.find((t: any) => t.id === 'disclaimer')).toBeTruthy();
    // And the error catalog gives plain-language remedies, not codes.
    const cat = await anon.help.errorCatalog();
    expect(cat.every((e: any) => e.remedy && e.message)).toBe(true);
  });

  it('Step 1 — signs up with a simple email/password', async () => {
    const res = await app.makeCaller(null).auth.signup({
      email: 'nora@example.com',
      password: 'my-password-123',
      name: 'Nora',
    });
    expect(res.success).toBe(true);
    const rows = await app.db.select().from(app.schema.users);
    userId = rows.find((r: any) => r.email === 'nora@example.com').id;
    expect(userId).toBeTruthy();
  });

  it('Step 2 — describes her problem in plain words; the app classifies it', async () => {
    const res = await me().cases.create({
      clientName: 'Nora Jansen',
      clientEmail: 'nora.j@example.com',
      caseType: 'Employment',
      caseSummary: 'Ik ben onterecht ontslagen door mijn werkgever zonder opzegtermijn.',
      urgency: 'High',
    });
    expect(res.success).toBe(true);
    // She did not have to pick a legal area — the app inferred it.
    expect(res.legalAreas).toContain('Employment Law');
  });

  it('Step 3 — sees suitable lawyers without contacting anyone', async () => {
    const caseId = (await me().cases.list({})).cases[0].id;
    const matches = await me().matching.findLawyers({ caseId });
    expect(matches.length).toBeGreaterThan(0);
    // No side effect: no outreach exists yet just from viewing matches.
    const outreach = await app.db.select().from(app.schema.outreachStatus);
    expect(outreach.length).toBe(0);
  });

  it('Step 4 — prepares outreach and must explicitly approve (nothing auto-sent)', async () => {
    const caseId = (await me().cases.list({})).cases[0].id;
    const prep = await me().workflow.prepareDrafts({ caseId });
    expect(prep.created).toBeGreaterThan(0);

    const queue = await me().workflow.reviewQueue({ caseId });
    expect(queue.length).toBeGreaterThan(0);

    const review = await me().workflow.preSendReview({ outreachId: queue[0].id });
    const approved = await me().workflow.approveDraft({ outreachId: queue[0].id, approvalHash: review.message.approvalHash });
    expect(approved.status).toBe('Approved');
    // The core safety promise a non-technical user relies on:
    expect(approved.sent).toBe(false);
  });

  it('Step 5 — can export her data and delete her account (control over her data)', async () => {
    const caseId = (await me().cases.list({})).cases[0].id;

    const single = await me().cases.export({ caseId });
    expect(single.format).toBe('laro-case-export/v1');

    const full = await me().gdpr.exportData();
    expect(full.success).toBe(true);
    expect(full.data).toBeTruthy();

    const del = await me().gdpr.deleteData({ confirm: true });
    expect(del.success).toBe(true);
    // Account is really gone — a subsequent read finds no user.
    const rows = await app.db.select().from(app.schema.users);
    expect(rows.find((r: any) => r.id === userId)).toBeUndefined();
  });

  it('Honesty — invalid OCR input fails clearly, it does not fake success', async () => {
    // OCR accepts supported image bytes only. A PDF data URL must fail before
    // recognition instead of returning fabricated text.
    const caller = app.makeCaller({ id: 'X', name: 'X', role: 'user', email: 'x@example.com' });
    await expect(
      caller.ocr.extractText({ image: 'data:application/pdf;base64,AAAA', language: 'nl' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});
