import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const REQUIRED_FILES = [
  'scripts/verify-security-workflow.mjs',
  '.github/workflows/security.yml',
  'docs/SECURITY_SCANNING.md',
  '.gitleaksignore',
  'Dockerfile',
];

describe('security workflow verifier portability', () => {
  it('accepts a Windows CRLF checkout of every inspected text file', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'laro-security-workflow-crlf-'));

    try {
      for (const relativePath of REQUIRED_FILES) {
        const targetPath = join(fixtureRoot, relativePath);
        mkdirSync(dirname(targetPath), { recursive: true });
        const source = readFileSync(join(ROOT, relativePath), 'utf8');
        writeFileSync(targetPath, source.replace(/\r?\n/g, '\r\n'), 'utf8');
      }

      const result = spawnSync(
        process.execPath,
        [join(fixtureRoot, 'scripts', 'verify-security-workflow.mjs')],
        { cwd: fixtureRoot, encoding: 'utf8' },
      );

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('security-workflow: blocking source, secret, SBOM, vulnerability, and scheduled-failure contracts passed');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
