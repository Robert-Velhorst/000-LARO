/**
 * Phase 040 — backend test suite (real DB integration).
 *
 * Boots the real database layer against a throwaway temp SQLite file (migrations
 * run for real), seeds data with the Phase 039 factories, and exercises the wired
 * critical-path pieces end to end:
 *   - deterministic classification produces legal areas,
 *   - the REAL matching engine returns a suitable lawyer with a real score,
 *   - authorization (assertCaseOwnership) enforces the ownership boundary,
 *   - GDPR export returns the user's data and erasure deletes it.
 *
 * Requires the better-sqlite3 native binding. If it is not built the whole suite
 * skips (rather than failing), and prints how to build it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildUser, buildCase, buildLawyer, buildEvidence } from '../factories';

let sqliteOk = true;
try {
  const { createRequire } = await import('module');
  createRequire(import.meta.url)('better-sqlite3');
} catch {
  sqliteOk = false;
  console.warn('[backend suite] better-sqlite3 not built — skipping. Run: npm rebuild better-sqlite3');
}

const suite = sqliteOk ? describe : describe.skip;

suite('Phase 040 — critical-path backend integration', () => {
  let tmpDir: string;
  let db: any;
  let schema: any;
  let matching: any;
  let gdpr: any;
  let authz: any;
  let classification: any;
  let onboarding: any;
  const userId = 'USER_BE01';
  const otherUserId = 'USER_BE02';
  let scannerRows = [{ scanId: 'SCAN_BE01', ownerId: userId, path: '/private/owner-a.txt' }];
  let caseId: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    tmpDir = mkdtempSync(join(tmpdir(), 'laro-be-'));
    process.env.DATABASE_URL = join(tmpDir, 'test.sqlite');
    process.env.LOCAL_STORAGE_DIR = join(tmpDir, 'uploads');

    const dbmod = await import('../../server/db');
    schema = await import('../../server/schema');
    matching = await import('../../server/matching');
    gdpr = await import('../../server/gdpr');
    authz = await import('../../server/_core/authz');
    classification = await import('../../server/classification');
    onboarding = await import('../../server/onboarding');

    db = await dbmod.getDb(); // runs migrations against the fresh temp DB
    expect(db).toBeTruthy();

    // Seed: user, another user, a matching lawyer, and a classified case.
    await db.insert(schema.users).values(buildUser({ id: userId }));
    await db.insert(schema.users).values(buildUser({ id: otherUserId }));
    await db.insert(schema.lawyers).values(buildLawyer({ id: 'LWYR_BE01' }));
    await db.insert(schema.lawyers).values(buildLawyer({
      id: 'NOVA-BE-UNKNOWN',
      barAssociationStatus: 'Registered in NOvA public directory',
      caseLoad: null,
      averageResponseTimeHours: null,
      totalOutreaches: 0,
      totalResponses: 0,
      totalAcceptances: 0,
      currentlyAccepting: 'Unknown',
      capacityPercentage: null,
      directorySource: 'NOvA public lawyer finder',
      officialProfileUrl: 'https://zoekeenadvocaat.advocatenorde.nl/advocaten/test/123',
    }));

    const cls = classification.classifyLegalAreas(
      'werknemer ontslag zonder opzegtermijn',
      'Employment'
    );
    expect(cls.areas).toContain('Employment Law');

    const c = buildCase({ id: 'CASE_BE01', userId, legalAreas: JSON.stringify(cls.areas) });
    caseId = c.id;
    await db.insert(schema.cases).values(c);
    await db.insert(schema.evidence).values(buildEvidence({ caseId, userId }));
  });

  afterAll(() => {
    gdpr?.registerDesktopScannerPrivacyProvider(null);
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('the real matching engine returns the seeded lawyer with a real score', async () => {
    const matches = await matching.findMatchingLawyers(caseId, { sortBy: 'score' });
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBeGreaterThan(0);
    const m = matches[0];
    expect(m.id).toBe('LWYR_BE01');
    expect(typeof m.matchScore).toBe('number');
    expect(m.matchScore).toBeGreaterThan(0);
  });

  it('does not award performance or availability points for unknown NOvA metrics', async () => {
    const matches = await matching.findMatchingLawyers(caseId, { sortBy: 'score' });
    const official = matches.find((match: any) => match.id === 'NOVA-BE-UNKNOWN');
    expect(official).toBeTruthy();
    expect(official).toMatchObject({
      caseLoadScore: 0,
      responseTimeScore: 0,
      acceptanceRateScore: 0,
      capacityScore: 0,
    });
    expect(official.matchReasons).toEqual(expect.arrayContaining([
      'Case-load not available',
      'Response history not available',
      'Capacity not available',
    ]));
  });

  it('enforces case ownership (Phase 008)', async () => {
    await expect(authz.assertCaseOwnership(caseId, userId)).resolves.toBeUndefined();
    await expect(authz.assertCaseOwnership(caseId, otherUserId)).rejects.toBeTruthy();
  });

  it('GDPR export returns the user data (Phase 028)', async () => {
    gdpr.registerDesktopScannerPrivacyProvider({
      export: (ownerId: string) => ({ scans: [], files: scannerRows.filter((row) => row.ownerId === ownerId) }),
      erase: async (ownerId: string) => {
        const before = scannerRows.length;
        scannerRows = scannerRows.filter((row) => row.ownerId !== ownerId);
        return { scans: 0, files: before - scannerRows.length };
      },
    });
    await onboarding.setOnboardingCurrentStep(userId, 'evidence');
    const data = await gdpr.exportUserData(userId);
    expect(Array.isArray(data.users)).toBe(true);
    expect(data.cases?.some((c: any) => c.id === caseId)).toBe(true);
    // Password material is redacted.
    expect(data.users[0].password).toBeUndefined();
    expect(data.system_config).toEqual(expect.arrayContaining([
      expect.objectContaining({ configKey: `onboarding:state:${userId}` }),
    ]));
    expect(data.desktop_scanner_files).toEqual([expect.objectContaining({ path: '/private/owner-a.txt' })]);
    expect((await gdpr.exportUserData(otherUserId)).desktop_scanner_files).toEqual([]);
  });

  it('GDPR erasure deletes the user data (Phase 028)', async () => {
    const { deleted } = await gdpr.deleteUserData(userId);
    expect(deleted.cases).toBeGreaterThanOrEqual(1);
    expect(deleted.users).toBe(1);
    expect(deleted.system_config).toBe(1);
    expect(deleted.desktop_scanner_files).toBe(1);
    expect(scannerRows).toEqual([]);
    expect((await db.select().from(schema.systemConfig)).some(
      (row: any) => row.configKey === `onboarding:state:${userId}`,
    )).toBe(false);

    // The other user's data is untouched.
    const remaining = await gdpr.exportUserData(otherUserId);
    expect(remaining.users.length).toBe(1);
  });
});
