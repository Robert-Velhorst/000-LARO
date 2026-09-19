import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDesktopRecoveryKey } from '../../src-main/desktopRecoveryKey';

const roots: string[] = [];

function temporaryProfile(): { root: string; backups: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'laro-recovery-key-'));
  roots.push(root);
  const backups = path.join(root, 'backups');
  fs.mkdirSync(backups);
  return { root, backups };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('desktop recovery-key lifecycle', () => {
  it('creates and reuses a separate owner-only key file', () => {
    const { root, backups } = temporaryProfile();
    const firstEnvironment: NodeJS.ProcessEnv = {};
    const first = ensureDesktopRecoveryKey(root, backups, firstEnvironment);
    expect(first).toMatchObject({ source: 'created-file', keyPath: path.join(root, 'laro-recovery.key') });
    const original = fs.readFileSync(first.keyPath!, 'utf8');
    expect(original.trim()).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') expect(fs.statSync(first.keyPath!).mode & 0o077).toBe(0);

    const secondEnvironment: NodeJS.ProcessEnv = {};
    expect(ensureDesktopRecoveryKey(root, backups, secondEnvironment)).toMatchObject({ source: 'existing-file' });
    expect(fs.readFileSync(first.keyPath!, 'utf8')).toBe(original);
    expect(secondEnvironment.LARO_RECOVERY_KEY_FILE).toBe(first.keyPath);
  });

  it('never replaces a missing key while encrypted backups remain', () => {
    const { root, backups } = temporaryProfile();
    fs.writeFileSync(path.join(backups, 'retained.sqlite.manifest.json'), JSON.stringify({
      format: 'laro-backup-set',
      version: 4,
    }));
    expect(() => ensureDesktopRecoveryKey(root, backups, {})).toThrow('recovery key is missing');
    expect(fs.existsSync(path.join(root, 'laro-recovery.key'))).toBe(false);
  });

  it('honors an operator-managed environment credential without creating a desktop copy', () => {
    const { root, backups } = temporaryProfile();
    expect(ensureDesktopRecoveryKey(root, backups, {
      LARO_RECOVERY_KEY_FILE: path.join(root, 'operator-managed.key'),
    })).toEqual({ source: 'environment' });
    expect(fs.existsSync(path.join(root, 'laro-recovery.key'))).toBe(false);
  });
});
