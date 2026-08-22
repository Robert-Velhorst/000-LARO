import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  backupDatabase,
  cleanupBackupDatabaseSidecars,
  restoreDatabase,
  validateBackup,
} from "./backup";
import {
  assertLocalStorageUnchanged,
  backupSetStoragePath,
  createLocalStorageSnapshot,
  createS3StorageSnapshot,
  installLocalStorageSnapshot,
  isBackupStorageManifest,
  MAX_BACKUP_STORAGE_OBJECT_BYTES,
  readStorageSnapshotFile,
  validateBackupStorage,
  type BackupStorageManifest,
  type BundledLocalStorageManifest,
  type BundledS3StorageManifest,
} from "./backupStorage";

const FORMAT = "laro-backup-set";
const VERSION = 3;
const INVENTORY_ONLY_VERSION = 2;
const LEGACY_VERSION = 1;
const SECRET_PATTERN = /^[a-f0-9]{64}$/;
const COMPATIBILITY_CONTEXT = "LARO backup token-encryption compatibility v1";

interface DesktopSecretStore {
  jwtSecret: string;
  cookieSecret: string;
}

interface DatabaseManifestEntry {
  file: string;
  bytes: number;
  sha256: string;
}

type EncryptionManifestEntry =
  | {
      mode: "bundled-desktop-secret";
      compatibilityTag: string;
      file: string;
      sha256: string;
    }
  | {
      mode: "external-environment";
      compatibilityTag: string;
    };

export interface BackupSetManifest {
  format: typeof FORMAT;
  version: typeof VERSION | typeof INVENTORY_ONLY_VERSION | typeof LEGACY_VERSION;
  createdAt: string;
  database: DatabaseManifestEntry;
  encryption: EncryptionManifestEntry;
  storage?: BackupStorageManifest;
}

export interface CreateBackupSetOptions {
  desktopSecretsPath?: string;
  externalJwtSecret?: string;
  localStoragePath?: string;
  externalStorageRead?: (
    key: string,
    options: { maxBytes: number },
  ) => Promise<{ body: Buffer; contentType: string }>;
}

export interface ValidateBackupSetOptions {
  externalJwtSecret?: string;
}

export interface BackupSetValidation {
  valid: boolean;
  reason?: string;
  manifest?: BackupSetManifest;
  tables?: string[];
  storageCoverage?: "complete-local" | "complete-s3" | "legacy-external-s3" | "legacy-missing";
}

export interface RestoreBackupSetOptions extends ValidateBackupSetOptions {
  desktopSecretsPath?: string;
  localStoragePath?: string;
  allowMissingStorage?: boolean;
  externalStorageRead?: (
    key: string,
    options: { maxBytes: number },
  ) => Promise<{ body: Buffer; contentType: string }>;
  externalStoragePut?: (key: string, body: Buffer, contentType: string) => Promise<{ sha256: string }>;
  externalStorageDelete?: (key: string) => Promise<void>;
}

export interface RestoreBackupSetResult {
  restored: true;
  backupOfPreviousDatabase: string | null;
  backupOfPreviousSecrets: string | null;
  backupOfPreviousStorage: string | null;
}

export function backupSetManifestPath(databaseBackupPath: string): string {
  return `${path.resolve(databaseBackupPath)}.manifest.json`;
}

export function backupSetSecretsPath(databaseBackupPath: string): string {
  return `${path.resolve(databaseBackupPath)}.secrets.json`;
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function compatibilityTag(jwtSecret: string): string {
  return crypto.createHmac("sha256", jwtSecret).update(COMPATIBILITY_CONTEXT).digest("hex");
}

function parseDesktopSecretStore(filePath: string): DesktopSecretStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read desktop secrets at ${filePath}.`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Desktop secrets at ${filePath} are invalid.`);
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.jwtSecret !== "string" ||
    !SECRET_PATTERN.test(candidate.jwtSecret) ||
    typeof candidate.cookieSecret !== "string" ||
    !SECRET_PATTERN.test(candidate.cookieSecret)
  ) {
    throw new Error(`Desktop secrets at ${filePath} are invalid.`);
  }
  return {
    jwtSecret: candidate.jwtSecret,
    cookieSecret: candidate.cookieSecret,
  };
}

