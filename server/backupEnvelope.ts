import crypto from "crypto";
import fs from "fs";
import path from "path";

export const ENCRYPTED_BACKUP_VERSION = 4 as const;
const FORMAT = "laro-backup-set" as const;
const ALGORITHM = "aes-256-gcm" as const;
const KDF = "scrypt" as const;
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const KEY_ID_CONTEXT = "LARO recovery-key identifier v1";
const BUNDLE_MAGIC = Buffer.from("LARO-RECOVERY-BUNDLE\x01", "binary");
const IO_CHUNK_BYTES = 1024 * 1024;
const MAX_ENTRY_HEADER_BYTES = 16 * 1024;
const MAX_BUNDLE_ENTRIES = 100_010;
// The protected members are bounded to 120 GB; reserve one GB for container
// metadata and a database near its independent maintenance ceiling.
const MAX_BUNDLE_BYTES = 121 * 1024 * 1024 * 1024;

export interface RecoveryCredentialOptions {
  recoveryKey?: string;
  recoveryKeyPath?: string;
}

export interface BackupEnvelopeManifest {
  format: typeof FORMAT;
  version: typeof ENCRYPTED_BACKUP_VERSION;
  createdAt: string;
  payload: {
    file: string;
    bytes: number;
    sha256: string;
  };
  protection: {
    algorithm: typeof ALGORITHM;
    kdf: typeof KDF;
    scryptN: typeof SCRYPT_N;
    scryptR: typeof SCRYPT_R;
    scryptP: typeof SCRYPT_P;
    salt: string;
    iv: string;
    authTag: string;
    keyId: string;
    plaintextBytes: number;
  };
}

interface BundleEntry {
  source: string;
  target: string;
  bytes: number;
  sha256: string;
}

