import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backupSetManifestPath,
  backupSetSecretsPath,
  createBackupSet,
  restoreBackupSet,
  validateBackupSet,
} from '../../server/backupSet';
import {
  assertLocalStorageUnchanged,
  backupSetStoragePath,
  createLocalStorageSnapshot,
} from '../../server/backupStorage';
import { buildUser } from '../factories';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';

const suite = sqliteAvailable ? describe : describe.skip;

function desktopSecrets(jwt = '1', cookie = '2') {
  return {
    jwtSecret: jwt.repeat(64),
    cookieSecret: cookie.repeat(64),
  };
}

suite('recovery-ready backup sets', () => {
  let app: TestApp;
  let secretsPath: string;
  let storagePath: string;
  const managedKey = 'evidence/backup-set/source.txt';
  const originalEvidence = 'original legal evidence bytes';

  beforeAll(async () => {
    app = await bootTestApp();
    secretsPath = path.join(app.tmpDir, 'laro-secrets.json');
    storagePath = path.join(app.tmpDir, 'uploads');
    fs.writeFileSync(secretsPath, JSON.stringify(desktopSecrets(), null, 2), { mode: 0o600 });
    await app.db.insert(app.schema.users).values(buildUser({
      id: 'BACKUP_SET_MARKER',
      email: 'backup-set-marker@example.invalid',
    }));
    const managedFilePath = path.join(storagePath, ...managedKey.split('/'));
    fs.mkdirSync(path.dirname(managedFilePath), { recursive: true });
    fs.writeFileSync(managedFilePath, originalEvidence);
    await app.db.insert(app.schema.evidenceFiles).values({
      id: 'BACKUP_SET_EVIDENCE',
      userId: 'BACKUP_SET_MARKER',
      fileName: 'source.txt',
      fileType: 'text/plain',
      fileSize: String(Buffer.byteLength(originalEvidence)),
      storageKey: managedKey,
    });
  });

  afterAll(async () => {
    const { closeDatabaseForMaintenance } = await import('../../server/db');
    closeDatabaseForMaintenance();
    app?.cleanup();
  });

  it('publishes database, secrets, and complete referenced local evidence', async () => {
    const destination = path.join(app.tmpDir, 'complete.sqlite');

    const result = await createBackupSet(destination, { desktopSecretsPath: secretsPath });
    const validation = validateBackupSet(destination);

    expect(result.databasePath).toBe(destination);
    expect(result.manifestPath).toBe(backupSetManifestPath(destination));
    expect(result.secretsPath).toBe(backupSetSecretsPath(destination));
    expect(result.storagePath).toBe(backupSetStoragePath(destination));
    expect(validation.valid).toBe(true);
    expect(validation.storageCoverage).toBe('complete-local');
    expect(validation.manifest?.version).toBe(2);
    expect(validation.manifest?.encryption.mode).toBe('bundled-desktop-secret');
    expect(validation.manifest?.storage).toMatchObject({
      mode: 'bundled-local',
      fileCount: 1,
      totalBytes: Buffer.byteLength(originalEvidence),
    });
    expect(fs.readFileSync(
      path.join(backupSetStoragePath(destination), ...managedKey.split('/')),
      'utf8',
    )).toBe(originalEvidence);
    expect(validation.tables).toContain('evidence');
    expect(fs.readdirSync(app.tmpDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(`${destination}-wal`)).toBe(false);
    expect(fs.existsSync(`${destination}-shm`)).toBe(false);
    expect(fs.readdirSync(app.tmpDir).filter(
      (name) => name.startsWith('complete.sqlite.') && name.includes('.tmp-'),
    )).toEqual([]);
  });

  it('refuses to overwrite any member of an existing backup set', async () => {
    const destination = path.join(app.tmpDir, 'no-overwrite.sqlite');
    await createBackupSet(destination, { desktopSecretsPath: secretsPath });

    await expect(createBackupSet(destination, { desktopSecretsPath: secretsPath }))
      .rejects.toThrow('Refusing to overwrite');

    const externalDestination = path.join(app.tmpDir, 'stale-sidecar.sqlite');
    fs.writeFileSync(backupSetSecretsPath(externalDestination), 'stale');
    await expect(createBackupSet(externalDestination, { externalJwtSecret: 'external-secret' }))
      .rejects.toThrow('Refusing to overwrite');
    await expect(createBackupSet(path.join(storagePath, 'unsafe-backup.sqlite'), {
      desktopSecretsPath: secretsPath,
    })).rejects.toThrow('inside the live local evidence directory');
  });

  it('detects database, secret, and evidence tampering before restore', async () => {
    const databaseTamper = path.join(app.tmpDir, 'database-tamper.sqlite');
    await createBackupSet(databaseTamper, { desktopSecretsPath: secretsPath });
    fs.appendFileSync(databaseTamper, 'tamper');
    expect(validateBackupSet(databaseTamper)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('database hash or size'),
    });

    const sidecarTamper = path.join(app.tmpDir, 'sidecar-tamper.sqlite');
    await createBackupSet(sidecarTamper, { desktopSecretsPath: secretsPath });
    fs.writeFileSync(`${sidecarTamper}-wal`, 'untracked transaction bytes');
    expect(validateBackupSet(sidecarTamper)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('untracked non-empty SQLite WAL sidecar'),
    });

    const secretTamper = path.join(app.tmpDir, 'secret-tamper.sqlite');
    await createBackupSet(secretTamper, { desktopSecretsPath: secretsPath });
    fs.appendFileSync(backupSetSecretsPath(secretTamper), 'tamper');
    expect(validateBackupSet(secretTamper)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('desktop-secret hash'),
    });

    const storageTamper = path.join(app.tmpDir, 'storage-tamper.sqlite');
    await createBackupSet(storageTamper, { desktopSecretsPath: secretsPath });
    fs.appendFileSync(
      path.join(backupSetStoragePath(storageTamper), ...managedKey.split('/')),
      'tamper',
    );
    expect(validateBackupSet(storageTamper)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('Local evidence inventory'),
    });
  });

  it('binds environment-managed backups to the intended JWT secret', async () => {
    const destination = path.join(app.tmpDir, 'external-secret.sqlite');
    const correctSecret = 'external-production-jwt-secret-with-high-entropy';
    await createBackupSet(destination, { externalJwtSecret: correctSecret });

    expect(fs.existsSync(backupSetSecretsPath(destination))).toBe(false);
    expect(validateBackupSet(destination, { externalJwtSecret: correctSecret }).valid).toBe(true);
    expect(validateBackupSet(destination, { externalJwtSecret: 'different-secret' })).toMatchObject({
      valid: false,
      reason: expect.stringContaining('incompatible'),
    });
    expect(() => restoreBackupSet(destination, {
      externalJwtSecret: correctSecret,
      desktopSecretsPath: secretsPath,
    })).toThrow('desktop profile with incompatible keys');
  });

  it('rejects an active environment key that would override bundled desktop secrets', async () => {
    const destination = path.join(app.tmpDir, 'desktop-env-conflict.sqlite');
    await createBackupSet(destination, { desktopSecretsPath: secretsPath });
    const secretsBefore = fs.readFileSync(secretsPath, 'utf8');

    expect(() => restoreBackupSet(destination, {
      desktopSecretsPath: secretsPath,
      externalJwtSecret: 'active-environment-secret-that-does-not-match',
    })).toThrow('active JWT_SECRET overrides its bundled key');
    expect(fs.readFileSync(secretsPath, 'utf8')).toBe(secretsBefore);
  });

  it('records S3 key inventory and rejects a different restore target', async () => {
    const destination = path.join(app.tmpDir, 'external-s3.sqlite');
    const previousBucket = process.env.AWS_S3_BUCKET;
    const previousRegion = process.env.AWS_S3_REGION;
    const jwtSecret = desktopSecrets().jwtSecret;
    try {
      process.env.AWS_S3_BUCKET = 'laro-evidence-backup-a';
      process.env.AWS_S3_REGION = 'eu-west-1';
      await createBackupSet(destination, { externalJwtSecret: jwtSecret });
      const validation = validateBackupSet(destination, { externalJwtSecret: jwtSecret });
      expect(validation.valid).toBe(true);
      expect(validation.storageCoverage).toBe('external-s3');
      expect(validation.manifest?.storage).toMatchObject({
        mode: 'external-s3',
        bucket: 'laro-evidence-backup-a',
        managedKeyCount: 1,
      });
      process.env.AWS_S3_BUCKET = 'laro-evidence-backup-b';
      expect(() => restoreBackupSet(destination, {
        externalJwtSecret: jwtSecret,
        desktopSecretsPath: secretsPath,
      })).toThrow('active S3 bucket or region differs');
    } finally {
      if (previousBucket === undefined) delete process.env.AWS_S3_BUCKET;
      else process.env.AWS_S3_BUCKET = previousBucket;
      if (previousRegion === undefined) delete process.env.AWS_S3_REGION;
      else process.env.AWS_S3_REGION = previousRegion;
    }
  });

  it('labels version-1 sets as missing storage coverage and requires an override', async () => {
    const destination = path.join(app.tmpDir, 'version-one.sqlite');
    await createBackupSet(destination, { desktopSecretsPath: secretsPath });
    const manifestPath = backupSetManifestPath(destination);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = 1;
    delete manifest.storage;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(validateBackupSet(destination)).toMatchObject({
      valid: true,
      storageCoverage: 'legacy-missing',
    });
    expect(() => restoreBackupSet(destination, { desktopSecretsPath: secretsPath }))
      .toThrow('local evidence coverage is not proven');
  });

  it('rechecks the staged database against its manifest before replacing live data', async () => {
    const destination = path.join(app.tmpDir, 'staged-database.sqlite');
    await createBackupSet(destination, { desktopSecretsPath: secretsPath });
    const manifest = JSON.parse(fs.readFileSync(backupSetManifestPath(destination), 'utf8'));
    const { restoreDatabase } = await import('../../server/backup');

    expect(() => restoreDatabase(destination, {
      bytes: manifest.database.bytes,
      sha256: '0'.repeat(64),
    })).toThrow('staged database does not match');
    expect((app.db as any).$client
      .prepare('SELECT id FROM users WHERE id = ?')
      .get('BACKUP_SET_MARKER')).toEqual({ id: 'BACKUP_SET_MARKER' });
  });

  it('aborts when referenced evidence is missing or changes during snapshot creation', async () => {
    const managedFilePath = path.join(storagePath, ...managedKey.split('/'));
    const heldPath = path.join(app.tmpDir, 'held-evidence.txt');
    const destination = path.join(app.tmpDir, 'missing-evidence.sqlite');
    fs.renameSync(managedFilePath, heldPath);
    try {
      await expect(createBackupSet(destination, { desktopSecretsPath: secretsPath }))
        .rejects.toThrow('missing 1 managed local evidence object');
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.existsSync(backupSetManifestPath(destination))).toBe(false);
      expect(fs.existsSync(backupSetStoragePath(destination))).toBe(false);
    } finally {
      fs.renameSync(heldPath, managedFilePath);
    }

    const source = path.join(app.tmpDir, 'changing-source');
    const snapshot = path.join(app.tmpDir, 'changing-snapshot');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'source.txt'), 'before');
    const manifest = createLocalStorageSnapshot(source, snapshot, 'published.files');
    fs.writeFileSync(path.join(source, 'source.txt'), 'after');
    expect(() => assertLocalStorageUnchanged(source, manifest.files))
      .toThrow('changed during database backup');
  });

  it('restores database, secrets, and evidence while preserving all previous state', async () => {
    const destination = path.join(app.tmpDir, 'restore.sqlite');
    const originalSecrets = fs.readFileSync(secretsPath, 'utf8');
    await createBackupSet(destination, { desktopSecretsPath: secretsPath });
    (app.db as any).$client.prepare('DELETE FROM users WHERE id = ?').run('BACKUP_SET_MARKER');
    fs.writeFileSync(secretsPath, JSON.stringify(desktopSecrets('3', '4'), null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(storagePath, ...managedKey.split('/')), 'changed evidence');

    const result = restoreBackupSet(destination, { desktopSecretsPath: secretsPath });
    const reopened = await (await import('../../server/db')).getDb();
    const marker = (reopened as any).$client
      .prepare('SELECT id FROM users WHERE id = ?')
      .get('BACKUP_SET_MARKER');

    expect(marker).toEqual({ id: 'BACKUP_SET_MARKER' });
    expect(fs.readFileSync(secretsPath, 'utf8')).toBe(originalSecrets);
    expect(fs.readFileSync(path.join(storagePath, ...managedKey.split('/')), 'utf8')).toBe(originalEvidence);
    expect(result.backupOfPreviousDatabase && fs.existsSync(result.backupOfPreviousDatabase)).toBe(true);
    expect(result.backupOfPreviousSecrets && fs.existsSync(result.backupOfPreviousSecrets)).toBe(true);
    expect(result.backupOfPreviousStorage && fs.existsSync(result.backupOfPreviousStorage)).toBe(true);
    expect(fs.readFileSync(
      path.join(result.backupOfPreviousStorage!, ...managedKey.split('/')),
      'utf8',
    )).toBe('changed evidence');
  });
});