function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function parseManifest(manifestPath: string): BackupSetManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read backup-set manifest at ${manifestPath}.`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Backup-set manifest is invalid.");
  const candidate = parsed as Record<string, unknown>;
  const database = candidate.database as Record<string, unknown> | undefined;
  const encryption = candidate.encryption as Record<string, unknown> | undefined;
  const baseValid =
    candidate.format === FORMAT &&
    (candidate.version === VERSION || candidate.version === INVENTORY_ONLY_VERSION || candidate.version === LEGACY_VERSION) &&
    typeof candidate.createdAt === "string" &&
    !Number.isNaN(Date.parse(candidate.createdAt)) &&
    database &&
    typeof database.file === "string" &&
    Number.isSafeInteger(database.bytes) &&
    Number(database.bytes) > 0 &&
    isHexDigest(database.sha256) &&
    encryption &&
    isHexDigest(encryption.compatibilityTag);
  if (!baseValid) throw new Error("Backup-set manifest is invalid.");

  if (encryption.mode === "bundled-desktop-secret") {
    if (typeof encryption.file !== "string" || !isHexDigest(encryption.sha256)) {
      throw new Error("Bundled desktop-secret metadata is invalid.");
    }
  } else if (encryption.mode !== "external-environment") {
    throw new Error("Backup-set encryption mode is unsupported.");
  }
  if (
    (candidate.version === VERSION || candidate.version === INVENTORY_ONLY_VERSION) &&
    !isBackupStorageManifest(candidate.storage)
  ) {
    throw new Error("Backup-set storage metadata is invalid.");
  }
  if (candidate.version === VERSION && (candidate.storage as BackupStorageManifest).mode === "external-s3") {
    throw new Error("Version-3 backup sets must bundle S3 evidence bytes.");
  }
  return parsed as BackupSetManifest;
}

function discoverDesktopSecrets(databasePath: string): string | null {
  const candidate = path.join(path.dirname(path.resolve(databasePath)), "laro-secrets.json");
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveSecretSource(
  databasePath: string,
  options: CreateBackupSetOptions,
): { mode: "desktop"; path: string; store: DesktopSecretStore } | { mode: "external"; jwtSecret: string } {
  const desktopSecretsPath = options.desktopSecretsPath || (
    options.externalJwtSecret ? null : discoverDesktopSecrets(databasePath)
  );
  if (desktopSecretsPath) {
    const resolved = path.resolve(desktopSecretsPath);
    return { mode: "desktop", path: resolved, store: parseDesktopSecretStore(resolved) };
  }
  const externalJwtSecret = options.externalJwtSecret || process.env.JWT_SECRET;
  if (!externalJwtSecret) {
    throw new Error(
      "Cannot create a recovery-ready backup set without laro-secrets.json or JWT_SECRET.",
    );
  }
  return { mode: "external", jwtSecret: externalJwtSecret };
}

function currentDatabasePath(): string {
  return path.resolve(process.env.DATABASE_URL || "laro.sqlite");
}

function resolveLocalStoragePath(
  databasePath: string,
  options: { localStoragePath?: string },
  desktopProfile: boolean,
): string {
  if (options.localStoragePath) return path.resolve(options.localStoragePath);
  if (process.env.LOCAL_STORAGE_DIR) return path.resolve(process.env.LOCAL_STORAGE_DIR);
  if (desktopProfile) return path.join(path.dirname(path.resolve(databasePath)), "uploads");
  const sibling = path.join(path.dirname(path.resolve(databasePath)), "uploads");
  if (fs.existsSync(sibling)) return sibling;
  return path.join(process.cwd(), "laro-uploads");
}

function removeIfPresent(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.rmSync(filePath, { recursive: true, force: true });
  } catch {
    // Preserve the original failure; partial paths are named in its message.
  }
}

export async function createBackupSet(
  destinationPath: string,
  options: CreateBackupSetOptions = {},
): Promise<{
  databasePath: string;
  manifestPath: string;
  secretsPath: string | null;
  storagePath: string | null;
  bytes: number;
}> {
  const destination = path.resolve(destinationPath);
  const manifestPath = backupSetManifestPath(destination);
  const secretsPath = backupSetSecretsPath(destination);
  const storagePath = backupSetStoragePath(destination);
  const databasePath = currentDatabasePath();
  const secretSource = resolveSecretSource(databasePath, options);
  const externalBucket = options.localStoragePath ? "" : (process.env.AWS_S3_BUCKET || "").trim();
  const localStorageSource = externalBucket
    ? null
    : resolveLocalStoragePath(databasePath, options, secretSource.mode === "desktop");
  if (
    localStorageSource &&
    (destination === path.resolve(localStorageSource) ||
      destination.startsWith(path.resolve(localStorageSource) + path.sep))
  ) {
    throw new Error("Refusing to create a backup set inside the live local evidence directory.");
  }
  const finalPaths = [destination, manifestPath, secretsPath, storagePath];
  const existing = finalPaths.find((filePath) => fs.existsSync(filePath));
  if (existing) throw new Error(`Refusing to overwrite an existing backup-set file: ${existing}`);

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
  const temporaryDatabase = `${destination}.${nonce}.tmp`;
  const temporaryManifest = `${manifestPath}.${nonce}.tmp`;
  const temporarySecrets = `${secretsPath}.${nonce}.tmp`;
  const temporaryStorage = `${storagePath}.${nonce}.tmp`;
  const published: string[] = [];

  try {
    let storage: BackupStorageManifest;
    let localStorageManifest: BundledLocalStorageManifest | null = null;
    if (localStorageSource) {
      localStorageManifest = createLocalStorageSnapshot(
        localStorageSource,
        temporaryStorage,
        path.basename(storagePath),
      );
      storage = localStorageManifest;
    }

    const backup = await backupDatabase(temporaryDatabase);
    const databaseEntry: DatabaseManifestEntry = {
      file: path.basename(destination),
      bytes: backup.bytes,
      sha256: sha256(temporaryDatabase),
    };

    if (localStorageSource) {
      if (!localStorageManifest) {
        throw new Error("Local evidence snapshot did not produce a local-storage manifest.");
      }
      assertLocalStorageUnchanged(localStorageSource, localStorageManifest.files);
      const storageValidation = validateBackupStorage(
        temporaryDatabase,
        temporaryStorage,
        localStorageManifest,
        path.basename(storagePath),
      );
      if (!storageValidation.valid) {
        throw new Error(`Local evidence backup verification failed: ${storageValidation.reason}`);
      }
    } else {
      const readExternalObject = options.externalStorageRead || (async (key, readOptions) => {
        const { storageReadForBackup } = await import("./storage");
        return storageReadForBackup(key, readOptions);
      });
      storage = await createS3StorageSnapshot(
        temporaryDatabase,
        temporaryStorage,
        path.basename(storagePath),
        externalBucket,
        process.env.AWS_S3_REGION || "eu-west-1",
        readExternalObject,
      );
      const storageValidation = validateBackupStorage(
        temporaryDatabase,
        temporaryStorage,
        storage,
        path.basename(storagePath),
      );
      if (!storageValidation.valid) {
        throw new Error(`S3 evidence backup verification failed: ${storageValidation.reason}`);
      }
    }

    let encryption: EncryptionManifestEntry;

    if (secretSource.mode === "desktop") {
      fs.copyFileSync(secretSource.path, temporarySecrets, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporarySecrets, 0o600);
      parseDesktopSecretStore(temporarySecrets);
      encryption = {
        mode: "bundled-desktop-secret",
        compatibilityTag: compatibilityTag(secretSource.store.jwtSecret),
        file: path.basename(secretsPath),
        sha256: sha256(temporarySecrets),
      };
    } else {
      encryption = {
        mode: "external-environment",
        compatibilityTag: compatibilityTag(secretSource.jwtSecret),
      };
    }

    const manifest: BackupSetManifest = {
      format: FORMAT,
      version: VERSION,
      createdAt: new Date().toISOString(),
      database: databaseEntry,
      encryption,
      storage: storage!,
    };
    fs.writeFileSync(temporaryManifest, JSON.stringify(manifest, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    if (storage!.mode === "bundled-local" || storage!.mode === "bundled-s3") {
      fs.renameSync(temporaryStorage, storagePath);
      published.push(storagePath);
    }
    if (secretSource.mode === "desktop") {
      fs.renameSync(temporarySecrets, secretsPath);
      published.push(secretsPath);
    }
    fs.renameSync(temporaryDatabase, destination);
    published.push(destination);
    fs.renameSync(temporaryManifest, manifestPath);
    published.push(manifestPath);

    return {
      databasePath: destination,
      manifestPath,
      secretsPath: secretSource.mode === "desktop" ? secretsPath : null,
      storagePath: storage!.mode === "bundled-local" || storage!.mode === "bundled-s3" ? storagePath : null,
      bytes: backup.bytes,
    };
  } catch (error) {
    for (const filePath of [
      temporaryDatabase,
      temporaryManifest,
      temporarySecrets,
      temporaryStorage,
      ...published,
    ]) {
      removeIfPresent(filePath);
    }
    throw error;
  }
}

export function validateBackupSet(
  databaseBackupPath: string,
  options: ValidateBackupSetOptions = {},
): BackupSetValidation {
  const databasePath = path.resolve(databaseBackupPath);
  try {
    const manifest = parseManifest(backupSetManifestPath(databasePath));
    if (manifest.database.file !== path.basename(databasePath)) {
      return { valid: false, reason: "Backup-set database filename does not match its manifest." };
    }
    if (!fs.existsSync(databasePath)) return { valid: false, reason: "Backup database does not exist." };
    const databaseStat = fs.statSync(databasePath);
    if (databaseStat.size !== manifest.database.bytes || sha256(databasePath) !== manifest.database.sha256) {
      return { valid: false, reason: "Backup database hash or size does not match its manifest." };
    }
    const databaseValidation = validateBackup(databasePath);
    if (!databaseValidation.valid) {
      return { valid: false, reason: databaseValidation.reason };
    }

    if (manifest.encryption.mode === "bundled-desktop-secret") {
      const expectedSecretsPath = backupSetSecretsPath(databasePath);
      if (manifest.encryption.file !== path.basename(expectedSecretsPath)) {
        return { valid: false, reason: "Backup-set secret filename does not match its manifest." };
      }
      if (!fs.existsSync(expectedSecretsPath)) {
        return { valid: false, reason: "Bundled desktop secrets are missing." };
      }
      if (sha256(expectedSecretsPath) !== manifest.encryption.sha256) {
        return { valid: false, reason: "Bundled desktop-secret hash does not match its manifest." };
      }
      const store = parseDesktopSecretStore(expectedSecretsPath);
      if (compatibilityTag(store.jwtSecret) !== manifest.encryption.compatibilityTag) {
        return { valid: false, reason: "Bundled desktop secrets are incompatible with the manifest." };
      }
    } else {
      const externalJwtSecret = options.externalJwtSecret || process.env.JWT_SECRET;
      if (!externalJwtSecret) {
        return { valid: false, reason: "JWT_SECRET is required to validate this external-secret backup set." };
      }
      if (compatibilityTag(externalJwtSecret) !== manifest.encryption.compatibilityTag) {
        return { valid: false, reason: "JWT_SECRET is incompatible with this backup set." };
      }
    }

    if (manifest.version === LEGACY_VERSION) {
      return {
        valid: true,
        manifest,
        tables: databaseValidation.tables,
        storageCoverage: "legacy-missing",
      };
    }
    const storageValidation = validateBackupStorage(
      databasePath,
      backupSetStoragePath(databasePath),
      manifest.storage!,
    );
    if (!storageValidation.valid) {
      return { valid: false, reason: storageValidation.reason };
    }

    return {
      valid: true,
      manifest,
      tables: databaseValidation.tables,
      storageCoverage: manifest.storage!.mode === "bundled-local"
        ? "complete-local"
        : manifest.storage!.mode === "bundled-s3"
          ? "complete-s3"
          : "legacy-external-s3",
    };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function installBundledSecrets(
  bundledSecretsPath: string,
  targetSecretsPath: string,
  expectedSha256: string,
): { previous: string | null; rollback: () => void } {
  const source = path.resolve(bundledSecretsPath);
  const target = path.resolve(targetSecretsPath);
  if (source === target) return { previous: null, rollback: () => undefined };

  const nonce = `${process.pid}-${Date.now()}`;
  const staged = `${target}.restore-${nonce}.tmp`;
  const previous = `${target}.bak-${Date.now()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, staged, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(staged, 0o600);
  parseDesktopSecretStore(staged);
  if (sha256(staged) !== expectedSha256) {
    removeIfPresent(staged);
    throw new Error("Staged desktop secrets do not match the backup-set manifest.");
  }

  const hadTarget = fs.existsSync(target);
  try {
    if (hadTarget) fs.renameSync(target, previous);
    fs.renameSync(staged, target);
  } catch (error) {
    removeIfPresent(staged);
    try {
      if (!fs.existsSync(target) && fs.existsSync(previous)) fs.renameSync(previous, target);
    } catch {
      // Leave recovery paths in place and report the original install failure.
    }
    throw error;
  }

  return {
    previous: hadTarget ? previous : null,
    rollback: () => {
      removeIfPresent(target);
      if (hadTarget && fs.existsSync(previous)) fs.renameSync(previous, target);
    },
  };
}

