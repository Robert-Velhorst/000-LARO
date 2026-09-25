import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const electronState = vi.hoisted(() => ({ userDataPath: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => electronState.userDataPath },
}));

import {
  addFile,
  closeDatabase,
  createScan,
  getScanFiles,
  initDatabase,
  setScanFileSelection,
} from '../../src-main/database';
import { inspectRegularFile } from '../../src-main/fileApproval';
import { MAX_EVIDENCE_FILE_BYTES } from '../../shared/evidenceFiles';

describe('desktop scanner review persistence', () => {
  beforeEach(async () => {
    electronState.userDataPath = await mkdtemp(join(tmpdir(), 'laro-scanner-db-'));
    initDatabase();
    createScan('scan-1', 'owner-1', 'case-1', 'Case one', false, []);
  });

  afterEach(async () => {
    closeDatabase();
    await rm(electronState.userDataPath, { recursive: true, force: true });
  });

  it('approves an unchanged snapshot and requires explicit re-review after an edit', async () => {
    const filePath = join(electronState.userDataPath, 'evidence.txt');
    await writeFile(filePath, 'original evidence');
    const discovered = await inspectRegularFile(filePath, MAX_EVIDENCE_FILE_BYTES);
    addFile({
      id: 'file-1',
      path: filePath,
      name: 'evidence.txt',
      size: discovered.size,
      mimeType: 'text/plain',
      modifiedAt: discovered.modifiedAt,
      uploadStatus: 'pending',
      uploadProgress: 0,
      contentHash: discovered.sha256,
      sourceIdentity: discovered.identity,
      sourceRealPath: discovered.realPath,
    }, 'scan-1');

    await expect(setScanFileSelection('scan-1', ['file-1'], 'owner-1')).resolves.toEqual({
      selected: 1,
      reviewRequired: 0,
    });
    expect(getScanFiles('scan-1', 'owner-1')[0]).toMatchObject({
      uploadStatus: 'pending',
      approvedContentHash: discovered.sha256,
      approvedIdentity: discovered.identity,
      evidenceId: undefined,
    });

    await writeFile(filePath, 'edited after the first review');
    await expect(setScanFileSelection('scan-1', ['file-1'], 'owner-1')).resolves.toEqual({
      selected: 0,
      reviewRequired: 1,
    });
    const changed = getScanFiles('scan-1', 'owner-1')[0];
    expect(changed).toMatchObject({
      uploadStatus: 'review_required',
      approvedContentHash: undefined,
      approvedIdentity: undefined,
    });
    expect(changed.contentHash).not.toBe(discovered.sha256);
    expect(changed.errorMessage).toMatch(/changed after scanning/i);

    await expect(setScanFileSelection('scan-1', ['file-1'], 'owner-1')).resolves.toEqual({
      selected: 1,
      reviewRequired: 0,
    });
    expect(getScanFiles('scan-1', 'owner-1')[0]).toMatchObject({
      uploadStatus: 'pending',
      approvedContentHash: changed.contentHash,
      approvedIdentity: changed.sourceIdentity,
      errorMessage: undefined,
    });
  });
});
