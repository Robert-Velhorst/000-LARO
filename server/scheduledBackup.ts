import fs from 'fs';
import path from 'path';
import {
  backupSetManifestPath,
  backupSetSecretsPath,
  createBackupSet,
  validateBackupSet,
  type BackupSetValidation,
} from './backupSet';
import { backupSetStoragePath } from './backupStorage';

export type BackupDestinationKind = 'local' | 'synced' | 'network';

export interface ScheduledBackupConfig {
  directory: string;
  destinationKind: BackupDestinationKind;
  retentionCount: number;
  retentionDays: number;
  maxAgeHours: number;
}

export interface ScheduledBackupHealth {
  configured: boolean;
  status: 'not_configured' | 'healthy' | 'stale' | 'failed' | 'pending';
  destinationKind: BackupDestinationKind | null;
  latestValidAt: string | null;
  ageHours: number | null;
  maxAgeHours: number | null;
  retentionCount: number | null;
  retentionDays: number | null;
}

interface ValidBackup {
  databasePath: string;
  createdAt: string;
  validation: BackupSetValidation;
}

const BACKUP_FILE_PATTERN = /^laro-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.sqlite$/;
const MAX_BACKUP_CANDIDATES = 120;
const MAX_BACKUP_DATABASE_BYTES = 20 * 1024 * 1024 * 1024;
let inFlight: Promise<void> | null = null;
let latestValidAt: string | null = null;
let lastError: string | null = null;

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function readScheduledBackupConfig(env: NodeJS.ProcessEnv = process.env): ScheduledBackupConfig | null {
  const configuredDirectory = env.LARO_BACKUP_DIRECTORY?.trim();
  if (!configuredDirectory) return null;
  const rawKind = (env.LARO_BACKUP_DESTINATION_KIND || 'local').trim().toLowerCase();
  if (!['local', 'synced', 'network'].includes(rawKind)) {
    throw new Error('LARO_BACKUP_DESTINATION_KIND must be local, synced, or network.');
  }
  return {
    directory: path.resolve(configuredDirectory),
    destinationKind: rawKind as BackupDestinationKind,
    retentionCount: boundedInteger(env.LARO_BACKUP_RETENTION_COUNT, 14, 2, 60, 'LARO_BACKUP_RETENTION_COUNT'),
    retentionDays: boundedInteger(env.LARO_BACKUP_RETENTION_DAYS, 30, 1, 365, 'LARO_BACKUP_RETENTION_DAYS'),
    maxAgeHours: boundedInteger(env.LARO_BACKUP_MAX_AGE_HOURS, 30, 6, 168, 'LARO_BACKUP_MAX_AGE_HOURS'),
  };
}

function scheduledCandidates(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  const candidates = fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_FILE_PATTERN.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  if (candidates.length > MAX_BACKUP_CANDIDATES) {
    throw new Error(`Backup inventory exceeds the ${MAX_BACKUP_CANDIDATES}-file validation limit.`);
  }
  return candidates;
}

function validBackups(config: ScheduledBackupConfig): ValidBackup[] {
  return scheduledCandidates(config.directory).flatMap((databasePath) => {
    if (fs.statSync(databasePath).size > MAX_BACKUP_DATABASE_BYTES) {
      throw new Error('Backup candidate exceeds the validation size limit.');
    }
    const validation = validateBackupSet(databasePath);
    const createdAt = validation.manifest?.createdAt;
    return validation.valid && createdAt
      ? [{ databasePath, createdAt, validation }]
      : [];
  }).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function deleteBackupSet(backup: ValidBackup): void {
  fs.rmSync(backup.databasePath, { force: true });
  fs.rmSync(backupSetManifestPath(backup.databasePath), { force: true });
  fs.rmSync(backupSetSecretsPath(backup.databasePath), { force: true });
  fs.rmSync(backupSetStoragePath(backup.databasePath), { recursive: true, force: true });
}

function enforceRetention(config: ScheduledBackupConfig, backups: ValidBackup[]): number {
  const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1_000;
  const expired = backups.filter((backup, index) => (
    index >= config.retentionCount || Date.parse(backup.createdAt) < cutoff
  ));
  for (const backup of expired) deleteBackupSet(backup);
  return expired.length;
}

export function refreshScheduledBackupState(config = readScheduledBackupConfig()): ScheduledBackupHealth {
  if (!config) {
    latestValidAt = null;
    lastError = null;
    return getScheduledBackupHealth(null);
  }
  try {
    const backups = validBackups(config);
    enforceRetention(config, backups);
    const latest = backups.find((backup) => fs.existsSync(backup.databasePath));
    latestValidAt = latest?.createdAt || null;
    lastError = null;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error('[ScheduledBackup] Validation failed:', error);
  }
  return getScheduledBackupHealth(config);
}

async function executeScheduledBackup(config: ScheduledBackupConfig): Promise<void> {
  fs.mkdirSync(config.directory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nonce = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
  const destination = path.join(config.directory, `laro-${timestamp}-${nonce}.sqlite`);
  try {
    await createBackupSet(destination);
    const validation = validateBackupSet(destination);
    if (!validation.valid || !validation.manifest) {
      throw new Error(`Scheduled backup validation failed: ${validation.reason || 'unknown reason'}`);
    }
    latestValidAt = validation.manifest.createdAt;
    lastError = null;
    enforceRetention(config, validBackups(config));
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export function runScheduledBackup(config = readScheduledBackupConfig()): Promise<void> {
  if (!config) return Promise.resolve();
  if (inFlight) return inFlight;
  inFlight = executeScheduledBackup(config).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function getScheduledBackupHealth(config = readScheduledBackupConfig()): ScheduledBackupHealth {
  if (!config) {
    return {
      configured: false,
      status: 'not_configured',
      destinationKind: null,
      latestValidAt: null,
      ageHours: null,
      maxAgeHours: null,
      retentionCount: null,
      retentionDays: null,
    };
  }
  const ageHours = latestValidAt
    ? Math.max(0, (Date.now() - Date.parse(latestValidAt)) / 3_600_000)
    : null;
  const status = lastError
    ? 'failed'
    : ageHours === null
      ? 'pending'
      : ageHours > config.maxAgeHours ? 'stale' : 'healthy';
  return {
    configured: true,
    status,
    destinationKind: config.destinationKind,
    latestValidAt,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    maxAgeHours: config.maxAgeHours,
    retentionCount: config.retentionCount,
    retentionDays: config.retentionDays,
  };
}