async function installS3StorageSnapshot(
  backupDatabasePath: string,
  manifest: BundledS3StorageManifest,
  options: RestoreBackupSetOptions,
): Promise<{ previous: string; rollback: () => Promise<void> }> {
  const readObject = options.externalStorageRead || (async (key, readOptions) => {
    const { storageReadForBackup } = await import("./storage");
    return storageReadForBackup(key, readOptions);
  });
  const putObject = options.externalStoragePut || (async (key, body, contentType) => {
    const { storagePut } = await import("./storage");
    return storagePut(key, body, contentType);
  });
  const deleteObject = options.externalStorageDelete || (async (key) => {
    const { storageDelete } = await import("./storage");
    return storageDelete(key);
  });
  const backupStoragePath = backupSetStoragePath(backupDatabasePath);
  const previousPath = `${currentDatabasePath()}.s3-files.bak-${Date.now()}`;
  const previousManifestPath = `${previousPath}.manifest.json`;
  const previousInventoryDatabase = `${previousPath}.inventory.sqlite`;
  let previousManifest: BundledS3StorageManifest;
  try {
    await backupDatabase(previousInventoryDatabase);
    previousManifest = await createS3StorageSnapshot(
      previousInventoryDatabase,
      previousPath,
      path.basename(previousPath),
      manifest.bucket,
      manifest.region,
      readObject,
    );
    fs.writeFileSync(previousManifestPath, JSON.stringify(previousManifest, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    removeIfPresent(previousPath);
    removeIfPresent(previousManifestPath);
    throw error;
  } finally {
    removeIfPresent(previousInventoryDatabase);
    cleanupBackupDatabaseSidecars(previousInventoryDatabase);
  }

  const previousKeys = new Set(previousManifest.objects.map((entry) => entry.key));
  const written = new Set<string>();
  const writeFiles = async (
    snapshotPath: string,
    objects: BundledS3StorageManifest["objects"],
    trackWrites: boolean,
  ): Promise<void> => {
    for (const entry of objects) {
      const body = readStorageSnapshotFile(snapshotPath, entry.file);
      if (body.length > MAX_BACKUP_STORAGE_OBJECT_BYTES || body.length !== entry.bytes) {
        throw new Error(`Bundled S3 evidence has an invalid restore size: ${entry.key}`);
      }
      if (trackWrites) written.add(entry.key);
      const stored = await putObject(entry.key, body, entry.contentType);
      if (stored.sha256 !== entry.sha256) {
        throw new Error(`Restored S3 evidence hash does not match its manifest: ${entry.key}`);
      }
      const readBack = await readObject(entry.key, { maxBytes: MAX_BACKUP_STORAGE_OBJECT_BYTES });
      const readBackHash = crypto.createHash("sha256").update(readBack.body).digest("hex");
      if (
        readBack.body.length !== entry.bytes ||
        readBackHash !== entry.sha256 ||
        readBack.contentType !== entry.contentType
      ) {
        throw new Error(`Restored S3 evidence read-back hash does not match its manifest: ${entry.key}`);
      }
    }
  };

  const rollback = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const key of written) {
      if (previousKeys.has(key)) continue;
      try { await deleteObject(key); } catch (error) { errors.push(error); }
    }
    try {
      await writeFiles(previousPath, previousManifest.objects, false);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      removeIfPresent(previousPath);
      removeIfPresent(previousManifestPath);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Previous S3 evidence could not be fully reinstated.");
    }
  };

  try {
    await writeFiles(backupStoragePath, manifest.objects, true);
    return { previous: previousPath, rollback };
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "S3 evidence restore failed and the previous objects could not be fully reinstated.",
      );
    }
    throw error;
  }
}

