#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE_NAMES = ['publicBrand', 'liveProviders'];
const BRAND_ASSET_PATHS = ['build/icon.png', 'public/laro-logo.png'];
export const PROVIDER_REQUIREMENTS = Object.freeze({
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
  inboundEmail: ['credentials', 'replyReceived', 'threadedToOutreach', 'analyticsUpdated'],
  s3: ['credentials', 'put', 'read', 'hashMatched', 'delete', 'backupInventory'],
  forgeLlm: ['credentials', 'sourceLinkedResult', 'invalidCitationRejected', 'failureClosed'],
  telegram: ['credentials', 'messageRead', 'evidencePersisted', 'sourceLinkOpened'],
});

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function validApproval(gate) {
  const approvedAt = typeof gate?.approvedAt === 'string' ? Date.parse(gate.approvedAt) : NaN;
  return gate?.status === 'approved'
    && typeof gate.approvedBy === 'string'
    && gate.approvedBy.trim().length > 0
    && Number.isFinite(approvedAt)
    && approvedAt <= Date.now() + 5 * 60_000
    && Array.isArray(gate.evidence)
    && gate.evidence.length > 0
    && gate.evidence.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function isNonEmptyStringArray(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function currentBrandAssets() {
  return BRAND_ASSET_PATHS.map((path) => {
    const absolutePath = join(ROOT, path);
    return {
      path,
      bytes: statSync(absolutePath).size,
      sha256: createHash('sha256').update(readFileSync(absolutePath)).digest('hex'),
    };
  });
}

function validatePublicBrandApproval(gate, expectedAssets) {
  if (!Array.isArray(gate?.assets)) {
    return ['publicBrand approval requires immutable asset hashes'];
  }

  const errors = [];
  const expectedPaths = expectedAssets.map((asset) => asset.path);
  const unexpected = gate.assets
    .map((asset) => asset?.path)
    .filter((path) => typeof path !== 'string' || !expectedPaths.includes(path));
  if (unexpected.length > 0) {
    errors.push(`publicBrand.assets contains unexpected paths: ${unexpected.join(', ')}`);
  }

  for (const expected of expectedAssets) {
    const recorded = gate.assets.find((asset) => asset?.path === expected.path);
    if (!recorded) {
      errors.push(`publicBrand.assets is missing ${expected.path}`);
      continue;
    }
    if (recorded.bytes !== expected.bytes) {
      errors.push(`publicBrand asset size mismatch: ${expected.path}`);
    }
    if (recorded.sha256 !== expected.sha256) {
      errors.push(`publicBrand asset hash mismatch: ${expected.path}`);
    }
  }
  return errors;
}

function validateProviderApproval(gate) {
  const errors = [];
  if (!isNonEmptyStringArray(gate?.providerScope)) {
    return ['liveProviders approval requires a non-empty providerScope'];
  }

  const scope = gate.providerScope;
  if (new Set(scope).size !== scope.length) {
    errors.push('liveProviders.providerScope must not contain duplicates');
  }
  const unsupported = scope.filter((provider) => !(provider in PROVIDER_REQUIREMENTS));
  if (unsupported.length > 0) {
    errors.push(`liveProviders.providerScope contains unsupported providers: ${unsupported.join(', ')}`);
  }

  const providerChecks = gate.providerChecks;
  if (!providerChecks || typeof providerChecks !== 'object' || Array.isArray(providerChecks)) {
    errors.push('liveProviders approval requires a providerChecks object');
    return errors;
  }

  const unexpectedChecks = Object.keys(providerChecks).filter((provider) => !scope.includes(provider));
  if (unexpectedChecks.length > 0) {
    errors.push(`liveProviders.providerChecks contains providers outside providerScope: ${unexpectedChecks.join(', ')}`);
  }

  const now = Date.now();
  for (const provider of scope) {
    if (!(provider in PROVIDER_REQUIREMENTS)) continue;
    const result = providerChecks[provider];
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      errors.push(`liveProviders.providerChecks.${provider} is required`);
      continue;
    }
    if (result.status !== 'passed') {
      errors.push(`liveProviders.providerChecks.${provider}.status must be passed`);
    }
    const testedAt = typeof result.testedAt === 'string' ? Date.parse(result.testedAt) : NaN;
    if (!Number.isFinite(testedAt) || testedAt > now + 5 * 60_000) {
      errors.push(`liveProviders.providerChecks.${provider}.testedAt must be a valid non-future timestamp`);
    }
    if (!isNonEmptyStringArray(result.evidence)) {
      errors.push(`liveProviders.providerChecks.${provider}.evidence must contain at least one reference`);
    }
    if (!isNonEmptyStringArray(result.checks)) {
      errors.push(`liveProviders.providerChecks.${provider}.checks must be a non-empty list`);
      continue;
    }
    if (new Set(result.checks).size !== result.checks.length) {
      errors.push(`liveProviders.providerChecks.${provider}.checks must not contain duplicates`);
    }
    const missing = PROVIDER_REQUIREMENTS[provider].filter((check) => !result.checks.includes(check));
    if (missing.length > 0) {
      errors.push(`liveProviders.providerChecks.${provider} is missing checks: ${missing.join(', ')}`);
    }
  }
  return errors;
}

export function validateReleaseAcceptance({
  record,
  packageVersion,
  tag,
  requireApproved = false,
  expectedBrandAssets = currentBrandAssets(),
}) {
  const errors = [];
  const pending = [];

  if (record?.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (record?.version !== packageVersion) {
    errors.push(`record version ${record?.version ?? '(missing)'} does not match package version ${packageVersion}`);
  }
  if (tag && tag !== `v${packageVersion}`) {
    errors.push(`tag ${tag} does not match package version v${packageVersion}`);
  }

  for (const gateName of GATE_NAMES) {
    const gate = record?.gates?.[gateName];
    if (!gate || !['pending', 'approved'].includes(gate.status)) {
      errors.push(`${gateName}.status must be pending or approved`);
      continue;
    }
    if (gate.status !== 'approved') {
      pending.push(gateName);
    } else if (!validApproval(gate)) {
      errors.push(`${gateName} approval requires approvedBy, approvedAt, and at least one evidence reference`);
    }
  }

  if (record?.gates?.publicBrand?.status === 'approved') {
    errors.push(...validatePublicBrandApproval(record.gates.publicBrand, expectedBrandAssets));
  }

  const providerGate = record?.gates?.liveProviders;
  if (providerGate?.status === 'approved') errors.push(...validateProviderApproval(providerGate));
  if (requireApproved && pending.length > 0) {
    errors.push(`release acceptance pending: ${pending.join(', ')}`);
  }

  return { errors, pending };
}

export function runReleaseAcceptance(args = process.argv.slice(2)) {
  const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const requestedFile = argumentValue(args, '--file') || join(ROOT, 'release-acceptance.json');
  const recordPath = isAbsolute(requestedFile) ? requestedFile : resolve(process.cwd(), requestedFile);
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  const requireApproved = args.includes('--require-approved');
  const tag = argumentValue(args, '--tag');
  const result = validateReleaseAcceptance({ record, packageVersion, tag, requireApproved });

  console.log(`Release acceptance for v${packageVersion}`);
  for (const gateName of GATE_NAMES) {
    console.log(`- ${gateName}: ${record?.gates?.[gateName]?.status ?? 'missing'}`);
  }
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    return 1;
  }
  if (result.pending.length > 0) {
    console.log(`Pending external gates: ${result.pending.join(', ')}`);
  } else {
    console.log('All recorded external acceptance gates are approved.');
  }
  if (result.pending.includes('liveProviders') || args.includes('--show-provider-requirements')) {
    console.log('Provider acceptance requirements:');
    for (const [provider, checks] of Object.entries(PROVIDER_REQUIREMENTS)) {
      console.log(`  - ${provider}: ${checks.join(', ')}`);
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runReleaseAcceptance();
}
