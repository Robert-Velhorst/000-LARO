#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = join(ROOT, '.github', 'workflows', 'security.yml');
const POLICY_PATH = join(ROOT, 'docs', 'SECURITY_SCANNING.md');
const BASELINE_PATH = join(ROOT, '.gitleaksignore');

const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
const policy = readFileSync(POLICY_PATH, 'utf8');
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
const baseline = readFileSync(BASELINE_PATH, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const failures = [];

function requireText(source, text, claim) {
  if (!source.includes(text)) failures.push(claim);
}

function requirePattern(source, pattern, claim) {
  if (!pattern.test(source)) failures.push(claim);
}

function job(name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start === -1) {
    failures.push(`missing ${name} job`);
    return '';
  }
  const contentStart = start + marker.length;
  const remainder = workflow.slice(contentStart);
  const nextJob = remainder.search(/\n  [a-zA-Z0-9_-]+:\n/);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

function namedStep(jobSource, name) {
  const marker = `      - name: ${name}\n`;
  const start = jobSource.indexOf(marker);
  if (start === -1) {
    failures.push(`missing step: ${name}`);
    return '';
  }
  const remainder = jobSource.slice(start + marker.length);
  const nextStep = remainder.search(/\n      - (?:name|uses):/);
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep);
}

requireText(workflow, '  push:\n    branches: [main]', 'security workflow must run for main pushes');
requireText(workflow, '  pull_request:\n    branches: [main]', 'security workflow must run for pull requests into main');
requirePattern(workflow, /  schedule:\n\s+- cron:/, 'security workflow must have a recurring schedule');
requireText(workflow, '  workflow_dispatch:', 'security workflow must support manual verification');
requireText(workflow.slice(0, workflow.indexOf('\njobs:')), 'permissions:\n  contents: read', 'top-level permissions must be read-only');
if (/continue-on-error\s*:\s*true/.test(workflow)) failures.push('blocking security jobs may not continue on error');

const codeql = job('codeql');
requireText(codeql, 'security-events: write', 'only CodeQL must receive security-events write permission');
requirePattern(codeql, /language:\s*\[javascript-typescript, python\]/, 'CodeQL must analyze JavaScript/TypeScript and Python');
requireText(codeql, 'queries: security-extended', 'CodeQL must use the security-extended query suite');
requirePattern(codeql, /github\/codeql-action\/init@[0-9a-f]{40}/i, 'CodeQL init must use an immutable action revision');
requirePattern(codeql, /github\/codeql-action\/analyze@[0-9a-f]{40}/i, 'CodeQL analyze must use an immutable action revision');

const secretScan = job('secret-scan');
requireText(secretScan, 'fetch-depth: 0', 'Gitleaks requires complete history');
requirePattern(secretScan, /gitleaks\/gitleaks-action@[0-9a-f]{40}/i, 'Gitleaks must use an immutable action revision');
requireText(secretScan, 'GITLEAKS_VERSION: 8.24.3', 'Gitleaks scanner version must be explicit');
requireText(secretScan, 'GITLEAKS_ENABLE_COMMENTS: false', 'secret findings must not be copied into pull-request comments');
requireText(secretScan, 'GITLEAKS_ENABLE_SUMMARY: false', 'secret findings must not be copied into the workflow summary');
requireText(secretScan, 'GITLEAKS_ENABLE_UPLOAD_ARTIFACT: false', 'secret findings must not be uploaded as artifacts');
requirePattern(secretScan, /gitleaks dir[^\n]*--redact[^\n]*--exit-code 2/, 'the checked-out merge result must be scanned with redaction and a blocking exit code');

