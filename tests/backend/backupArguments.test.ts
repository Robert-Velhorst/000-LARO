import { describe, expect, it } from 'vitest';
import { parseBackupArguments } from '../../scripts/backupArguments';

describe('database maintenance CLI arguments', () => {
  it('preserves an explicit backup destination when no flags are present', () => {
    expect(parseBackupArguments(['C:\\Backups\\laro.sqlite'])).toEqual({
      commandOrDestination: 'C:\\Backups\\laro.sqlite',
      file: undefined,
      desktopSecretsPath: undefined,
      localStoragePath: undefined,
      recoveryKeyPath: undefined,
      allowLegacy: false,
      allowMissingStorage: false,
    });
  });

  it('parses restore and legacy override without changing positional paths', () => {
    expect(parseBackupArguments(['--restore', 'legacy.sqlite', '--allow-legacy'])).toMatchObject({
      commandOrDestination: '--restore',
      file: 'legacy.sqlite',
      allowLegacy: true,
    });
  });

  it('accepts an explicit desktop-secret path in any supported command', () => {
    expect(parseBackupArguments([
      '--desktop-secrets',
      'C:\\Profile\\laro-secrets.json',
      '--validate',
      'backup.sqlite',
    ])).toEqual({
      commandOrDestination: '--validate',
      file: 'backup.sqlite',
      desktopSecretsPath: 'C:\\Profile\\laro-secrets.json',
      localStoragePath: undefined,
      recoveryKeyPath: undefined,
      allowLegacy: false,
      allowMissingStorage: false,
    });
  });

  it('parses local evidence and version-1 recovery overrides explicitly', () => {
    expect(parseBackupArguments([
      '--restore',
      'backup.sqlite',
      '--local-storage',
      'D:\\LARO\\uploads',
      '--allow-missing-storage',
    ])).toMatchObject({
      commandOrDestination: '--restore',
      file: 'backup.sqlite',
      localStoragePath: 'D:\\LARO\\uploads',
      allowMissingStorage: true,
    });
  });

  it('accepts a separate recovery-key file without placing the key on the command line', () => {
    expect(parseBackupArguments([
      '--recovery-key-file',
      'E:\\Protected\\laro-recovery.key',
      '--validate',
      'backup.sqlite',
    ])).toMatchObject({
      commandOrDestination: '--validate',
      file: 'backup.sqlite',
      recoveryKeyPath: 'E:\\Protected\\laro-recovery.key',
    });
  });

  it('rejects missing values and unknown maintenance flags', () => {
    expect(() => parseBackupArguments(['--desktop-secrets'])).toThrow('requires a file path');
    expect(() => parseBackupArguments(['--local-storage'])).toThrow('requires a directory path');
    expect(() => parseBackupArguments(['--recovery-key-file'])).toThrow('requires a file path');
    expect(() => parseBackupArguments(['--unknown'])).toThrow('Unknown database-maintenance option');
  });
});
