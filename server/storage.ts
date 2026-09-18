/**
 * File storage helpers — S3 with a real local-disk fallback.
 *
 * Phase 015 (storage, files, uploads & media safety):
 *  - Storage keys are sanitized to prevent path traversal (../, absolute paths,
 *    control chars, backslashes).
 *  - When S3 is not configured, files are written to a real local directory
 *    (LOCAL_STORAGE_DIR, default <cwd>/laro-uploads) instead of the previous
 *    behaviour that logged a warning and dropped the bytes while returning a
 *    fake `/local/<key>` URL. That silent data loss is fixed.
 *  - hashBuffer() provides a sha256 content hash for evidence provenance.
 *  - Local reads/writes are confined to the base directory (defence in depth).
 */
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import { PassThrough, Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { collectBoundedBytes } from './boundedBytes';

const s3 = new S3Client({
  region: process.env.AWS_S3_REGION || 'eu-west-1',
  credentials: process.env.AWS_S3_ACCESS_KEY && process.env.AWS_S3_SECRET_KEY ? {
    accessKeyId:     process.env.AWS_S3_ACCESS_KEY || '',
    secretAccessKey: process.env.AWS_S3_SECRET_KEY || '',
  } : undefined,
});

const BUCKET = process.env.AWS_S3_BUCKET || 'laro-evidence';

// Control characters (0x00-0x1F and 0x7F) to strip from keys/filenames.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function isS3Configured(): boolean {
  return !!process.env.AWS_S3_BUCKET;
}

export function getLocalStorageDirectory(): string {
  return path.resolve(process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), 'laro-uploads'));
}

/**
 * Sanitize a storage key so it can never escape its namespace. Each path
 * segment is stripped of traversal (`..`), separators are normalized, and
 * control characters are removed. Preserves forward-slash subdirectories.
 */
export function sanitizeStorageKey(key: string): string {
  const cleaned = key
    .replace(/\\/g, '/')       // backslashes -> forward slashes
    .replace(CONTROL_CHARS, '') // strip NUL + control chars
    .replace(/^\/+/, '');      // no absolute paths
  const segments = cleaned
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  return segments.join('/');
}

/** Sanitize a single filename component (no directories allowed). */
export function sanitizeFilename(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  const out = base
    .replace(CONTROL_CHARS, '')
    .replace(/[/\\]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return out || 'file';
}

/** sha256 hex digest of a buffer/string — used for evidence provenance. */
export function hashBuffer(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

function resolveLocalPath(key: string): string {
  const base = getLocalStorageDirectory();
  const full = path.resolve(base, key);
  // Defence in depth: ensure the resolved path stays inside the base dir.
  if (full !== base && !full.startsWith(base + path.sep)) {
    throw new Error(`Refusing to access path outside storage base: ${key}`);
  }
  return full;
}

export async function storagePut(
  key: string,
  body: Buffer | string,
  contentType = 'application/octet-stream'
): Promise<{ key: string; url: string; sha256: string }> {
  const safeKey = sanitizeStorageKey(key);
  if (!safeKey) throw new Error('Storage key must contain at least one valid path segment');
  const bodyBuffer = typeof body === 'string' ? Buffer.from(body) : body;
  const sha256 = hashBuffer(bodyBuffer);

  if (isS3Configured()) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: safeKey, Body: bodyBuffer, ContentType: contentType }));
    return { key: safeKey, url: `https://${BUCKET}.s3.amazonaws.com/${safeKey}`, sha256 };
  }

  // Real local fallback — actually persist the bytes.
  const full = resolveLocalPath(safeKey);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bodyBuffer);
  return { key: safeKey, url: `file://${full}`, sha256 };
}

export interface StorageStreamPutOptions {
  maxBytes: number;
  expectedBytes?: number;
  signal?: AbortSignal;
}

function readableByteSource(source: unknown): Readable {
  if (source instanceof Readable) return source;
  if (Buffer.isBuffer(source) || source instanceof Uint8Array || source instanceof ArrayBuffer || typeof source === 'string') {
    const value = source instanceof ArrayBuffer ? Buffer.from(source) : source;
    return Readable.from([value]);
  }
  const iterable = source as AsyncIterable<unknown> | null;
  if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
    return Readable.from(iterable);
  }
  throw new Error('Storage byte source is not a readable stream');
}