export async function restoreBackupSet(
  databaseBackupPath: string,
  options: RestoreBackupSetOptions = {},
): Promise<RestoreBackupSetResult> {
  const databasePath = path.resolve(databaseBackupPath);
  const validation = validateBackupSet(databasePath, options);
  if (!validation.valid || !validation.manifest) {
    throw new Error(`Refusing to restore backup set: ${validation.reason || "validation failed"}`);
  }
  if (
    (validation.manifest.version === LEGACY_VERSION || validation.manifest.storage?.mode === "external-s3") &&
    !options.allowMissingStorage
  ) {
    throw new Error(
      "Refusing to restore an inventory-only backup set because evidence coverage is not proven. " +
        "Restore the matching storage separately or use an explicit missing-storage override.",
    );
  }

  const liveDatabasePath = currentDatabasePath();
  const targetSecretsPath = options.desktopSecretsPath || path.join(
    path.dirname(liveDatabasePath),
    "laro-secrets.json",
  );
  const activeEnvironmentSecret = options.externalJwtSecret || process.env.JWT_SECRET;
  if (
    validation.manifest.encryption.mode === "bundled-desktop-secret" &&
    activeEnvironmentSecret &&
    compatibilityTag(activeEnvironmentSecret) !== validation.manifest.encryption.compatibilityTag
  ) {
    throw new Error(
      "Refusing to restore desktop backup set while the active JWT_SECRET overrides its bundled key.",
    );
  }
  if (
    validation.manifest.encryption.mode === "external-environment" &&
    fs.existsSync(targetSecretsPath)
  ) {
    const targetStore = parseDesktopSecretStore(targetSecretsPath);
    if (compatibilityTag(targetStore.jwtSecret) !== validation.manifest.encryption.compatibilityTag) {
      throw new Error(
        "Refusing to restore external-secret backup set into a desktop profile with incompatible keys.",
      );
    }
  }

  if (
    validation.manifest.storage?.mode === "external-s3" ||
    validation.manifest.storage?.mode === "bundled-s3"
  ) {
    const activeBucket = (process.env.AWS_S3_BUCKET || "").trim();
    const activeRegion = process.env.AWS_S3_REGION || "eu-west-1";
    if (
      activeBucket !== validation.manifest.storage.bucket ||
      activeRegion !== validation.manifest.storage.region
    ) {
      throw new Error(
        "Refusing to restore backup set while the active S3 bucket or region differs from its manifest.",
      );
    }
  }

  let secretInstall: { previous: string | null; rollback: () => void } | null = null;
  let storageInstall: { previous: string | null; rollback: () => void } | null = null;
  let s3Install: { previous: string; rollback: () => Promise<void> } | null = null;

  try {
    if (validation.manifest.encryption.mode === "bundled-desktop-secret") {
      secretInstall = installBundledSecrets(
        backupSetSecretsPath(databasePath),
        targetSecretsPath,
        validation.manifest.encryption.sha256,
      );
    }
    if (validation.manifest.storage?.mode === "bundled-local") {
      const targetStoragePath = resolveLocalStoragePath(
        liveDatabasePath,
        options,
        validation.manifest.encryption.mode === "bundled-desktop-secret",
      );
      storageInstall = installLocalStorageSnapshot(
        backupSetStoragePath(databasePath),
        targetStoragePath,
        validation.manifest.storage.files,
      );
    }
    if (validation.manifest.storage?.mode === "bundled-s3") {
      s3Install = await installS3StorageSnapshot(
        databasePath,
        validation.manifest.storage,
        options,
      );
    }
    const restored = restoreDatabase(databasePath, {
      bytes: validation.manifest.database.bytes,
      sha256: validation.manifest.database.sha256,
    });
    return {
      restored: true,
      backupOfPreviousDatabase: restored.backupOfPrevious,
      backupOfPreviousSecrets: secretInstall?.previous || null,
      backupOfPreviousStorage: storageInstall?.previous || s3Install?.previous || null,
    };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      if (s3Install) await s3Install.rollback();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      storageInstall?.rollback();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      secretInstall?.rollback();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Backup-set restore failed and one or more previous paths could not be reinstated.",
      );
    }
    throw error;
  }
}