function isHex(value: unknown, bytes: number): value is string {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${bytes * 2}}$`).test(value);
}

function isSafeRelativePath(value: string): boolean {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    return false;
  }
  return value.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function resolveInside(rootPath: string, relativePath: string): string {
  if (!isSafeRelativePath(relativePath)) throw new Error("Encrypted backup contains an unsafe path.");
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, ...relativePath.split("/"));
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error("Encrypted backup path escapes its extraction directory.");
  }
  return resolved;
}

function openRegularReadOnly(filePath: string): { fd: number; stat: fs.Stats } {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
    return { fd, stat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function sha256Fd(fd: number): string {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const read = fs.readSync(fd, buffer, 0, buffer.length, position);
    if (read === 0) break;
    digest.update(buffer.subarray(0, read));
    position += read;
  }
  return digest.digest("hex");
}

function sha256File(filePath: string): string {
  const { fd } = openRegularReadOnly(filePath);
  try {
    return sha256Fd(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeAll(fd: number, value: Buffer): void {
  let offset = 0;
  while (offset < value.length) offset += fs.writeSync(fd, value, offset, value.length - offset);
}

function copyExact(
  sourceFd: number,
  destinationFd: number,
  bytes: number,
  digest?: crypto.Hash,
): void {
  const buffer = Buffer.allocUnsafe(Math.min(IO_CHUNK_BYTES, Math.max(1, bytes)));
  let remaining = bytes;
  while (remaining > 0) {
    const wanted = Math.min(buffer.length, remaining);
    const read = fs.readSync(sourceFd, buffer, 0, wanted, null);
    if (read === 0) throw new Error("Encrypted backup bundle ended before its declared entry size.");
    const chunk = buffer.subarray(0, read);
    digest?.update(chunk);
    writeAll(destinationFd, chunk);
    remaining -= read;
  }
}

function collectDirectoryFiles(sourceRoot: string, targetRoot: string): BundleEntry[] {
  const entries: BundleEntry[] = [];
  const walk = (directory: string, relativeDirectory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const source = path.join(directory, entry.name);
      const relative = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error(`Backup staging contains a symbolic link: ${relative}`);
      if (stat.isDirectory()) {
        walk(source, relative);
      } else if (stat.isFile()) {
        const target = path.posix.join(targetRoot, relative);
        if (!isSafeRelativePath(target)) throw new Error(`Backup staging contains an unsafe path: ${relative}`);
        entries.push({ source, target, bytes: stat.size, sha256: sha256File(source) });
      } else {
        throw new Error(`Backup staging contains an unsupported entry: ${relative}`);
      }
    }
  };
  walk(path.resolve(sourceRoot), "");
  return entries;
}

export function createBackupBundle(stagedDatabasePath: string, bundlePath: string): number {
  const databasePath = path.resolve(stagedDatabasePath);
  const manifestPath = `${databasePath}.manifest.json`;
  const secretsPath = `${databasePath}.secrets.json`;
  const storagePath = `${databasePath}.files`;
  const required = [databasePath, manifestPath];
  for (const filePath of required) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`Backup staging member is missing: ${path.basename(filePath)}`);
    }
  }

  const fileEntry = (source: string, target: string): BundleEntry => {
    const stat = fs.statSync(source);
    return { source, target, bytes: stat.size, sha256: sha256File(source) };
  };
  const entries = [
    fileEntry(databasePath, "database.sqlite"),
    fileEntry(manifestPath, "database.sqlite.manifest.json"),
    ...(fs.existsSync(secretsPath) ? [fileEntry(secretsPath, "database.sqlite.secrets.json")] : []),
    ...(fs.existsSync(storagePath) ? collectDirectoryFiles(storagePath, "database.sqlite.files") : []),
  ].sort((left, right) => left.target.localeCompare(right.target));

  if (entries.length > MAX_BUNDLE_ENTRIES) throw new Error("Backup bundle contains too many files.");
  const totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  if (totalBytes > MAX_BUNDLE_BYTES) throw new Error("Backup bundle exceeds the 121 GB safety limit.");

  const output = path.resolve(bundlePath);
  const outputFd = fs.openSync(output, "wx", 0o600);
  try {
    writeAll(outputFd, BUNDLE_MAGIC);
    const count = Buffer.allocUnsafe(4);
    count.writeUInt32BE(entries.length);
    writeAll(outputFd, count);
    for (const entry of entries) {
      const header = Buffer.from(JSON.stringify({
        path: entry.target,
        bytes: entry.bytes,
        sha256: entry.sha256,
      }), "utf8");
      if (header.length > MAX_ENTRY_HEADER_BYTES) throw new Error("Backup bundle entry metadata is too large.");
      const headerLength = Buffer.allocUnsafe(4);
      headerLength.writeUInt32BE(header.length);
      writeAll(outputFd, headerLength);
      writeAll(outputFd, header);
      const sourceFd = fs.openSync(entry.source, "r");
      try {
        copyExact(sourceFd, outputFd, entry.bytes);
        const trailing = Buffer.allocUnsafe(1);
        if (fs.readSync(sourceFd, trailing, 0, 1, null) !== 0) {
          throw new Error(`Backup staging member changed while bundling: ${entry.target}`);
        }
      } finally {
        fs.closeSync(sourceFd);
      }
    }
  } catch (error) {
    fs.closeSync(outputFd);
    fs.rmSync(output, { force: true });
    throw error;
  }
  fs.closeSync(outputFd);
  return fs.statSync(output).size;
}

function readExact(fd: number, bytes: number): Buffer {
  const value = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < bytes) {
    const read = fs.readSync(fd, value, offset, bytes - offset, null);
    if (read === 0) throw new Error("Encrypted backup bundle ended unexpectedly.");
    offset += read;
  }
  return value;
}

export function extractBackupBundle(bundlePath: string, targetDirectory: string): string {
  const source = path.resolve(bundlePath);
  const target = path.resolve(targetDirectory);
  fs.mkdirSync(target, { recursive: false, mode: 0o700 });
  const sourceFd = fs.openSync(source, "r");
  const seen = new Set<string>();
  let totalBytes = 0;
  try {
    if (!readExact(sourceFd, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) {
      throw new Error("Recovery payload is not a supported LARO backup bundle.");
    }
    const entryCount = readExact(sourceFd, 4).readUInt32BE(0);
    if (entryCount < 2 || entryCount > MAX_BUNDLE_ENTRIES) {
      throw new Error("Recovery payload has an invalid file count.");
    }
    for (let index = 0; index < entryCount; index += 1) {
      const headerBytes = readExact(sourceFd, 4).readUInt32BE(0);
      if (headerBytes < 2 || headerBytes > MAX_ENTRY_HEADER_BYTES) {
        throw new Error("Recovery payload has invalid entry metadata.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(readExact(sourceFd, headerBytes).toString("utf8"));
      } catch (error) {
        throw new Error("Recovery payload entry metadata is invalid.", { cause: error });
      }
      const entry = parsed as Record<string, unknown>;
      if (
        !entry || typeof entry !== "object" ||
        typeof entry.path !== "string" || !isSafeRelativePath(entry.path) ||
        !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0 ||
        !isHex(entry.sha256, 32) || seen.has(entry.path)
      ) {
        throw new Error("Recovery payload contains an invalid or duplicate entry.");
      }
      seen.add(entry.path);
      totalBytes += Number(entry.bytes);
      if (totalBytes > MAX_BUNDLE_BYTES) throw new Error("Recovery payload exceeds the 121 GB safety limit.");
      const destination = resolveInside(target, entry.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const destinationFd = fs.openSync(destination, "wx", 0o600);
      const digest = crypto.createHash("sha256");
      try {
        copyExact(sourceFd, destinationFd, Number(entry.bytes), digest);
      } finally {
        fs.closeSync(destinationFd);
      }
      if (digest.digest("hex") !== entry.sha256) {
        throw new Error(`Recovery payload entry failed its integrity check: ${entry.path}`);
      }
    }
    const trailing = Buffer.allocUnsafe(1);
    if (fs.readSync(sourceFd, trailing, 0, 1, null) !== 0) {
      throw new Error("Recovery payload contains trailing bytes.");
    }
  } catch (error) {
    fs.closeSync(sourceFd);
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  fs.closeSync(sourceFd);
  if (!seen.has("database.sqlite") || !seen.has("database.sqlite.manifest.json")) {
    fs.rmSync(target, { recursive: true, force: true });
    throw new Error("Recovery payload is missing its database or internal manifest.");
  }
  return path.join(target, "database.sqlite");
}

export function resolveRecoveryKey(options: RecoveryCredentialOptions = {}): string {
  const configuredPath = options.recoveryKeyPath || (
    options.recoveryKey ? undefined : process.env.LARO_RECOVERY_KEY_FILE
  );
  let recoveryKey = options.recoveryKey || (
    options.recoveryKeyPath ? undefined : process.env.LARO_RECOVERY_KEY
  );
  if (configuredPath) {
    const keyPath = path.resolve(configuredPath);
    const { fd, stat } = openRegularReadOnly(keyPath);
    try {
      if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        throw new Error("The LARO recovery-key file must be readable only by its owner (mode 0600).");
      }
      recoveryKey = fs.readFileSync(fd, "utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  }
  if (!recoveryKey) {
    throw new Error(
      "A separate recovery credential is required. Set LARO_RECOVERY_KEY_FILE or LARO_RECOVERY_KEY.",
    );
  }
  if (Buffer.byteLength(recoveryKey, "utf8") < 32) {
    throw new Error("The LARO recovery credential must contain at least 32 UTF-8 bytes.");
  }
  return recoveryKey;
}

function deriveKey(recoveryKey: string, salt: Buffer): Buffer {
  return crypto.scryptSync(recoveryKey, salt, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEMORY,
  });
}

function keyIdentifier(key: Buffer): string {
  return crypto.createHmac("sha256", key).update(KEY_ID_CONTEXT).digest("hex");
}

function envelopeAad(manifest: BackupEnvelopeManifest): Buffer {
  return Buffer.from(JSON.stringify({
    format: manifest.format,
    version: manifest.version,
    createdAt: manifest.createdAt,
    payloadFile: manifest.payload.file,
    algorithm: manifest.protection.algorithm,
    kdf: manifest.protection.kdf,
    scryptN: manifest.protection.scryptN,
    scryptR: manifest.protection.scryptR,
    scryptP: manifest.protection.scryptP,
    salt: manifest.protection.salt,
    iv: manifest.protection.iv,
    keyId: manifest.protection.keyId,
    plaintextBytes: manifest.protection.plaintextBytes,
  }), "utf8");
}

export function encryptBackupBundle(
  bundlePath: string,
  destinationPath: string,
  recoveryKey: string,
  createdAt = new Date().toISOString(),
): BackupEnvelopeManifest {
  const source = path.resolve(bundlePath);
  const destination = path.resolve(destinationPath);
  const { fd: inputFd, stat: sourceStat } = openRegularReadOnly(source);
  const plaintextBytes = sourceStat.size;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(recoveryKey, salt);
  const manifest: BackupEnvelopeManifest = {
    format: FORMAT,
    version: ENCRYPTED_BACKUP_VERSION,
    createdAt,
    payload: { file: path.basename(destination), bytes: plaintextBytes, sha256: "0".repeat(64) },
    protection: {
      algorithm: ALGORITHM,
      kdf: KDF,
      scryptN: SCRYPT_N,
      scryptR: SCRYPT_R,
      scryptP: SCRYPT_P,
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      authTag: "0".repeat(32),
      keyId: keyIdentifier(key),
      plaintextBytes,
    },
  };
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(envelopeAad(manifest), { plaintextLength: plaintextBytes });
  let outputFd: number | undefined;
  const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
  const encryptedDigest = crypto.createHash("sha256");
  let plaintextRead = 0;
  try {
    outputFd = fs.openSync(destination, "wx", 0o600);
    while (true) {
      const read = fs.readSync(inputFd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      plaintextRead += read;
      const encrypted = cipher.update(buffer.subarray(0, read));
      encryptedDigest.update(encrypted);
      writeAll(outputFd, encrypted);
    }
    if (plaintextRead !== plaintextBytes || fs.fstatSync(inputFd).size !== plaintextBytes) {
      throw new Error("Backup bundle changed while it was being encrypted.");
    }
    const finalBytes = cipher.final();
    encryptedDigest.update(finalBytes);
    writeAll(outputFd, finalBytes);
    manifest.payload.bytes = fs.fstatSync(outputFd).size;
  } catch (error) {
    if (outputFd !== undefined) {
      fs.closeSync(outputFd);
      outputFd = undefined;
    }
    fs.rmSync(destination, { force: true });
    throw error;
  } finally {
    fs.closeSync(inputFd);
    if (outputFd !== undefined) fs.closeSync(outputFd);
  }
  manifest.protection.authTag = cipher.getAuthTag().toString("hex");
  manifest.payload.sha256 = encryptedDigest.digest("hex");
  return manifest;
}

export function parseBackupEnvelopeManifest(manifestPath: string): BackupEnvelopeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read encrypted backup manifest at ${manifestPath}.`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Encrypted backup manifest is invalid.");
  const candidate = parsed as Record<string, unknown>;
  if (candidate.format === FORMAT && candidate.version !== ENCRYPTED_BACKUP_VERSION) {
    throw new Error(
      `Plaintext backup-set version ${String(candidate.version)} is retired. ` +
        "Create a version-4 encrypted backup while the original workspace is still available.",
    );
  }
  const payload = candidate.payload as Record<string, unknown> | undefined;
  const protection = candidate.protection as Record<string, unknown> | undefined;
  if (
    candidate.format !== FORMAT || candidate.version !== ENCRYPTED_BACKUP_VERSION ||
    typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt)) ||
    !payload || typeof payload.file !== "string" || path.basename(payload.file) !== payload.file ||
    !Number.isSafeInteger(payload.bytes) || Number(payload.bytes) <= 0 || !isHex(payload.sha256, 32) ||
    !protection || protection.algorithm !== ALGORITHM || protection.kdf !== KDF ||
    protection.scryptN !== SCRYPT_N || protection.scryptR !== SCRYPT_R || protection.scryptP !== SCRYPT_P ||
    !isHex(protection.salt, 16) || !isHex(protection.iv, 12) || !isHex(protection.authTag, 16) ||
    !isHex(protection.keyId, 32) || !Number.isSafeInteger(protection.plaintextBytes) ||
    Number(protection.plaintextBytes) <= 0 || Number(protection.plaintextBytes) > MAX_BUNDLE_BYTES
  ) {
    throw new Error("Encrypted backup manifest is invalid.");
  }
  return parsed as BackupEnvelopeManifest;
}

