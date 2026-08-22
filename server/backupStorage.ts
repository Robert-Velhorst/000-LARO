import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { cleanupBackupDatabaseSidecars, prepareBackupDatabaseRead } from "./backup";
import { collectManagedStorageKeys } from "./managedStorage";
import { sanitizeStorageKey } from "./storage";

export interface LocalStorageFileManifest {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BundledLocalStorageManifest {
  mode: "bundled-local";
  directory: string;
  fileCount: number;
  totalBytes: number;
  files: LocalStorageFileManifest[];
}

export interface ExternalS3StorageManifest {
  mode: "external-s3";
  bucket: string;
  region: string;
  managedKeyCount: number;
  managedKeysSha256: string;
}

export interface BundledS3StorageManifest {
  mode: "bundled-s3";
  bucket: string;
  region: string;
  directory: string;
  fileCount: number;
  totalBytes: number;
  objects: Array<{
    key: string;
    file: string;
    bytes: number;
    sha256: string;
    contentType: string;
  }>;
}

export type BackupStorageManifest =
  | BundledLocalStorageManifest
  | BundledS3StorageManifest
  | ExternalS3StorageManifest;

export const MAX_BACKUP_STORAGE_OBJECT_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_STORAGE_FILES = 100_000;
const MAX_BACKUP_STORAGE_TOTAL_BYTES = 100 * 1024 * 1024 * 1024;

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function isBackupStorageManifest(value: unknown): value is BackupStorageManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.mode === "external-s3") {
    return (
      typeof candidate.bucket === "string" && !!candidate.bucket &&
      typeof candidate.region === "string" && !!candidate.region &&
      Number.isSafeInteger(candidate.managedKeyCount) && Number(candidate.managedKeyCount) >= 0 &&
      isHexDigest(candidate.managedKeysSha256)
    );
  }
  if (candidate.mode === "bundled-s3") {
    if (
      typeof candidate.bucket !== "string" || !candidate.bucket ||
      typeof candidate.region !== "string" || !candidate.region ||
      typeof candidate.directory !== "string" || !candidate.directory ||
      !Number.isSafeInteger(candidate.fileCount) || Number(candidate.fileCount) < 0 ||
      !Number.isSafeInteger(candidate.totalBytes) || Number(candidate.totalBytes) < 0 ||
      !Array.isArray(candidate.objects) || candidate.objects.length !== candidate.fileCount
    ) return false;
    const keys = new Set<string>();
    const files = new Set<string>();
    for (const value of candidate.objects) {
      if (!value || typeof value !== "object") return false;
      const entry = value as Record<string, unknown>;
      if (
        typeof entry.key !== "string" || !entry.key ||
        sanitizeStorageKey(entry.key) !== entry.key ||
        typeof entry.file !== "string" || !isSafeRelativePath(entry.file) ||
        !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 ||
        !isHexDigest(entry.sha256) ||
        typeof entry.contentType !== "string" || !entry.contentType ||
        entry.contentType.length > 255 || /[\x00-\x1f\x7f]/.test(entry.contentType) ||
        keys.has(entry.key) || files.has(entry.file)
      ) return false;
      keys.add(entry.key);
      files.add(entry.file);
    }
    return true;
  }
  if (candidate.mode !== "bundled-local") return false;
  if (
    typeof candidate.directory !== "string" || !candidate.directory ||
    !Number.isSafeInteger(candidate.fileCount) || Number(candidate.fileCount) < 0 ||
    !Number.isSafeInteger(candidate.totalBytes) || Number(candidate.totalBytes) < 0 ||
    !Array.isArray(candidate.files) || candidate.files.length !== candidate.fileCount
  ) return false;
  return candidate.files.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const file = entry as Record<string, unknown>;
    return (
      typeof file.path === "string" && isSafeRelativePath(file.path) &&
      Number.isSafeInteger(file.bytes) && Number(file.bytes) >= 0 &&
      isHexDigest(file.sha256)
    );
  });
}

export function backupSetStoragePath(databaseBackupPath: string): string {
  return `${path.resolve(databaseBackupPath)}.files`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashFile(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isSafeRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes("\\") || /[\x00-\x1f\x7f]/.test(relativePath)) return false;
  if (path.posix.isAbsolute(relativePath)) return false;
  const segments = relativePath.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function resolveInside(rootPath: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe storage path: ${relativePath}`);
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Storage path escapes its backup root: ${relativePath}`);
  }
  return resolved;
}

function listStorageFiles(rootPath: string): LocalStorageFileManifest[] {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) return [];
  if (!fs.statSync(root).isDirectory()) throw new Error(`Local storage root is not a directory: ${root}`);
  const files: LocalStorageFileManifest[] = [];

  const walk = (directory: string, relativeDirectory: string): void => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? path.posix.join(relativeDirectory, entry.name)
        : entry.name;
      const fullPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`Local storage contains a symbolic link: ${relativePath}`);
      if (stat.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (stat.isFile()) {
        if (!isSafeRelativePath(relativePath)) throw new Error(`Unsafe local storage path: ${relativePath}`);
        files.push({ path: relativePath, bytes: stat.size, sha256: hashFile(fullPath) });
      } else {
        throw new Error(`Local storage contains an unsupported filesystem entry: ${relativePath}`);
      }
    }
  };

  walk(root, "");
  return files.sort((left, right) => compareText(left.path, right.path));
}

