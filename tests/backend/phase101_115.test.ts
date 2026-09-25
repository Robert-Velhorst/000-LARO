/**
 * Phases 101–115 — operator controls, retention, retries, onboarding, roles,
 * exceptions, clarifications, confidence. Real API + DB integration tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser, buildLawyer, buildCase } from '../factories';
import { retryWithBackoff, defaultIsRetryable } from '../../server/retry';
import { scoreToConfidence } from '../../server/confidence';
import { roleSatisfies, capabilitiesFor } from '../../server/_core/roles';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phases 101–115', () => {
  let app: TestApp;
  const ADMIN = { id: 'ADM_101', name: 'Adm', role: 'admin', email: 'adm101@example.com' };
  const U = { id: 'USR_101', name: 'U', role: 'user', email: 'usr101@example.com' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: U.id, email: U.email }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: 'LWYR_101', legalAreas: JSON.stringify(['Employment Law']) }));
  });
  afterAll(() => app?.cleanup());

  // ---- Phase 110: retry primitive (pure, deterministic) ----
  it('110 — retryWithBackoff retries transient errors then succeeds', async () => {
    let calls = 0;
    const result = await retryWithBackoff(async () => {
      calls++;
      if (calls < 3) throw new Error('temporarily busy');
      return 'ok';
    }, { attempts: 5, sleep: async () => {}, isRetryable: () => true });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('110 — retryWithBackoff does NOT retry non-retryable errors', async () => {
    let calls = 0;
    await expect(retryWithBackoff(async () => {
      calls++;
      throw new Error('validation failed: bad input');
    }, { attempts: 5, sleep: async () => {} })).rejects.toThrow(/validation/);
    expect(calls).toBe(1);
    expect(defaultIsRetryable(new Error('timeout'))).toBe(true);
    expect(defaultIsRetryable(new Error('forbidden'))).toBe(false);
  });

  // ---- Phase 107: honest confidence ----
  it('107 — confidence is derived from the real score, not hardcoded', () => {
    expect(scoreToConfidence(90).level).toBe('high');
    expect(scoreToConfidence(50).level).toBe('medium');
    expect(scoreToConfidence(10).level).toBe('low');
    expect(scoreToConfidence(200).percent).toBe(100); // clamped
  });

  // ---- Phase 106: roles ----
  it('106 — role hierarchy and capabilities are real', () => {
    expect(roleSatisfies('admin', 'operator')).toBe(true);
    expect(roleSatisfies('user', 'operator')).toBe(false);
    expect(capabilitiesFor('admin')).toContain('release-emergency-stop');
    expect(capabilitiesFor('user')).not.toContain('release-emergency-stop');
  });

  it('106 — system.capabilities reflects the caller role', async () => {
    const cap = await app.makeCaller(U).system.capabilities();
    expect(cap.role).toBe('user');
    expect(cap.capabilities).toContain('manage-own-cases');
  });

  // ---- Phase 105: onboarding ----
  it('105 — onboarding is protected and resumes per user', async () => {
    await expect(app.makeCaller(null).onboarding.state()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const caller = app.makeCaller(U);
    const before = await caller.onboarding.state();
    expect(before.complete).toBe(false);
    expect(before.status).toBe('active');
    expect(before.steps.map((step: any) => step.key)).toEqual(['case', 'evidence', 'outreach']);
    await caller.onboarding.setCurrentStep({ stepKey: 'evidence' });
    expect((await caller.onboarding.state()).currentStepKey).toBe('evidence');
    expect((await caller.onboarding.skip()).status).toBe('skipped');
  });

  // ---- Phase 104: emergency stop ----
  it('104 — emergency stop halts outreach; admin-gated; release resumes', async () => {
    const caller = app.makeCaller(U);
    const c = await caller.cases.create({ clientName: 'Stop Me', clientEmail: 's@x.com', caseType: 'Employment', caseSummary: 'werknemer ontslag', urgency: 'High' });

    // Non-admin cannot toggle the stop.
    await expect(app.makeCaller(U).admin.setEmergencyStop({ engaged: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Admin engages the stop.
    await app.makeCaller(ADMIN).admin.setEmergencyStop({ engaged: true });
    expect((await app.makeCaller(ADMIN).admin.emergencyStopStatus()).engaged).toBe(true);

    // Outreach prepare is now blocked.
    await expect(caller.workflow.prepareDrafts({ caseId: c.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Release resumes normal operation.
    await app.makeCaller(ADMIN).admin.setEmergencyStop({ engaged: false });
    const prep = await caller.workflow.prepareDrafts({ caseId: c.id });
    expect(prep.success).toBe(true);
  });

  // ---- Phase 102: retention ----
  it('102 — retention sweep deletes only audit logs older than the window', async () => {
    const now = Date.now();
    const old = new Date(now - 400 * 24 * 60 * 60 * 1000); // 400 days ago (> 365)
    const recent = new Date(now - 10 * 24 * 60 * 60 * 1000); // 10 days ago
    await app.db.insert(app.schema.auditLogs).values([
      { id: 'AL_OLD', userId: U.id, action: 'x', createdAt: old },
      { id: 'AL_NEW', userId: U.id, action: 'y', createdAt: recent },
    ] as any);

    const preview = await app.makeCaller(ADMIN).admin.retentionPreview();
    expect(preview.auditLogsDeleted).toBeGreaterThanOrEqual(1);

    const report = await app.makeCaller(ADMIN).admin.retentionRun();
    expect(report.auditLogsDeleted).toBeGreaterThanOrEqual(1);

    const rows = await app.db.select().from(app.schema.auditLogs);
    const ids = rows.map((r: any) => r.id);
    expect(ids).not.toContain('AL_OLD'); // old purged
    expect(ids).toContain('AL_NEW'); // recent kept
  });

  // ---- Phase 101: debug bundle ----
  it('101 — debug bundle is admin-only, redacted, and has no secrets', async () => {
    await expect(app.makeCaller(U).admin.debugBundle()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const bundle = await app.makeCaller(ADMIN).admin.debugBundle();
    expect(bundle.redacted).toBe(true);
    expect(bundle.tableCounts).toBeTruthy();
    expect(typeof bundle.emergencyStop).toBe('boolean');
    // No secret-looking values anywhere in the serialized bundle.
    expect(JSON.stringify(bundle)).not.toMatch(/sk-[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}/);
  });

  // ---- Phase 109: exception dashboard ----
  it('109 — exceptions surfaces only cases needing attention', async () => {
    const caller = app.makeCaller(U);
    // A case with no email + no evidence should raise exceptions. Insert directly
    // (the create API enforces a valid email; here we model an incomplete case).
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_EXC', userId: U.id, clientEmail: null, legalAreas: JSON.stringify([]) }));
    const res = await caller.dashboard.exceptions();
    expect(res.count).toBeGreaterThan(0);
    expect(res.exceptions.some((e: any) => e.kind === 'no-evidence' || e.kind === 'missing-contact' || e.kind === 'unclassified')).toBe(true);
  });

  // ---- Phase 111: real clarifications ----
  it('111 — clarifications are computed from real case state and resolvable', async () => {
    const caller = app.makeCaller(U);
    // Case with no client email → a "missing-contact" clarification.
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_CLAR', userId: U.id, clientEmail: null, legalAreas: JSON.stringify(['Employment Law']) }));
    const pending = await caller.clarifications.pending();
    expect(pending.length).toBeGreaterThan(0);
    const q = pending[0];
    const ans = await caller.clarifications.answer({ questionId: q.id, answer: 'resolved' });
    expect(ans.ok).toBe(true);
    // After answering, that clarification no longer appears.
    const after = await caller.clarifications.pending();
    expect(after.find((p: any) => p.id === q.id)).toBeUndefined();
  });
});
