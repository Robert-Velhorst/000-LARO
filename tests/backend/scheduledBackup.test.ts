import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getScheduledBackupHealth,
  readScheduledBackupConfig,
  refreshScheduledBackupState,
  runScheduledBackup,
  type ScheduledBackupConfig,
} from '../../server/scheduledBackup';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';

const suite = sqliteAvailable ? describe : describe.skip;

suite('automatic recovery backups', () => {
  let app: TestApp;
  let backupDirectory: string;
  let config: ScheduledBackupConfig;

  beforeAll(async () => {
    app = await bootTestApp();
    backupDirectory = path.join(app.tmpDir, 'scheduled-backups');
    fs.writeFileSync(path.join(app.tmpDir, 'laro-secrets.json'), JSON.stringify({
      jwtSecret: 'a'.repeat(64),
      cookieSecret: 'b'.repeat(64),
    }));
    config = {
      directory: backupDirectory,
      destinationKind: 'local',
      retentionCount: 2,
      retentionDays: 30,
      maxAgeHours: 30,
    };
  });

  afterAll(async () => {
    const { closeDatabaseForMaintenance } = await import('../../server/db');
    closeDatabaseForMaintenance();
    app?.cleanup();
  });

  it('is opt-in and rejects unsafe policy values', () => {
    expect(readScheduledBackupConfig({})).toBeNull();
    expect(() => readScheduledBackupConfig({
      LARO_BACKUP_DIRECTORY: backupDirectory,
      LARO_BACKUP_RETENTION_COUNT: '1',
    })).toThrow('between 2 and 60');
    expect(() => readScheduledBackupConfig({
      LARO_BACKUP_DIRECTORY: backupDirectory,
      LARO_BACKUP_DESTINATION_KIND: 'cloud',
    })).toThrow('local, synced, or network');
    expect(() => readScheduledBackupConfig({
      LARO_BACKUP_DIRECTORY: backupDirectory,
      LARO_BACKUP_RETENTION_DAYS: '0',
    })).toThrow('between 1 and 365');
  });

  it('fails closed before validating an unbounded backup inventory', () => {
    const crowded = path.join(app.tmpDir, 'crowded-backups');
    fs.mkdirSync(crowded, { recursive: true });
    for (let index = 0; index < 121; index += 1) {
      fs.writeFileSync(
        path.join(crowded, `laro-2000-01-01T00-00-00-${String(index).padStart(3, '0')}Z-deadbeef.sqlite`),
        'candidate',
      );
    }
    const health = refreshScheduledBackupState({ ...config, directory: crowded });
    expect(health.status).toBe('failed');
    expect(health).not.toHaveProperty('lastError');
  });

  it('creates validated sets, retains the newest sets, and preserves unknown or invalid files', async () => {
    fs.mkdirSync(backupDirectory, { recursive: true });
    const unknown = path.join(backupDirectory, 'operator-notes.txt');
    const invalid = path.join(backupDirectory, 'laro-2000-01-01T00-00-00-000Z-deadbeef.sqlite');
    fs.writeFileSync(unknown, 'preserve');
    fs.writeFileSync(invalid, 'not a backup');

    await runScheduledBackup(config);
    await runScheduledBackup(config);
    await runScheduledBackup(config);

    const databases = fs.readdirSync(backupDirectory)
      .filter((name) => /^laro-.*\.sqlite$/.test(name) && name !== path.basename(invalid));
    expect(databases).toHaveLength(2);
    expect(fs.readFileSync(unknown, 'utf8')).toBe('preserve');
    expect(fs.readFileSync(invalid, 'utf8')).toBe('not a backup');

    const health = refreshScheduledBackupState(config);
    expect(health).toMatchObject({
      configured: true,
      status: 'healthy',
      destinationKind: 'local',
      retentionCount: 2,
    });
    expect(health.latestValidAt).toBeTruthy();
    expect(getScheduledBackupHealth(config).ageHours).toBe(0);
  });
});
