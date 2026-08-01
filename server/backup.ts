import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";
import { closeDatabaseForMaintenance, getDb } from "./db";

const REQUIRED_TABLES = ["users", "lawyers", "cases", "evidence", "audit_logs", "system_config"];

function rawClient(db: any): any {
  return db?.$client ?? db?.session?.client ?? null;
}

function currentDbPath(): string {
  return process.env.DATABASE_URL || "laro.sqlite";
}

export function cleanupBackupDatabaseSidecars(databasePath: string): void {
  const source = path.resolve(databasePath);
  for (const extension of ["-wal", "-shm"]) {
    try {
      if (fs.existsSync(source + extension)) fs.unlinkSync(source + extension);
    } catch {
      // The validation result remains authoritative; cleanup is best effort.
    }
  }
}

export function prepareBackupDatabaseRead(databasePath: string): void {
  const source = path.resolve(databasePath);
  const walPath = source + "-wal";
  if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
    throw new Error("Backup database has an untracked non-empty SQLite WAL sidecar.");
  }
  cleanupBackupDatabaseSidecars(source);
}

/** Create and verify a consistent online backup of the live database. */
export async function backupDatabase(destPath: string): Promise<{ path: string; bytes: number }> {
  const db = await getDb();
  const sqlite = rawClient(db);
  if (!sqlite) throw new Error("Database not available for backup");

  const destination = path.resolve(destPath);
  if (destination === path.resolve(currentDbPath())) {
    throw new Error("Refusing to back up the database over itself");
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  await sqlite.backup(destination);
  const validation = validateBackup(destination);
  if (!validation.valid) {
    try { fs.unlinkSync(destination); } catch { /* preserve the validation error */ }
    throw new Error(`Backup verification failed: ${validation.reason}`);
  }
  return { path: destination, bytes: fs.statSync(destination).size };
}

/** Validate SQLite integrity, foreign keys, and the minimum LARO schema. */
export function validateBackup(srcPath: string): { valid: boolean; reason?: string; tables?: string[] } {
  const source = path.resolve(srcPath);
  if (!fs.existsSync(source)) return { valid: false, reason: "File does not exist" };
  const isLiveDatabase = source === path.resolve(currentDbPath());

  let probe: InstanceType<typeof Database> | null = null;
  try {
    if (!isLiveDatabase) prepareBackupDatabaseRead(source);
    probe = new Database(source, { readonly: true, fileMustExist: true });
    const integrity = probe.pragma("quick_check") as Array<{ quick_check: string }>;
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      return { valid: false, reason: `SQLite quick_check failed: ${JSON.stringify(integrity)}` };
    }

    const foreignKeyErrors = probe.pragma("foreign_key_check") as unknown[];
    if (foreignKeyErrors.length > 0) {
      return { valid: false, reason: `Foreign-key check found ${foreignKeyErrors.length} violation(s)` };
    }

    const rows = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    const missing = REQUIRED_TABLES.filter((table) => !names.includes(table));
    if (missing.length > 0) {
      return { valid: false, reason: `Missing core tables: ${missing.join(", ")}`, tables: names };
    }
    return { valid: true, tables: names };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    try { probe?.close(); } catch { /* best effort */ }
    if (!isLiveDatabase) cleanupBackupDatabaseSidecars(source);
  }
}

/**
 * Restore a verified backup through a staged file in the live DB directory.
 * The current connection is checkpointed and closed, the previous DB is moved
 * aside, and a failed replacement is rolled back before the error is returned.
 */
export function restoreDatabase(
  srcPath: string,
  expected?: { bytes: number; sha256: string },
): { restored: true; backupOfPrevious: string | null } {
  const source = path.resolve(srcPath);
  const live = path.resolve(currentDbPath());
  if (source === live) throw new Error("Refusing to restore a database over itself");

  const check = validateBackup(source);
  if (!check.valid) throw new Error(`Refusing to restore: ${check.reason}`);

  fs.mkdirSync(path.dirname(live), { recursive: true });
  const staged = `${live}.restore-${process.pid}-${Date.now()}.tmp`;
  const previous = `${live}.bak-${Date.now()}`;
  fs.copyFileSync(source, staged);

  if (expected) {
    const stagedStat = fs.statSync(staged);
    const stagedHash = crypto.createHash("sha256").update(fs.readFileSync(staged)).digest("hex");
    if (stagedStat.size !== expected.bytes || stagedHash !== expected.sha256) {
      try { fs.unlinkSync(staged); } catch { /* preserve the verification error */ }
      throw new Error("Refusing to restore: staged database does not match the backup-set manifest");
    }
  }

  const stagedCheck = validateBackup(staged);
  if (!stagedCheck.valid) {
    try { fs.unlinkSync(staged); } catch { /* best effort */ }
    throw new Error(`Refusing to restore staged copy: ${stagedCheck.reason}`);
  }

  closeDatabaseForMaintenance();
  for (const extension of ["-wal", "-shm"]) {
    try { if (fs.existsSync(live + extension)) fs.unlinkSync(live + extension); } catch { /* best effort */ }
  }

  const hadLiveDatabase = fs.existsSync(live);
  try {
    if (hadLiveDatabase) fs.renameSync(live, previous);
    fs.renameSync(staged, live);
  } catch (error) {
    try {
      if (!fs.existsSync(live) && fs.existsSync(previous)) fs.renameSync(previous, live);
    } catch { /* leave both paths in place for manual recovery */ }
    try { if (fs.existsSync(staged)) fs.unlinkSync(staged); } catch { /* best effort */ }
    throw error;
  }

  return { restored: true, backupOfPrevious: hadLiveDatabase ? previous : null };
}
