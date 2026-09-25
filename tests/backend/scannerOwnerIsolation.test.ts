import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const electronState = vi.hoisted(() => ({ userDataPath: '' }));
vi.mock('electron', () => ({ app: { getPath: () => electronState.userDataPath } }));

import {
  addFile,
  cancelPausedScanUpload,
  cleanupOldScans,
  closeDatabase,
  createScan,
  eraseScannerHistory,
  exportScannerHistory,
  getRecentScans,
  getScan,
  getScanCaseId,
  getScanFiles,
  initDatabase,
  setScanFileSelection,
  updateScanProgress,
} from '../../src-main/database';

function addPath(scanId: string, id: string, absolutePath: string): void {
  addFile({
    id,
    path: absolutePath,
    name: `${id}.txt`,
    size: 1,
    mimeType: 'text/plain',
    modifiedAt: new Date(),
    uploadStatus: 'pending',
    uploadProgress: 0,
  }, scanId);
}

describe('desktop scanner owner isolation and retention', () => {
  beforeEach(async () => {
    electronState.userDataPath = await mkdtemp(join(tmpdir(), 'laro-owner-isolation-'));
  });

  afterEach(async () => {
    closeDatabase();
    await rm(electronState.userDataPath, { recursive: true, force: true });
  });

  it('does not expose, select, resume, or erase another owner\'s scan', async () => {
    initDatabase();
    createScan('scan-a', 'owner-a', 'case-a', 'A private case', false, []);
    createScan('scan-b', 'owner-b', 'case-b', 'B private case', false, []);
    addPath('scan-a', 'file-a', '/private/a.txt');
    addPath('scan-b', 'file-b', '/private/b.txt');
    updateScanProgress({ scanId: 'scan-a', status: 'upload-paused' });

    expect(getScan('scan-a', 'owner-b')).toBeNull();
    expect(getScanFiles('scan-a', 'owner-b')).toEqual([]);
    expect(getScanCaseId('scan-a', 'owner-b')).toBeNull();
    expect(getRecentScans('owner-b').map((scan) => scan.id)).toEqual(['scan-b']);
    await expect(setScanFileSelection('scan-a', ['file-a'], 'owner-b')).rejects.toThrow(/owned scan/i);
    await expect(setScanFileSelection('scan-b', ['file-a'], 'owner-b')).rejects.toThrow(/unavailable/i);
    expect(cancelPausedScanUpload('scan-a', 'owner-b')).toBe(false);
    expect(getScan('scan-a', 'owner-a')?.status).toBe('upload-paused');

    expect(JSON.stringify(exportScannerHistory('owner-b'))).not.toContain('/private/a.txt');
    expect(eraseScannerHistory('owner-b')).toEqual({ scans: 1, files: 1 });
    expect(getScanFiles('scan-a', 'owner-a')).toHaveLength(1);

    closeDatabase();
    initDatabase();
    expect(getScan('scan-a', 'owner-b')).toBeNull();
    expect(getScanFiles('scan-a', 'owner-a')[0].path).toBe('/private/a.txt');
    expect(eraseScannerHistory('owner-a')).toEqual({ scans: 1, files: 1 });
    expect(exportScannerHistory('owner-a')).toEqual({ scans: [], files: [] });
  });

  it('purges expired path records but preserves an active scan until a later sweep', () => {
    initDatabase();
    createScan('expired', 'owner-a', 'case-a', 'Old', false, []);
    createScan('active', 'owner-a', 'case-a', 'Running', false, []);
    addPath('expired', 'old-file', '/private/old.txt');
    addPath('active', 'active-file', '/private/active.txt');
    const sqlite = new Database(join(electronState.userDataPath, 'laro-agent.db'));
    try {
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString();
      sqlite.prepare('UPDATE scans SET startedAt = ? WHERE id IN (?, ?)').run(old, 'expired', 'active');
    } finally {
      sqlite.close();
    }

    expect(cleanupOldScans(new Date(), ['active'])).toEqual({ scans: 1, files: 1, quarantined: 0 });
    expect(getScanFiles('expired', 'owner-a')).toEqual([]);
    expect(getScanFiles('active', 'owner-a')).toHaveLength(1);
    expect(cleanupOldScans()).toEqual({ scans: 1, files: 1, quarantined: 0 });
    expect(exportScannerHistory('owner-a')).toEqual({ scans: [], files: [] });
  });

  it('quarantines pre-owner scans and destroys their unassignable paths', () => {
    const sqlite = new Database(join(electronState.userDataPath, 'laro-agent.db'));
    try {
      sqlite.exec(`
        CREATE TABLE scans (
          id TEXT PRIMARY KEY, caseId TEXT NOT NULL, caseName TEXT NOT NULL,
          status TEXT NOT NULL, autoUpload INTEGER NOT NULL, excludedFolders TEXT,
          totalFiles INTEGER DEFAULT 0, scannedFiles INTEGER DEFAULT 0,
          uploadedFiles INTEGER DEFAULT 0, failedFiles INTEGER DEFAULT 0,
          totalSize INTEGER DEFAULT 0, uploadedSize INTEGER DEFAULT 0,
          currentFile TEXT, errorMessage TEXT, startedAt TEXT NOT NULL, completedAt TEXT
        );
        CREATE TABLE files (
          id TEXT PRIMARY KEY, scanId TEXT NOT NULL, path TEXT NOT NULL,
          name TEXT NOT NULL, size INTEGER NOT NULL, mimeType TEXT,
          modifiedAt TEXT, uploadStatus TEXT NOT NULL, uploadProgress INTEGER DEFAULT 0,
          errorMessage TEXT, FOREIGN KEY(scanId) REFERENCES scans(id)
        );
      `);
      sqlite.prepare(`INSERT INTO scans
        (id, caseId, caseName, status, autoUpload, excludedFolders, currentFile, errorMessage, startedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('legacy', 'sensitive-case', 'Private case', 'review', 0,
          '["/private/folder"]', '/private/old.txt', '/private/error', new Date().toISOString());
      sqlite.prepare(`INSERT INTO files
        (id, scanId, path, name, size, uploadStatus, errorMessage)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('legacy-file', 'legacy', '/private/old.txt', 'old.txt', 1, 'pending', '/private/error');
    } finally {
      sqlite.close();
    }

    initDatabase();
    expect(getScan('legacy', 'owner-a')).toBeNull();
    expect(exportScannerHistory('owner-a')).toEqual({ scans: [], files: [] });
    const migrated = new Database(join(electronState.userDataPath, 'laro-agent.db'));
    try {
      const row = migrated.prepare('SELECT * FROM scans WHERE id = ?').get('legacy') as Record<string, unknown>;
      expect(row.status).toBe('quarantined');
      expect(row.quarantinedAt).toEqual(expect.any(String));
      expect(row.caseId).toBe('');
      expect(JSON.stringify(row)).not.toContain('/private');
      expect((migrated.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count).toBe(0);
    } finally {
      migrated.close();
    }
  });
});
