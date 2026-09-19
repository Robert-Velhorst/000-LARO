import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const RECOVERY_KEY_PATTERN = /^[a-f0-9]{64}$/;

export interface DesktopRecoveryKeyResult {
  source: 'environment' | 'existing-file' | 'created-file';
  keyPath?: string;
}

function hasEncryptedBackup(directory: string): boolean {
  if (!fs.existsSync(directory)) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.manifest.json')) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, entry.name), 'utf8')) as {
        format?: unknown;
        version?: unknown;
      };
      if (value.format === 'laro-backup-set' && value.version === 4) return true;
    } catch {
      // A malformed unrelated file is not proof that this installation owns an
      // encrypted set. The scheduled-backup inventory reports it separately.
    }
  }
  return false;
}

function readRecoveryKey(keyPath: string): string {
  let value: string;
  try {
    const stat = fs.statSync(keyPath);
    if (!stat.isFile()) throw new Error('not a regular file');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('permissions must be 0600');
    }
    value = fs.readFileSync(keyPath, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `Could not securely read the desktop recovery key at ${keyPath}. ` +
        'Restore the escrowed recovery key; do not replace it while encrypted backups are retained.',
      { cause: error },
    );
  }
  if (!RECOVERY_KEY_PATTERN.test(value)) {
    throw new Error(
      `The desktop recovery key at ${keyPath} is invalid. ` +
        'Restore the original 64-character key before validating or restoring backups.',
    );
  }
  return value;
}

function createRecoveryKey(keyPath: string): void {
  const temporaryPath = `${keyPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${crypto.randomBytes(32).toString('hex')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, keyPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* not created */ }
    throw new Error(`Could not persist the desktop recovery key at ${keyPath}.`, { cause: error });
  }
}

export function ensureDesktopRecoveryKey(
  userDataPath: string,
  backupDirectory: string,
  targetEnvironment: NodeJS.ProcessEnv = process.env,
): DesktopRecoveryKeyResult {
  if (targetEnvironment.LARO_RECOVERY_KEY || targetEnvironment.LARO_RECOVERY_KEY_FILE) {
    return { source: 'environment' };
  }
  const keyPath = path.join(userDataPath, 'laro-recovery.key');
  const existed = fs.existsSync(keyPath);
  if (!existed && hasEncryptedBackup(backupDirectory)) {
    throw new Error(
      'Encrypted backups exist but the desktop recovery key is missing. ' +
        'Restore laro-recovery.key from its separate escrow copy; generating a replacement would not decrypt them.',
    );
  }
  if (!existed) createRecoveryKey(keyPath);
  readRecoveryKey(keyPath);
  targetEnvironment.LARO_RECOVERY_KEY_FILE = keyPath;
  return { source: existed ? 'existing-file' : 'created-file', keyPath };
}
