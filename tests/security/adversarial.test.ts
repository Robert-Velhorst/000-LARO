/**
 * Phase 045 — adversarial "break-the-app" tests.
 *
 * Hostile inputs and unauthorized access must be rejected cleanly (typed errors),
 * never crash the server or leak data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';
import { RATE_LIMITS } from '../../server/rateLimit';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phase 045 — adversarial', () => {
  let app: TestApp;
  const U = { id: 'USER_ADV', name: 'Adv', role: 'user', email: 'adv@example.com' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: U.id, email: U.email }));
  });
  afterAll(() => app?.cleanup());

  it('rejects unauthenticated access to protected procedures', async () => {
    const anon = app.makeCaller(null);
    await expect(anon.cases.list({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon.cases.create({
      clientName: 'x', clientEmail: 'x@x.com', caseType: 'Employment', urgency: 'High',
    })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon.lawyerRating.get({ lawyerId: 'LAWYER_PRIVATE' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(anon.lawyerRating.topRated({ limit: 10 }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('rate-limits reset-message requests and reset-code guesses', async () => {
    const anon = app.makeCaller(null);
    const missingEmail = 'missing-reset-user@example.com';

    for (let i = 0; i < RATE_LIMITS.passwordResetRequest.maxRequests; i++) {
      await expect(anon.auth.requestPasswordReset({ email: missingEmail }))
        .resolves.toEqual({ success: true });
    }
    await expect(anon.auth.requestPasswordReset({ email: missingEmail }))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });

    const attempt = (code: string) => anon.auth.resetPassword({
      email: missingEmail,
      code,
      newPassword: 'replacement-password-123',
    });
    for (let i = 0; i < RATE_LIMITS.passwordResetVerify.maxRequests; i++) {
      await expect(attempt(String(i).padStart(6, '0')))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    await expect(attempt('999999'))
      .rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });

  it('rejects malformed input via schema validation', async () => {
    const caller = app.makeCaller(U);
    // Bad email
    await expect(caller.cases.create({
      clientName: 'Valid Name', clientEmail: 'not-an-email', caseType: 'Employment', urgency: 'High',
    })).rejects.toBeTruthy();
    // Invalid urgency enum
    await expect(caller.cases.create({
      clientName: 'Valid Name', clientEmail: 'v@x.com', caseType: 'Employment', urgency: 'Whenever' as any,
    })).rejects.toBeTruthy();
    // Oversized summary (> 20000)
    await expect(caller.cases.create({
      clientName: 'Valid Name', clientEmail: 'v@x.com', caseType: 'Employment', urgency: 'High',
      caseSummary: 'a'.repeat(20001),
    })).rejects.toBeTruthy();
  });

  it('handles SQL-injection-style search input safely', async () => {
    const caller = app.makeCaller(U);
    const evil = "'; DROP TABLE cases;-- ";
    const res = await caller.cases.list({ search: evil });
    expect(Array.isArray(res.cases)).toBe(true);
    // The cases table still exists and is queryable.
    const again = await caller.cases.list({});
    expect(again.pagination).toBeTruthy();
  });

  it('accessing a non-existent case is forbidden, not a crash', async () => {
    const caller = app.makeCaller(U);
    await expect(caller.outreach.byCaseId('NOPE_DOES_NOT_EXIST')).rejects.toBeTruthy();
    expect(await caller.cases.byId('NOPE_DOES_NOT_EXIST')).toBeNull();
  });

  it('enforces the case-create rate limit', async () => {
    const caller = app.makeCaller({ id: 'USER_RL', name: 'RL', role: 'user', email: 'rl@example.com' });
    await app.db.insert(app.schema.users).values(buildUser({ id: 'USER_RL', email: 'rl@example.com' }));
    const mk = (i: number) => caller.cases.create({
      clientName: `Client ${i}`, clientEmail: `c${i}@x.com`, caseType: 'Employment', urgency: 'Low',
    });
    // caseCreate limit is 5/hour; the 6th must be rejected.
    for (let i = 0; i < 5; i++) await mk(i);
    await expect(mk(5)).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
  });
});