function sameFiles(left: LocalStorageFileManifest[], right: LocalStorageFileManifest[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function managedStorageKeys(databasePath: string): string[] {
  const resolvedDatabasePath = path.resolve(databasePath);
  prepareBackupDatabaseRead(resolvedDatabasePath);
  const database = new Database(resolvedDatabasePath, { readonly: true, fileMustExist: true });
  try {
    return collectManagedStorageKeys(database, {})
      .map((key) => {
        const normalized = key.replace(/\\/g, "/");
        const sanitized = sanitizeStorageKey(key);
        if (!sanitized || sanitized !== normalized || !isSafeRelativePath(sanitized)) {
          throw new Error(`Database contains an unsafe managed storage key: ${key}`);
        }
        return sanitized;
      })
      .sort(compareText);
  } finally {
    database.close();
    cleanupBackupDatabaseSidecars(resolvedDatabasePath);
  }
}

function managedKeysHash(keys: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(keys)).digest("hex");
}

export function createLocalStorageSnapshot(
  sourceRootPath: string,
  temporarySnapshotPath: string,
  publishedDirectoryName: string,
): BundledLocalStorageManifest {
  const sourceRoot = path.resolve(sourceRootPath);
  const snapshotRoot = path.resolve(temporarySnapshotPath);
  const sourceFiles = listStorageFiles(sourceRoot);
  fs.mkdirSync(snapshotRoot, { recursive: false });

  for (const entry of sourceFiles) {
    const source = resolveInside(sourceRoot, entry.path);
    const destination = resolveInside(snapshotRoot, entry.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }

  const copiedFiles = listStorageFiles(snapshotRoot);
  if (!sameFiles(sourceFiles, copiedFiles)) {
    throw new Error("Local evidence changed while its backup snapshot was being copied.");
  }
  return {
    mode: "bundled-local",
    directory: publishedDirectoryName,
    fileCount: copiedFiles.length,
    totalBytes: copiedFiles.reduce((total, entry) => total + entry.bytes, 0),
    files: copiedFiles,
  };
}

export function assertLocalStorageUnchanged(
  sourceRootPath: string,
  expectedFiles: LocalStorageFileManifest[],
): void {
  if (!sameFiles(listStorageFiles(sourceRootPath), expectedFiles)) {
    throw new Error("Local evidence changed during database backup; no backup set was published.");
  }
}

export function createExternalS3Manifest(
  databasePath: string,
  bucket: string,
  region: string,
): ExternalS3StorageManifest {
  const keys = managedStorageKeys(databasePath);
  return {
    mode: "external-s3",
    bucket,
    region,
    managedKeyCount: keys.length,
    managedKeysSha256: managedKeysHash(keys),
  };
}

export async function createS3StorageSnapshot(
  databasePath: string,
  temporarySnapshotPath: string,
  publishedDirectoryName: string,
  bucket: string,
  region: string,
  readObject: (
    key: string,
    options: { maxBytes: number },
  ) => Promise<{ body: Buffer; contentType: string }>,
): Promise<BundledS3StorageManifest> {
  const keys = managedStorageKeys(databasePath);
  if (keys.length > MAX_BACKUP_STORAGE_FILES) {
    throw new Error(`S3 evidence inventory exceeds the ${MAX_BACKUP_STORAGE_FILES}-object backup limit.`);
  }
  const snapshotRoot = path.resolve(temporarySnapshotPath);
  fs.mkdirSync(snapshotRoot, { recursive: false });
  let totalBytes = 0;
  const objects: BundledS3StorageManifest["objects"] = [];
  for (const key of keys) {
    const snapshot = await readObject(key, { maxBytes: MAX_BACKUP_STORAGE_OBJECT_BYTES });
    const body = snapshot?.body;
    if (!Buffer.isBuffer(body)) throw new Error(`S3 evidence reader returned invalid bytes for: ${key}`);
    const contentType = snapshot.contentType?.trim() || "application/octet-stream";
    if (contentType.length > 255 || /[\x00-\x1f\x7f]/.test(contentType)) {
      throw new Error(`S3 evidence has an invalid content type: ${key}`);
    }
    totalBytes += body.length;
    if (totalBytes > MAX_BACKUP_STORAGE_TOTAL_BYTES) {
      throw new Error("S3 evidence snapshot exceeds the 100 GB backup-set limit.");
    }
    const file = `objects/${crypto.createHash("sha256").update(key).digest("hex")}`;
    const destination = resolveInside(snapshotRoot, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, body, { flag: "wx", mode: 0o600 });
    objects.push({
      key,
      file,
      bytes: body.length,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
      contentType,
    });
  }
  const files = listStorageFiles(snapshotRoot);
  const expectedFiles = objects
    .map((entry) => ({ path: entry.file, bytes: entry.bytes, sha256: entry.sha256 }))
    .sort((left, right) => compareText(left.path, right.path));
  if (!sameFiles(files, expectedFiles)) {
    throw new Error("S3 evidence snapshot does not match the backup database key inventory.");
  }
  return {
    mode: "bundled-s3",
    bucket,
    region,
    directory: publishedDirectoryName,
    fileCount: objects.length,
    totalBytes,
    objects,
  };
}

export function validateBackupStorage(
  databasePath: string,
  storagePath: string,
  manifest: BackupStorageManifest,
  expectedPublishedDirectoryName = path.basename(storagePath),
): { valid: boolean; reason?: string } {
  try {
    const keys = managedStorageKeys(databasePath);
    if (manifest.mode === "external-s3") {
      if (!manifest.bucket || !manifest.region) {
        return { valid: false, reason: "External S3 storage metadata is incomplete." };
      }
      if (
        manifest.managedKeyCount !== keys.length ||
        manifest.managedKeysSha256 !== managedKeysHash(keys)
      ) {
        return { valid: false, reason: "External S3 key inventory does not match the backup database." };
      }
      return { valid: true };
    }

    if (manifest.mode === "bundled-s3") {
      if (manifest.directory !== expectedPublishedDirectoryName) {
        return { valid: false, reason: "Bundled S3 evidence directory does not match its manifest." };
      }
      const objectKeys = manifest.objects.map((entry) => entry.key).sort(compareText);
      if (JSON.stringify(objectKeys) !== JSON.stringify(keys)) {
        return { valid: false, reason: "Bundled S3 key inventory does not match the backup database." };
      }
      const files = listStorageFiles(storagePath);
      const expectedFiles = manifest.objects
        .map((entry) => ({ path: entry.file, bytes: entry.bytes, sha256: entry.sha256 }))
        .sort((left, right) => compareText(left.path, right.path));
      if (
        manifest.fileCount !== files.length ||
        manifest.totalBytes !== files.reduce((total, entry) => total + entry.bytes, 0) ||
        !sameFiles(expectedFiles, files)
      ) {
        return { valid: false, reason: "Bundled S3 evidence inventory does not match its manifest." };
      }
      return { valid: true };
    }

    if (manifest.directory !== expectedPublishedDirectoryName) {
      return { valid: false, reason: "Local evidence directory does not match its manifest." };
    }
    const files = listStorageFiles(storagePath);
    if (
      manifest.fileCount !== files.length ||
      manifest.totalBytes !== files.reduce((total, entry) => total + entry.bytes, 0) ||
      !sameFiles(manifest.files, files)
    ) {
      return {
        valid: false,
        reason: "Local evidence inventory does not match its manifest.",
      };
    }
    const available = new Set(files.map((entry) => entry.path));
    const missing = keys.filter((key) => !available.has(key));
    if (missing.length > 0) {
      return {
        valid: false,
        reason: `Backup is missing ${missing.length} managed local evidence object(s).`,
      };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function readStorageSnapshotFile(snapshotPath: string, relativePath: string): Buffer {
  return fs.readFileSync(resolveInside(snapshotPath, relativePath));
}

function removePath(filePath: string): void {
  try {
    fs.rmSync(filePath, { recursive: true, force: true });
  } catch {
    // The caller retains the original install or restore error.
  }
}

export function installLocalStorageSnapshot(
  snapshotPath: string,
  targetStoragePath: string,
  expectedFiles: LocalStorageFileManifest[],
): { previous: string | null; rollback: () => void } {
  const source = path.resolve(snapshotPath);
  const target = path.resolve(targetStoragePath);
  if (source === target) return { previous: null, rollback: () => undefined };

  const nonce = `${process.pid}-${Date.now()}`;
  const staged = `${target}.restore-${nonce}.tmp`;
  const previous = `${target}.bak-${Date.now()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, staged, { recursive: true, errorOnExist: true, force: false });
  if (!sameFiles(listStorageFiles(staged), expectedFiles)) {
    removePath(staged);
    throw new Error("Staged local evidence does not match the backup manifest.");
  }

  const hadTarget = fs.existsSync(target);
  try {
    if (hadTarget) fs.renameSync(target, previous);
    fs.renameSync(staged, target);
  } catch (error) {
    removePath(staged);
    try {
      if (!fs.existsSync(target) && fs.existsSync(previous)) fs.renameSync(previous, target);
    } catch {
      // Leave both paths for manual recovery and report the original failure.
    }
    throw error;
  }

  return {
    previous: hadTarget ? previous : null,
    rollback: () => {
      removePath(target);
      if (hadTarget && fs.existsSync(previous)) fs.renameSync(previous, target);
    },
  };
}
