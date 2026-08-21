/**
 * Phase 008 — authorization and resource ownership (anti-regression guard).
 *
 * A full behavioural test needs a live SQLite harness (added in Phase 040). In
 * the meantime this guardrail asserts, against the actual source, that the
 * previously IDOR-vulnerable routers have been hardened and cannot silently
 * regress:
 *   - no router falls back to the shared "demo-user-123" identity;
 *   - case-scoped routers call the ownership guard;
 *   - the ownership guard itself exists and throws FORBIDDEN.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const HARDENED_ROUTERS = [
  'server/routers/evidenceFiles.ts',
  'server/routers/evidenceAnalytics.ts',
  'server/routers/evidenceTimeline.ts',
  'server/routers/userPreferences.ts',
  'server/routers/support.ts',
  'server/routers/outreach.ts',
  'server/routers/gapAnalysis.ts',
  'server/routers/cases.ts',
];

const CASE_SCOPED_ROUTERS = [
  'server/routers/outreach.ts',
  'server/routers/gapAnalysis.ts',
  'server/routers/cases.ts',
];

describe('Phase 008 — no shared demo identity remains', () => {
  for (const f of HARDENED_ROUTERS) {
    it(`${f} contains no "demo-user-123" fallback`, () => {
      expect(read(f)).not.toContain('demo-user-123');
    });
  }
});

describe('Phase 008 — case-scoped routers enforce ownership', () => {
  for (const f of CASE_SCOPED_ROUTERS) {
    it(`${f} calls assertCaseOwnership`, () => {
      expect(read(f)).toContain('assertCaseOwnership');
    });
  }

  it('the ownership guard exists and throws FORBIDDEN', () => {
    const src = read('server/_core/authz.ts');
    expect(src).toContain('export async function assertCaseOwnership');
    expect(src).toContain('FORBIDDEN');
  });
});

describe('Phase 007 — no well-known bearer accepted in production', () => {
  it('removes local bypass and renderer-accessible bearer credentials', () => {
    const src = read('server/context.ts');
    const trpc = read('server/_core/trpc.ts');
    expect(src).not.toContain('LOCAL_AGENT_TOKEN');
    expect(src).not.toContain('local-default');
    expect(src).not.toContain('authHeader');
    expect(src).not.toContain('Bearer ');
    expect(src).toContain('isDesktopScannerRequest');
    expect(trpc).not.toContain('evidence-scanner');
  });
});
