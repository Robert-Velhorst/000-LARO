import { createHash } from 'crypto';
import { constants } from 'fs';
import * as fs from 'fs/promises';

export type FileReviewReason = 'missing' | 'symlink' | 'not_regular' | 'changed' | 'size' | 'unreadable';

export class FileReviewRequiredError extends Error {
  readonly reason: FileReviewReason;
  readonly snapshot?: FileSnapshot;

  constructor(reason: FileReviewReason, message: string, snapshot?: FileSnapshot) {
    super(message);
    this.name = 'FileReviewRequiredError';
    this.reason = reason;
    this.snapshot = snapshot;
  }
}

export interface FileSnapshot {
  bytes: Buffer;
  sha256: string;
  identity: string;
  realPath: string;
  size: number;
  modifiedAt: Date;
}

export interface ApprovedFileSnapshot {
  approvedContentHash?: string;
  approvedIdentity?: string;
  approvedRealPath?: string;
}

type StableBigIntStats = {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

function stableStatValue(stats: StableBigIntStats): string {
  return [
    stats.dev,
    stats.ino,
    stats.mode,
    stats.size,
    stats.mtimeNs,
    stats.ctimeNs,
    stats.birthtimeNs,
  ].map(String).join(':');
}

function sameOpenedFile(left: StableBigIntStats, right: StableBigIntStats): boolean {
  return stableStatValue(left) === stableStatValue(right);
}

function reviewError(error: unknown): FileReviewRequiredError {
  if (error instanceof FileReviewRequiredError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  if (code === 'ENOENT') {
    return new FileReviewRequiredError('missing', 'The file is missing. Restore it and review it again.');
  }
  if (code === 'ELOOP') {
    return new FileReviewRequiredError('symlink', 'Linked files cannot be approved for upload.');
  }
  return new FileReviewRequiredError('unreadable', 'The file can no longer be read safely. Review it again.');
}

/**
 * Read one regular file through a stable file handle. The path and open handle
 * are compared before and after the read so path replacement and symlink swaps
 * cannot silently change the bytes being approved or uploaded.
 */
export async function inspectRegularFile(filePath: string, maxBytes: number): Promise<FileSnapshot> {
  let handle: fs.FileHandle | undefined;
  try {
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await fs.open(filePath, constants.O_RDONLY | noFollow);
    const openedBefore = await handle.stat({ bigint: true });
    const pathBefore = await fs.lstat(filePath, { bigint: true });
    if (pathBefore.isSymbolicLink()) {
      throw new FileReviewRequiredError('symlink', 'Linked files cannot be approved for upload.');
    }
    if (!pathBefore.isFile() || !openedBefore.isFile()) {
      throw new FileReviewRequiredError('not_regular', 'Only regular files can be approved for upload.');
    }
    if (!sameOpenedFile(pathBefore, openedBefore)) {
      throw new FileReviewRequiredError('changed', 'The file changed while it was being checked. Review it again.');
    }
    const realPathBefore = await fs.realpath(filePath);
    if (openedBefore.size < 1n || openedBefore.size > BigInt(maxBytes)) {
      throw new FileReviewRequiredError('size', 'Evidence files must be between 1 byte and 7 MB.');
    }

    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const pathAfter = await fs.lstat(filePath, { bigint: true });
    const realPathAfter = await fs.realpath(filePath);
    if (
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      !sameOpenedFile(openedBefore, openedAfter) ||
      !sameOpenedFile(openedAfter, pathAfter) ||
      realPathBefore !== realPathAfter ||
      bytes.length !== Number(openedAfter.size)
    ) {
      throw new FileReviewRequiredError('changed', 'The file changed while it was being checked. Review it again.');
    }

    const identity = createHash('sha256')
      .update(realPathAfter)
      .update('\0')
      .update(stableStatValue(openedAfter))
      .digest('hex');
    return {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      identity,
      realPath: realPathAfter,
      size: bytes.length,
      modifiedAt: new Date(Number(openedAfter.mtimeNs / 1_000_000n)),
    };
  } catch (error) {
    throw reviewError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function snapshotMatches(
  snapshot: FileSnapshot,
  expected: { contentHash?: string; identity?: string; realPath?: string },
): boolean {
  return Boolean(
    expected.contentHash &&
    expected.identity &&
    expected.realPath &&
    snapshot.sha256 === expected.contentHash &&
    snapshot.identity === expected.identity &&
    snapshot.realPath === expected.realPath
  );
}

export async function readApprovedFile(
  filePath: string,
  approved: ApprovedFileSnapshot,
  maxBytes: number,
): Promise<FileSnapshot> {
  if (!approved.approvedContentHash || !approved.approvedIdentity || !approved.approvedRealPath) {
    throw new FileReviewRequiredError('changed', 'This file has not been approved. Review it before uploading.');
  }
  const snapshot = await inspectRegularFile(filePath, maxBytes);
  if (!snapshotMatches(snapshot, {
    contentHash: approved.approvedContentHash,
    identity: approved.approvedIdentity,
    realPath: approved.approvedRealPath,
  })) {
    throw new FileReviewRequiredError(
      'changed',
      'The file changed after approval. Review it again before uploading.',
      snapshot,
    );
  }
  return snapshot;
}