/**
 * Persist a bounded stream without first materializing the complete object in
 * process memory. Local writes use an atomic temporary file; S3 consumes the
 * same bounded/hash-counting pipeline directly.
 */
export async function storagePutStream(
  key: string,
  source: unknown,
  contentType: string,
  options: StorageStreamPutOptions,
): Promise<{ key: string; url: string; sha256: string; bytes: number }> {
  const safeKey = sanitizeStorageKey(key);
  if (!safeKey) throw new Error('Storage key must contain at least one valid path segment');
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('Storage stream maxBytes must be a positive safe integer');
  }
  if (options.expectedBytes !== undefined && (
    !Number.isSafeInteger(options.expectedBytes) ||
    options.expectedBytes < 1 ||
    options.expectedBytes > options.maxBytes
  )) {
    throw new Error('Storage stream expectedBytes must fit within maxBytes');
  }
  if (options.signal?.aborted) throw new Error('Storage write was cancelled');

  const input = readableByteSource(source);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer | Uint8Array | string, encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as any, encoding as BufferEncoding);
      bytes += value.length;
      if (bytes > options.maxBytes) {
        callback(new Error(`Storage object exceeds the ${options.maxBytes} byte write limit`));
        return;
      }
      hash.update(value);
      callback(null, value);
    },
  });

  const assertComplete = () => {
    if (bytes < 1) throw new Error('Storage object is empty');
    if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) {
      throw new Error('Storage object size changed after metadata preflight');
    }
  };

  if (isS3Configured()) {
    const uploadBody = new PassThrough();
    try {
      const pumping = pipeline(input, meter, uploadBody, { signal: options.signal });
      const uploading = s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: safeKey,
        Body: uploadBody,
        ContentType: contentType,
        ...(options.expectedBytes !== undefined ? { ContentLength: options.expectedBytes } : {}),
      }), { abortSignal: options.signal });
      await Promise.all([pumping, uploading]);
      assertComplete();
      return { key: safeKey, url: `https://${BUCKET}.s3.amazonaws.com/${safeKey}`, sha256: hash.digest('hex'), bytes };
    } catch (error) {
      input.destroy();
      uploadBody.destroy();
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: safeKey })).catch(() => undefined);
      throw error;
    }
  }

  const full = resolveLocalPath(safeKey);
  const temporary = `${full}.upload-${randomUUID()}`;
  fs.mkdirSync(path.dirname(full), { recursive: true });
  try {
    await pipeline(input, meter, fs.createWriteStream(temporary, { flags: 'wx' }), { signal: options.signal });
    assertComplete();
    await fs.promises.rename(temporary, full);
    return { key: safeKey, url: `file://${full}`, sha256: hash.digest('hex'), bytes };
  } catch (error) {
    input.destroy();
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function storageGet(key: string): Promise<string> {
  const safeKey = sanitizeStorageKey(key);
  if (!safeKey) throw new Error('Storage key must contain at least one valid path segment');
  if (isS3Configured()) {
    const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: safeKey });
    return getSignedUrl(s3, cmd, { expiresIn: 3600 });
  }
  const full = resolveLocalPath(safeKey);
  if (!fs.existsSync(full)) throw new Error(`Local storage object not found: ${safeKey}`);
  return `file://${full}`;
}

export interface StorageBackupObject {
  body: Buffer;
  contentType: string;
}

async function readStorageObject(
  key: string,
  options?: { maxBytes: number },
): Promise<StorageBackupObject> {
  const safeKey = sanitizeStorageKey(key);
  if (!safeKey) throw new Error('Storage key must contain at least one valid path segment');
  const label = 'Storage object';
  if (isS3Configured()) {
    const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: safeKey }));
    if (!response.Body) throw new Error(`Storage object is empty: ${safeKey}`);
    if (options && typeof response.ContentLength === 'number' && response.ContentLength > options.maxBytes) {
      throw new Error(`${label} exceeds the ${options.maxBytes} byte read limit`);
    }
    const body = options
      ? await collectBoundedBytes(response.Body, { maxBytes: options.maxBytes, label })
      : Buffer.from(await response.Body.transformToByteArray());
    return { body, contentType: response.ContentType || 'application/octet-stream' };
  }
  const full = resolveLocalPath(safeKey);
  if (!fs.existsSync(full)) throw new Error(`Local storage object not found: ${safeKey}`);
  if (options) {
    const size = fs.statSync(full).size;
    if (size > options.maxBytes) {
      throw new Error(`${label} exceeds the ${options.maxBytes} byte read limit`);
    }
  }
  return { body: fs.readFileSync(full), contentType: 'application/octet-stream' };
}