const container = job('container-security');
const build = namedStep(container, 'Build the runtime image');
const inventory = namedStep(container, 'Generate CycloneDX software inventory');
const vulnerabilities = namedStep(container, 'Reject unaccepted high and critical vulnerabilities');
const upload = namedStep(container, 'Upload the software inventory');
requireText(build, 'mkdir -p out/security', 'container scan must create its output directory');
requireText(build, 'docker build --pull', 'container scan must build the current runtime image with a refreshed base');
requireText(inventory, 'version: v0.74.0', 'SBOM generation must pin the Trivy scanner version');
requireText(inventory, 'scanners: vuln', 'SBOM generation must inventory vulnerability packages');
requireText(inventory, 'format: cyclonedx', 'runtime inventory must use CycloneDX');
requireText(inventory, 'output: out/security/laro-sbom.cdx.json', 'CycloneDX inventory must have a stable artifact path');
requireText(inventory, "exit-code: '0'", 'inventory generation must complete before policy evaluation');
requireText(inventory, 'list-all-pkgs: true', 'CycloneDX inventory must include all discovered packages');
requireText(vulnerabilities, 'version: v0.74.0', 'vulnerability enforcement must pin the Trivy scanner version');
requireText(vulnerabilities, 'severity: HIGH,CRITICAL', 'container policy must inspect HIGH and CRITICAL findings');
requireText(vulnerabilities, 'ignore-unfixed: false', 'container policy must include unfixed findings');
requireText(vulnerabilities, "exit-code: '1'", 'container policy findings must fail the job');
requireText(upload, 'if: always()', 'CycloneDX inventory must be retained even when policy evaluation fails');
if (!(container.indexOf('Build the runtime image') < container.indexOf('Generate CycloneDX software inventory') &&
      container.indexOf('Generate CycloneDX software inventory') < container.indexOf('Reject unaccepted high and critical vulnerabilities') &&
      container.indexOf('Reject unaccepted high and critical vulnerabilities') < container.indexOf('Upload the software inventory'))) {
  failures.push('container build, inventory, enforcement, and upload steps must remain in evidence order');
}
requirePattern(
  dockerfile,
  /FROM gcr\.io\/distroless\/nodejs22-debian13:latest@sha256:[0-9a-f]{64} AS runtime/,
  'the scanned production runtime must retain its immutable minimal base image',
);
requireText(dockerfile, 'CMD ["/nodejs/bin/node", "-e"', 'the distroless healthcheck must invoke its absolute Node runtime');

const failureRecord = job('record-scheduled-failure');
requireText(failureRecord, "github.event_name == 'schedule'", 'failure records must be limited to scheduled scans');
requireText(failureRecord, "contains(needs.*.result, 'failure')", 'scheduled scan failures must trigger the record job');
requireText(failureRecord, 'needs: [codeql, secret-scan, container-security]', 'failure records must observe every scanner job');
requireText(failureRecord, 'issues: write', 'only the failure recorder must receive issue write permission');
requireText(failureRecord, 'node scripts/upsert-automation-failure.mjs', 'scheduled failures must use the maintained S0-05 issue updater');

const expectedBaseline = [
  '2e206548242e740cd9d3065691df9ce0b5fd1907:tests/security/productionReadiness.test.ts:generic-api-key:228',
  'c5712fd7c320797ace8ea8d1fffb228ef3723cc7:tests/smoke/configGuard.smoke.test.ts:generic-api-key:48',
  'c5712fd7c320797ace8ea8d1fffb228ef3723cc7:tests/smoke/configGuard.smoke.test.ts:generic-api-key:49',
];
if (JSON.stringify(baseline) !== JSON.stringify(expectedBaseline)) {
  failures.push('Gitleaks baseline must contain only the three reviewed immutable-history fingerprints');
}
for (const fingerprint of baseline) {
  if (!/^[0-9a-f]{40}:[^:]+:[a-z0-9-]+:\d+$/i.test(fingerprint)) {
    failures.push(`Gitleaks baseline entry is not an exact historical fingerprint: ${fingerprint}`);
  }
  requireText(policy, `\`${fingerprint}\``, `security policy must explain baseline fingerprint ${fingerprint}`);
}

for (const requiredPolicyText of [
  'CodeQL Action `v4.38.0`',
  'Gitleaks Action `v3.0.0` with Gitleaks `8.24.3`',
  'Trivy Action `v0.36.0` with Trivy `v0.74.0`',
  '`HIGH` or `CRITICAL`',
  'including unfixed findings',
  'No container-vulnerability suppressions are approved',
  'repository ruleset',
]) {
  requireText(policy, requiredPolicyText, `security policy is missing: ${requiredPolicyText}`);
}

if (failures.length > 0) {
  console.error('Security workflow contract failed:\n');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(`security-workflow: blocking source, secret, SBOM, vulnerability, and scheduled-failure contracts passed; ${baseline.length} exact historical baseline entries reviewed.`);
