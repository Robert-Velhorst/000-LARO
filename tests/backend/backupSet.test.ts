import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
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

function bundledS3File(key: string): string {
  return path.join('objects', createHash('sha256').update(key).digest('hex'));
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
    expect(validation.manifest?.version).toBe(3);
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
    await expect(restoreBackupSet(destination, {
      externalJwtSecret: correctSecret,
      desktopSecretsPath: secretsPath,
    })).rejects.toThrow('desktop profile with incompatible keys');
  });

  it('rejects an active environment key that would override bundled desktop secrets', async () => {
    const destination = path.join(app.tmpDir, 'desktop-env-conflict.sqlite');
    await createBackupSet(destination, { desktopSecretsPath: secretsPath });
    const secretsBefore = fs.readFileSync(secretsPath, 'utf8');

    await expect(restoreBackupSet(destination, {
      desktopSecretsPath: secretsPath,
      externalJwtSecret: 'active-environment-secret-that-does-not-match',
    })).rejects.toThrow('active JWT_SECRET overrides its bundled key');
    expect(fs.readFileSync(secretsPath, 'utf8')).toBe(secretsBefore);
  });

  it('bundles and restores S3 evidence bytes and rejects a different restore target', async () => {
    const destination = path.join(app.tmpDir, 'external-s3.sqlite');
    const previousBucket = process.env.AWS_S3_BUCKET;
    const previousRegion = process.env.AWS_S3_REGION;
    const jwtSecret = desktopSecrets().jwtSecret;
    const objects = new Map([[managedKey, Buffer.from(originalEvidence)]]);
    try {
      process.env.AWS_S3_BUCKET = 'laro-evidence-backup-a';
      process.env.AWS_S3_REGION = 'eu-west-1';
      await createBackupSet(destination, {
        externalJwtSecret: jwtSecret,
        externalStorageRead: async (key) => {
          const value = objects.get(key);
          if (!value) throw new Error(`missing ${key}`);
          return Buffer.from(value);
        },
      });
      const validation = validateBackupSet(destination, { externalJwtSecret: jwtSecret });
      expect(validation.valid).toBe(true);
      expect(validation.storageCoverage).toBe('complete-s3');
      expect(validation.manifest?.storage).toMatchObject({
        mode: 'bundled-s3',
        bucket: 'laro-evidence-backup-a',
        fileCount: 1,
      });
      const bundledObject = path.join(backupSetStoragePath(destination), bundledS3File(managedKey));
      expect(fs.readFileSync(bundledObject, 'utf8')).toBe(originalEvidence);
      fs.appendFileSync(bundledObject, 'tamper');
      expect(validateBackupSet(destination, { externalJwtSecret: jwtSecret })).toMatchObject({
        valid: false,
        reason: expect.stringContaining('Bundled S3 evidence inventory'),
      });
      fs.writeFileSync(bundledObject, originalEvidence);
      expect(validateBackupSet(destination, { externalJwtSecret: jwtSecret }).valid).toBe(true);

      process.env.AWS_S3_BUCKET = 'laro-evidence-backup-b';
      await expect(restoreBackupSet(destination, {
        externalJwtSecret: jwtSecret,
        desktopSecretsPath: secretsPath,
      })).rejects.toThrow('active S3 bucket or region differs');

      process.env.AWS_S3_BUCKET = 'laro-evidence-backup-a';
      objects.set(managedKey, Buffer.from('changed remote evidence'));
      const restored = await restoreBackupSet(destination, {
        externalJwtSecret: jwtSecret,
        desktopSecretsPath: secretsPath,
        externalStorageRead: async (key) => {
          const value = objects.get(key);
          if (!value) throw new Error(`missing ${key}`);
          return Buffer.from(value);
        },
        externalStoragePut: async (key, body) => {
          objects.set(key, Buffer.from(body));
          return { sha256: (await import('../../server/storage')).hashBuffer(body) };
        },
        externalStorageDelete: async (key) => { objects.delete(key); },
      });
      app.db = await (await import('../../server/db')).getDb();
      expect(objects.get(managedKey)?.toString('utf8')).toBe(originalEvidence);
      expect(restored.backupOfPreviousStorage).toBeTruthy();
      expect(fs.readFileSync(
        path.join(restored.backupOfPreviousStorage!, bundledS3File(managedKey)),
        'utf8',
      )).toBe('changed remote evidence');
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
    await expect(restoreBackupSet(destination, { desktopSecretsPath: secretsPath }))
      .rejects.toThrow('evidence coverage is not proven');
  });

  it('does not publish an S3 backup set when referenced bytes are unavailable', async () => {
    const destination = path.join(app.tmpDir, 'missing-s3-evidence.sqlite');
    const previousBucket = process.env.AWS_S3_BUCKET;
    try {
      process.env.AWS_S3_BUCKET = 'laro-evidence-backup-a';
      await expect(createBackupSet(destination, {
        externalJwtSecret: desktopSecrets().jwtSecret,
        externalStorageRead: async (key) => { throw new Error(`missing remote object ${key}`); },
      })).rejects.toThrow('missing remote object');
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.existsSync(backupSetManifestPath(destination))).toBe(false);
      expect(fs.existsSync(backupSetStoragePath(destination))).toBe(false);
    } finally {
      if (previousBucket === undefined) delete process.env.AWS_S3_BUCKET;
      else process.env.AWS_S3_BUCKET = previousBucket;
    }
  });

  it('stores Windows-hostile S3 keys under portable content-addressed filenames', async () => {
    const destination = path.join(app.tmpDir, 'portable-s3-key.sqlite');
    const hostileKey = 'evidence/backup-set/2026-08-22T12:00?.txt';
    const previousBucket = process.env.AWS_S3_BUCKET;
    try {
      (app.db as any).$client.prepare(`
        INSERT INTO evidence_files (id, userId, fileName, fileType, fileSize, storageKey)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'BACKUP_SET_HOSTILE_KEY',
        'BACKUP_SET_MARKER',
        'hostile-key.txt',
        'text/plain',
        '14',
        hostileKey,
      );
      process.env.AWS_S3_BUCKET = 'laro-evidence-backup-a';
      const objects = new Map([
        [managedKey, Buffer.from(originalEvidence)],
        [hostileKey, Buffer.from('portable bytes')],
      ]);
      await createBackupSet(destination, {
        externalJwtSecret: desktopSecrets().jwtSecret,
        externalStorageRead: async (key) => Buffer.from(objects.get(key)!),
      });
      const validation = validateBackupSet(destination, {
        externalJwtSecret: desktopSecrets().jwtSecret,
      });
      expect(validation.valid).toBe(true);
      const storage = validation.manifest?.storage;
      expect(storage?.mode).toBe('bundled-s3');
      if (storage?.mode !== 'bundled-s3') throw new Error('Expected bundled S3 storage');
      const hostileObject = storage.objects.find((entry) => entry.key === hostileKey);
      expect(hostileObject?.file).toMatch(/^objects\/[a-f0-9]{64}$/);
      expect(fs.readFileSync(
        path.join(backupSetStoragePath(destination), ...hostileObject!.file.split('/')),
        'utf8',
      )).toBe('portable bytes');
    } finally {
      (app.db as any).$client.prepare('DELETE FROM evidence_files WHERE id = ?')
        .run('BACKUP_SET_HOSTILE_KEY');
      if (previousBucket === undefined) delete process.env.AWS_S3_BUCKET;
      else process.env.AWS_S3_BUCKET = previousBucket;
    }
  });

  it('labels version-2 S3 inventories as incomplete and blocks restore by default', async () => {
    const destination = path.join(app.tmpDir, 'version-two-s3.sqlite');
    await createBackupSet(destination, { desktopSecretsPath: secretsPath });
    const manifestPath = backupSetManifestPath(destination);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.version = 2;
    manifest.storage = {
      mode: 'external-s3',
      bucket: 'legacy-inventory-only',
      region: 'eu-west-1',
      managedKeyCount: 1,
      managedKeysSha256: createHash('sha256').update(JSON.stringify([managedKey])).digest('hex'),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    fs.rmSync(backupSetStoragePath(destination), { recursive: true, force: true });

    expect(validateBackupSet(destination)).toMatchObject({
      valid: true,
      storageCoverage: 'legacy-external-s3',
    });
    await expect(restoreBackupSet(destination, { desktopSecretsPath: secretsPath }))
      .rejects.toThrow('evidence coverage is not proven');
  });

  it('rolls back a newly introduced S3 object when restore verification fails', async () => {
    const destination = path.join(app.tmpDir, 's3-rollback.sqlite');
    const previousBucket = process.env.AWS_S3_BUCKET;
    const previousRegion = process.env.AWS_S3_REGION;
    const jwtSecret = desktopSecrets().jwtSecret;
    const objects = new Map([[managedKey, Buffer.from(originalEvidence)]]);
    try {
      process.env.AWS_S3_BUCKET = 'laro-evidence-backup-a';
      process.env.AWS_S3_REGION = 'eu-west-1';
      const read = async (key: string) => {
        const value = objects.get(key);
        if (!value) throw new Error(`missing ${key}`);
        return Buffer.from(value);
      };
      await createBackupSet(destination, {
        externalJwtSecret: jwtSecret,
        externalStorageRead: read,
      });

      (app.db as any).$client.prepare('DELETE FROM evidence_files WHERE id = ?')
        .run('BACKUP_SET_EVIDENCE');
      objects.delete(managedKey);
      for (const failure of ['hash-mismatch', 'acknowledgement-loss', 'remote-corruption'] as const) {
        let writes = 0;
        await expect(restoreBackupSet(destination, {
          externalJwtSecret: jwtSecret,
          desktopSecretsPath: secretsPath,
          externalStorageRead: read,
          externalStoragePut: async (key, body) => {
            writes += 1;
            objects.set(key, Buffer.from(body));
            if (failure === 'acknowledgement-loss') {
              throw new Error('simulated acknowledgement loss after remote write');
            }
            if (failure === 'remote-corruption') {
              objects.set(key, Buffer.from('corrupted after upload'));
              return { sha256: (await import('../../server/storage')).hashBuffer(body) };
            }
            return { sha256: '0'.repeat(64) };
          },
          externalStorageDelete: async (key) => { objects.delete(key); },
        })).rejects.toThrow(
          failure === 'hash-mismatch'
            ? 'hash does not match'
            : failure === 'acknowledgement-loss' ? 'acknowledgement loss' : 'read-back hash',
        );
        expect(writes).toBe(1);
        expect(objects.has(managedKey)).toBe(false);
      }
    } finally {
      if (previousBucket === undefined) delete process.env.AWS_S3_BUCKET;
      else process.env.AWS_S3_BUCKET = previousBucket;
      if (previousRegion === undefined) delete process.env.AWS_S3_REGION;
      else process.env.AWS_S3_REGION = previousRegion;
      app.db = await (await import('../../server/db')).getDb();
      (app.db as any).$client.prepare(`
        INSERT OR IGNORE INTO evidence_files
          (id, userId, fileName, fileType, fileSize, storageKey)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        'BACKUP_SET_EVIDENCE',
        'BACKUP_SET_MARKER',
        'source.txt',
        'text/plain',
        String(Buffer.byteLength(originalEvidence)),
        managedKey,
      );
    }
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

    const result = await restoreBackupSet(destination, { desktopSecretsPath: secretsPath });
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