export async function storageRead(key: string, options?: { maxBytes: number }): Promise<Buffer> {
  return (await readStorageObject(key, options)).body;
}

export async function storageReadForBackup(
  key: string,
  options: { maxBytes: number },
): Promise<StorageBackupObject> {
  return readStorageObject(key, options);
}

export async function storageOpenReadStream(
  key: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<{ stream: Readable; declaredBytes: number | null; completion: Promise<void> }> {
  if (options.signal?.aborted) throw new Error("Storage read was cancelled");
  const safeKey = sanitizeStorageKey(key);
  if (!safeKey) throw new Error('Storage key must contain at least one valid path segment');
  let source: Readable;
  let declaredBytes: number | null = null;
  if (isS3Configured()) {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: safeKey }),
      { abortSignal: options.signal },
    );
    if (!response.Body) throw new Error(`Storage object is empty: ${safeKey}`);
    declaredBytes = typeof response.ContentLength === 'number' ? response.ContentLength : null;
    if (declaredBytes !== null && declaredBytes > options.maxBytes) {
      if (response.Body instanceof Readable) response.Body.destroy();
      else if (typeof response.Body.transformToWebStream === 'function') {
        void response.Body.transformToWebStream().cancel().catch(() => undefined);
      }
      throw new Error(`Storage object exceeds the ${options.maxBytes} byte read limit`);
    }
    source = response.Body instanceof Readable
      ? response.Body
      : Readable.from(response.Body as unknown as AsyncIterable<Uint8Array>);
  } else {
    const full = resolveLocalPath(safeKey);
    if (!fs.existsSync(full)) throw new Error(`Local storage object not found: ${safeKey}`);
    declaredBytes = fs.statSync(full).size;
    if (declaredBytes > options.maxBytes) {
      throw new Error(`Storage object exceeds the ${options.maxBytes} byte read limit`);
    }
    if (options.signal?.aborted) throw new Error("Storage read was cancelled");
    source = fs.createReadStream(full);
  }

  let actualBytes = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      actualBytes += chunk.length;
      callback(
        actualBytes > options.maxBytes
          ? new Error(`Storage object exceeds the ${options.maxBytes} byte read limit`)
          : null,
        chunk,
      );
    },
  });
  const completion = pipeline(source, limiter, { signal: options.signal });
  return { stream: limiter, declaredBytes, completion };
}

/** Metadata-only availability check used before issuing a download ticket. */
export async function storageInspect(
  key: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<{ bytes: number | null }> {
  if (options.signal?.aborted) throw new Error("Storage inspection was cancelled");
  const safeKey = sanitizeStorageKey(key);
  if (!safeKey) throw new Error('Storage key must contain at least one valid path segment');
  if (isS3Configured()) {
    const response = await s3.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: safeKey }),
      { abortSignal: options.signal },
    );
    const bytes = typeof response.ContentLength === 'number' ? response.ContentLength : null;
    if (bytes !== null && bytes > options.maxBytes) {
      throw new Error(`Storage object exceeds the ${options.maxBytes} byte read limit`);
    }
    return { bytes };
  }
  const full = resolveLocalPath(safeKey);
  if (!fs.existsSync(full)) throw new Error(`Local storage object not found: ${safeKey}`);
  const bytes = fs.statSync(full).size;
  if (bytes > options.maxBytes) {
    throw new Error(`Storage object exceeds the ${options.maxBytes} byte read limit`);
  }
  return { bytes };
}

export async function storageDelete(key: string): Promise<void> {
  const safeKey = sanitizeStorageKey(key);
  if (!safeKey) throw new Error('Storage key must contain at least one valid path segment');
  if (isS3Configured()) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: safeKey }));
    return;
  }
  const full = resolveLocalPath(safeKey);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}
