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
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'crypto';
import path from 'path';
import fs from 'fs';
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

function localBaseDir(): string {
  return process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), 'laro-uploads');
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
  const base = path.resolve(localBaseDir());
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

export async function storageRead(key: string, options?: { maxBytes: number }): Promise<Buffer> {
  const safeKey = sanitizeStorageKey(key);
  if (!safeKey) throw new Error('Storage key must contain at least one valid path segment');
  const label = 'Storage object';
  if (isS3Configured()) {
    const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: safeKey }));
    if (!response.Body) throw new Error(`Storage object is empty: ${safeKey}`);
    if (options && typeof response.ContentLength === 'number' && response.ContentLength > options.maxBytes) {
      throw new Error(`${label} exceeds the ${options.maxBytes} byte read limit`);
    }
    if (options) return collectBoundedBytes(response.Body, { maxBytes: options.maxBytes, label });
    return Buffer.from(await response.Body.transformToByteArray());
  }
  const full = resolveLocalPath(safeKey);
  if (!fs.existsSync(full)) throw new Error(`Local storage object not found: ${safeKey}`);
  if (options) {
    const size = fs.statSync(full).size;
    if (size > options.maxBytes) {
      throw new Error(`${label} exceeds the ${options.maxBytes} byte read limit`);
    }
  }
  return fs.readFileSync(full);
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