export function decryptBackupBundle(
  encryptedPath: string,
  outputBundlePath: string,
  manifest: BackupEnvelopeManifest,
  recoveryKey: string,
): void {
  const source = path.resolve(encryptedPath);
  const destination = path.resolve(outputBundlePath);
  if (manifest.payload.file !== path.basename(source)) {
    throw new Error("Encrypted backup filename does not match its manifest.");
  }
  const { fd: inputFd, stat } = openRegularReadOnly(source);
  try {
    if (stat.size !== manifest.payload.bytes || sha256Fd(inputFd) !== manifest.payload.sha256) {
      throw new Error("Encrypted backup payload hash or size does not match its manifest.");
    }
    const salt = Buffer.from(manifest.protection.salt, "hex");
    const key = deriveKey(recoveryKey, salt);
    const actualKeyId = Buffer.from(keyIdentifier(key), "hex");
    const expectedKeyId = Buffer.from(manifest.protection.keyId, "hex");
    if (!crypto.timingSafeEqual(actualKeyId, expectedKeyId)) {
      throw new Error("Recovery credential does not match this backup set.");
    }
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(manifest.protection.iv, "hex"));
    decipher.setAAD(envelopeAad(manifest), { plaintextLength: manifest.protection.plaintextBytes });
    decipher.setAuthTag(Buffer.from(manifest.protection.authTag, "hex"));
    const outputFd = fs.openSync(destination, "wx", 0o600);
    const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
    try {
      while (true) {
        const read = fs.readSync(inputFd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        writeAll(outputFd, decipher.update(buffer.subarray(0, read)));
      }
      writeAll(outputFd, decipher.final());
      if (fs.fstatSync(outputFd).size !== manifest.protection.plaintextBytes) {
        throw new Error("Decrypted backup size does not match its authenticated manifest.");
      }
    } catch (error) {
      fs.closeSync(outputFd);
      fs.rmSync(destination, { force: true });
      throw new Error("Encrypted backup authentication failed.", { cause: error });
    }
    fs.closeSync(outputFd);
  } finally {
    fs.closeSync(inputFd);
  }
}
