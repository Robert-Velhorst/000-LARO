import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  FileReviewRequiredError,
  inspectRegularFile,
  readApprovedFile,
} from '../../src-main/fileApproval';

const MAX_BYTES = 7 * 1024 * 1024;

describe('desktop scanner immutable file approval', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function fixture(contents = 'approved evidence') {
    const directory = await mkdtemp(join(tmpdir(), 'laro-scanner-approval-'));
    temporaryDirectories.push(directory);
    const filePath = join(directory, 'evidence.txt');
    await writeFile(filePath, contents);
    const approved = await inspectRegularFile(filePath, MAX_BYTES);
    return { directory, filePath, approved };
  }

  it('returns the exact approved bytes when the file is unchanged', async () => {
    const { filePath, approved } = await fixture();
    const result = await readApprovedFile(filePath, {
      approvedContentHash: approved.sha256,
      approvedIdentity: approved.identity,
      approvedRealPath: approved.realPath,
    }, MAX_BYTES);

    expect(result.bytes).toEqual(approved.bytes);
    expect(result.sha256).toBe(approved.sha256);
    expect(result.identity).toBe(approved.identity);
  });

  it('returns an edited file to review instead of reading it under the old approval', async () => {
    const { filePath, approved } = await fixture();
    await writeFile(filePath, 'edited after review');

    await expect(readApprovedFile(filePath, {
      approvedContentHash: approved.sha256,
      approvedIdentity: approved.identity,
      approvedRealPath: approved.realPath,
    }, MAX_BYTES)).rejects.toMatchObject({
      name: 'FileReviewRequiredError',
      reason: 'changed',
    });
  });

  it('detects same-path replacement even when the replacement has identical bytes', async () => {
    const { filePath, approved } = await fixture();
    await rm(filePath);
    await writeFile(filePath, approved.bytes);

    await expect(readApprovedFile(filePath, {
      approvedContentHash: approved.sha256,
      approvedIdentity: approved.identity,
      approvedRealPath: approved.realPath,
    }, MAX_BYTES)).rejects.toBeInstanceOf(FileReviewRequiredError);
  });

  it('returns a deleted approved file to review with a truthful reason', async () => {
    const { filePath, approved } = await fixture();
    await rm(filePath);

    await expect(readApprovedFile(filePath, {
      approvedContentHash: approved.sha256,
      approvedIdentity: approved.identity,
      approvedRealPath: approved.realPath,
    }, MAX_BYTES)).rejects.toMatchObject({ reason: 'missing' });
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink substituted at the approved path', async () => {
    const { directory, filePath, approved } = await fixture();
    const replacement = join(directory, 'replacement.txt');
    await writeFile(replacement, approved.bytes);
    await rm(filePath);
    await symlink(replacement, filePath, 'file');

    await expect(readApprovedFile(filePath, {
      approvedContentHash: approved.sha256,
      approvedIdentity: approved.identity,
      approvedRealPath: approved.realPath,
    }, MAX_BYTES)).rejects.toMatchObject({ reason: 'symlink' });
  });

  it.skipIf(process.platform === 'win32')('rejects parent-link substitution that redirects the approved path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'laro-scanner-link-'));
    temporaryDirectories.push(directory);
    const first = join(directory, 'first');
    const second = join(directory, 'second');
    const linked = join(directory, 'linked');
    await mkdir(first);
    await mkdir(second);
    await writeFile(join(first, 'evidence.txt'), 'same evidence bytes');
    await writeFile(join(second, 'evidence.txt'), 'same evidence bytes');
    await symlink(first, linked, 'dir');
    const linkedFile = join(linked, 'evidence.txt');
    const approved = await inspectRegularFile(linkedFile, MAX_BYTES);

    await rm(linked);
    await symlink(second, linked, 'dir');

    await expect(readApprovedFile(linkedFile, {
      approvedContentHash: approved.sha256,
      approvedIdentity: approved.identity,
      approvedRealPath: approved.realPath,
    }, MAX_BYTES)).rejects.toMatchObject({ reason: 'changed' });
  });
});
