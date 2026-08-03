/**
 * Phases 016-020 — background jobs, idempotency, rate limits, audit, dashboard.
 *
 * Behavioural coverage: the rate limiter and the cron job-runner are pure enough
 * to exercise directly. The rest are asserted at source level (a DB harness for
 * routers arrives in Phase 040).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { checkRateLimit, getRateLimitIdentifier, RATE_LIMITS } from '../../server/rateLimit';
import { runJob, getJobStatus } from '../../server/cronScheduler';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('Phase 018 — rate limiter enforces the window', () => {
  it('throws TOO_MANY_REQUESTS after maxRequests', () => {
    const cfg = { maxRequests: 3, windowMs: 60_000 };
    const id = `test-${Math.round(performance.now())}-${process.hrtime.bigint()}`;
    expect(() => checkRateLimit(id, cfg)).not.toThrow(); // 1
    expect(() => checkRateLimit(id, cfg)).not.toThrow(); // 2
    expect(() => checkRateLimit(id, cfg)).not.toThrow(); // 3
    expect(() => checkRateLimit(id, cfg)).toThrow(/Rate limit|Too many|limit/i); // 4
  });

  it('defines named limit configs used by the routers', () => {
    expect(RATE_LIMITS.caseCreate.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.auth.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.passwordResetRequest.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.passwordResetVerify.maxRequests).toBeGreaterThan(0);
    expect(RATE_LIMITS.lawyerSearch.maxRequests).toBeGreaterThan(0);
  });

  it('uses the proxy-appended client address instead of a spoofed left edge', () => {
    expect(getRateLimitIdentifier({
      req: {
        headers: { 'x-forwarded-for': '203.0.113.250, 198.51.100.42' },
        socket: { remoteAddress: '127.0.0.1' },
      },
    })).toBe('ip:198.51.100.42');
  });
});

describe('Phase 016 — cron job runner', () => {
  it('records success status and never throws', async () => {
    await runJob('unit-ok', async () => { /* ok */ });
    const s = getJobStatus().find((j) => j.name === 'unit-ok');
    expect(s).toBeTruthy();
    expect(s!.lastSuccessAt).not.toBeNull();
    expect(s!.failures).toBe(0);
  });

  it('retries then records failure without throwing', async () => {
    let calls = 0;
    await runJob('unit-fail', async () => { calls++; throw new Error('boom'); }, { retries: 2, baseDelayMs: 1 });
    const s = getJobStatus().find((j) => j.name === 'unit-fail');
    expect(calls).toBe(3);            // initial + 2 retries
    expect(s!.failures).toBe(1);
    expect(s!.lastError).toContain('boom');
  });
});

describe('Phase 017 — idempotency', () => {
  it('db.ts creates the unique (caseId, lawyerId) outreach index', () => {
    expect(read('server/db.ts')).toContain('outreach_status_case_lawyer_unique');
  });
  it('initiateOutreach short-circuits when already in Outreach', () => {
    expect(read('server/routers/workflow.ts')).toContain('alreadyInitiated');
  });
});

describe('Phase 019 — audit logging', () => {
  it('exposes a read path (audit router mounted)', () => {
    expect(read('server/routers/index.ts')).toContain('audit: auditRouter');
  });
  it('wires audit into case create/update/delete and login', () => {
    const cases = read('server/routers/cases.ts');
    expect(cases).toContain('AUDIT_ACTIONS.CASE_CREATED');
    expect(cases).toContain('AUDIT_ACTIONS.CASE_DELETED');
    expect(read('server/routers/index.ts')).toContain('AUDIT_ACTIONS.USER_LOGIN');
  });
  it('getAuditLogs actually filters by userId (no longer ignores params)', () => {
    expect(read('server/audit.ts')).toContain('eq(auditLogs.userId, options.userId)');
  });
});

describe('Phase 020 — dashboard next-actions', () => {
  it('dashboard exposes nextActions derived from real data', () => {
    const src = read('server/routers/dashboard.ts');
    expect(src).toContain('nextActions');
    expect(src).toContain('Add evidence');
  });
});
