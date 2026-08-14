import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const packageVersion = '1.3.0';
const temporaryDirectories: string[] = [];
const providerRequirements = {
  google: [
    'credentials',
    'oauthConsent',
    'gmailRead',
    'driveRead',
    'evidencePersisted',
    'sourceLinkOpened',
    'driveEvidencePersisted',
    'driveSourceLinkOpened',
    'disconnectRevoked',
  ],
  outboundEmail: ['credentials', 'approvedSend', 'singleDelivery', 'auditRecorded', 'duplicateBlocked'],
};

function approval() {
  return {
    status: 'approved',
    approvedBy: 'Release owner',
    approvedAt: new Date().toISOString(),
    evidence: ['review:brand-approval'],
  };
}

function brandAssets() {
  return ['build/icon.png', 'public/laro-logo.png'].map((path) => {
    const absolutePath = join(ROOT, path);
    return {
      path,
      bytes: statSync(absolutePath).size,
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
    };
  });
}

function publicBrandApproval() {
  return { ...approval(), assets: brandAssets() };
}

function record(liveProviders: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    version: packageVersion,
    gates: { publicBrand: publicBrandApproval(), liveProviders },
  };
}

function validate(candidate: Record<string, unknown>) {
  const directory = mkdtempSync(join(tmpdir(), 'laro-provider-acceptance-'));
  temporaryDirectories.push(directory);
  const file = join(directory, 'acceptance.json');
  writeFileSync(file, JSON.stringify(candidate));
  return spawnSync(process.execPath, [
    join(ROOT, 'scripts/release-acceptance.mjs'),
    '--require-approved',
    '--tag', `v${packageVersion}`,
    '--file', file,
  ], { cwd: ROOT, encoding: 'utf8' });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('release acceptance provider evidence', () => {
  it('rejects public-brand approval after a shipped asset changes', () => {
    const candidate = record({ status: 'pending', providerScope: [], providerChecks: {} });
    (candidate.gates.publicBrand.assets[0] as { sha256: string }).sha256 = '0'.repeat(64);
    const result = validate(candidate);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('publicBrand asset hash mismatch: build/icon.png');
  });

  it('rejects generic provider approval without provider-specific results', () => {
    const result = validate(record({ ...approval(), providerScope: ['google'] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('liveProviders approval requires a providerChecks object');
  });

  it('rejects unsupported scopes, future timestamps, and incomplete checks', () => {
    const result = validate(record({
      ...approval(),
      providerScope: ['google', 'unknownProvider'],
      providerChecks: {
        google: {
          status: 'passed',
          testedAt: '2999-01-01T00:00:00.000Z',
          evidence: ['run:google-live-test'],
          checks: ['credentials', 'oauthConsent'],
        },
        unknownProvider: {
          status: 'passed',
          testedAt: new Date().toISOString(),
          evidence: ['run:unknown'],
          checks: ['credentials'],
        },
      },
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported providers: unknownProvider');
    expect(result.stderr).toContain('must be a valid non-future timestamp');
    expect(result.stderr).toContain('is missing checks: gmailRead');
  });

  it('accepts complete evidence for every provider in the declared scope', () => {
    const providerScope = ['google', 'outboundEmail'] as const;
    const providerChecks = Object.fromEntries(providerScope.map((provider) => [provider, {
      status: 'passed',
      testedAt: new Date().toISOString(),
      evidence: [`run:${provider}-acceptance`],
      checks: providerRequirements[provider],
    }]));
    const result = validate(record({ ...approval(), providerScope: [...providerScope], providerChecks }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All recorded external acceptance gates are approved.');
  });

  it('rejects a legacy Google checklist without Drive document proof', () => {
    const result = validate(record({
      ...approval(),
      providerScope: ['google'],
      providerChecks: {
        google: {
          status: 'passed',
          testedAt: new Date().toISOString(),
          evidence: ['run:legacy-google-acceptance'],
          checks: [
            'credentials',
            'oauthConsent',
            'gmailRead',
            'driveRead',
            'evidencePersisted',
            'sourceLinkOpened',
            'disconnectRevoked',
          ],
        },
      },
    }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('driveEvidencePersisted');
    expect(result.stderr).toContain('driveSourceLinkOpened');
  });

  it('prepares an unapproved provider draft with exact checks and brand hashes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'laro-acceptance-draft-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'draft.json');
    const result = spawnSync(process.execPath, [
      join(ROOT, 'scripts/prepare-release-acceptance.mjs'),
      '--providers', 'google,outboundEmail',
      '--output', output,
    ], { cwd: ROOT, encoding: 'utf8' });

    expect(result.status).toBe(0);
    const draft = JSON.parse(readFileSync(output, 'utf8'));
    expect(draft.gates.publicBrand.status).toBe('pending');
    expect(draft.gates.liveProviders.status).toBe('pending');
    expect(draft.gates.liveProviders.providerScope).toEqual(['google', 'outboundEmail']);
    expect(draft.gates.liveProviders.providerChecks.google.requiredChecks).toEqual(providerRequirements.google);
    expect(draft.gates.liveProviders.providerChecks.google.checks).toEqual([]);
    expect(draft.gates.publicBrand.assets).toHaveLength(2);
    for (const asset of draft.gates.publicBrand.assets) {
      expect(asset.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(asset.bytes).toBeGreaterThan(0);
    }
    expect(result.stdout).toContain('No gate was approved and no provider credential was read or stored.');
  });

  it('refuses unsupported providers and preserves an existing draft by default', () => {
    const directory = mkdtempSync(join(tmpdir(), 'laro-acceptance-draft-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'draft.json');
    writeFileSync(output, 'owner draft');

    const unsupported = spawnSync(process.execPath, [
      join(ROOT, 'scripts/prepare-release-acceptance.mjs'),
      '--providers', 'google,unknown',
      '--output', join(directory, 'unsupported.json'),
    ], { cwd: ROOT, encoding: 'utf8' });
    const existing = spawnSync(process.execPath, [
      join(ROOT, 'scripts/prepare-release-acceptance.mjs'),
      '--providers', 'google',
      '--output', output,
    ], { cwd: ROOT, encoding: 'utf8' });

    expect(unsupported.status).toBe(1);
    expect(unsupported.stderr).toContain('Unsupported providers: unknown');
    expect(existing.status).toBe(1);
    expect(existing.stderr).toContain('Output already exists');
    expect(readFileSync(output, 'utf8')).toBe('owner draft');
  });
});
