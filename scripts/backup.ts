import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { restoreDatabase, validateBackup } from '../server/backup';
import {
  backupSetManifestPath,
  createBackupSet,
  restoreBackupSet,
  validateBackupSet,
} from '../server/backupSet';
import { parseBackupArguments } from './backupArguments';

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseBackupArguments(args);
  const commandOrDest = parsed.commandOrDestination;
  const file = parsed.file;
  const desktopSecretsPath = parsed.desktopSecretsPath || process.env.LARO_DESKTOP_SECRETS_PATH;
  const localStoragePath = parsed.localStoragePath || process.env.LARO_LOCAL_STORAGE_PATH;

  if (commandOrDest === '--restore') {
    if (!file) throw new Error('Usage: npm run db:restore -- <backup.sqlite>');
    if (fs.existsSync(backupSetManifestPath(file))) {
      const result = await restoreBackupSet(file, {
        desktopSecretsPath,
        localStoragePath,
        allowMissingStorage: parsed.allowMissingStorage,
      });
      console.log(`[Restore] Restored verified backup set ${path.resolve(file)}.`);
      console.log(`[Restore] Previous database: ${result.backupOfPreviousDatabase || 'none'}`);
      console.log(`[Restore] Previous desktop secrets: ${result.backupOfPreviousSecrets || 'none'}`);
      console.log(`[Restore] Previous local evidence: ${result.backupOfPreviousStorage || 'none'}`);
      return;
    }
    if (!parsed.allowLegacy) {
      throw new Error(
        'Refusing a database-only restore because encryption-key compatibility cannot be proven. ' +
          'Use a backup set or pass --allow-legacy after manually verifying the matching secrets.',
      );
    }
    const result = restoreDatabase(file);
    console.warn('[Restore] WARNING: restoring legacy database-only backup by explicit operator override.');
    console.log(`[Restore] Restored ${path.resolve(file)}.`);
    console.log(`[Restore] Previous database: ${result.backupOfPrevious || 'none'}`);
    return;
  }

  if (commandOrDest === '--validate') {
    if (!file) throw new Error('Usage: npm run db:validate -- <backup.sqlite>');
    if (fs.existsSync(backupSetManifestPath(file))) {
      const result = validateBackupSet(file);
      if (!result.valid) throw new Error(`Invalid backup set: ${result.reason}`);
      if (result.storageCoverage === 'legacy-missing' || result.storageCoverage === 'legacy-external-s3') {
        console.warn(
          `[Validate] Version-1 backup set is structurally valid with ${result.tables?.length || 0} tables, ` +
            'but complete evidence coverage is not proven.',
        );
      } else {
        console.log(
          `[Validate] Valid backup set with ${result.tables?.length || 0} tables and ` +
            `${result.storageCoverage === 'complete-local' ? 'complete local evidence' : 'complete bundled S3 evidence'}.`,
        );
      }
      return;
    }
    const result = validateBackup(file);
    if (!result.valid) throw new Error(`Invalid backup: ${result.reason}`);
    console.warn(
      `[Validate] Legacy SQLite backup is structurally valid with ${result.tables?.length || 0} tables, ` +
        'but encryption-key compatibility is not proven.',
    );
    return;
  }

  const dbPath = path.resolve(process.env.DATABASE_URL || 'laro.sqlite');
  const destination = commandOrDest || path.join(
    path.dirname(dbPath),
    'db-backups',
    `${path.basename(dbPath)}.${timestamp()}.bak`,
  );
  const result = await createBackupSet(destination, { desktopSecretsPath, localStoragePath });
  console.log(`[Backup] Wrote ${result.bytes} database bytes to ${result.databasePath}`);
  console.log(`[Backup] Recovery manifest: ${result.manifestPath}`);
  console.log(`[Backup] Desktop secrets: ${result.secretsPath || 'external environment; retain JWT_SECRET separately'}`);
  console.log(`[Backup] Evidence snapshot: ${result.storagePath || 'not bundled'}`);
}

main().catch((error) => {
  console.error('[Database maintenance] Failed:', error);
  process.exitCode = 1;
});
