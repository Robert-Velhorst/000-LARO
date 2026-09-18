/**
 * Local SQLite database for agent state management
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import { FileItem, ScanProgress, ScanStatus, UploadStatus } from '../shared/types';
import { MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';
import { remoteScannerDatabaseName } from './remoteConnection';
import { inspectRegularFile, snapshotMatches, type FileSnapshot } from './fileApproval';

let db: Database.Database | null = null;

/**
 * Initialize the local database
 */
export function initDatabase(serverUrl?: string): void {
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, serverUrl ? remoteScannerDatabaseName(serverUrl) : 'laro-agent.db');
  
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS scans (
      id TEXT PRIMARY KEY,
      caseId TEXT NOT NULL,
      caseName TEXT NOT NULL,
      status TEXT NOT NULL,
      autoUpload INTEGER NOT NULL,
      excludedFolders TEXT,
      totalFiles INTEGER DEFAULT 0,
      scannedFiles INTEGER DEFAULT 0,
      uploadedFiles INTEGER DEFAULT 0,
      failedFiles INTEGER DEFAULT 0,
      skippedFiles INTEGER DEFAULT 0,
      totalSize INTEGER DEFAULT 0,
      uploadedSize INTEGER DEFAULT 0,
      skippedSize INTEGER DEFAULT 0,
      limitReason TEXT,
      currentFile TEXT,
      errorMessage TEXT,
      startedAt TEXT NOT NULL,
      completedAt TEXT
    );
    
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      scanId TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      mimeType TEXT,
      modifiedAt TEXT,
      uploadStatus TEXT NOT NULL,
      uploadProgress INTEGER DEFAULT 0,
      errorMessage TEXT,
      contentHash TEXT,
      sourceIdentity TEXT,
      sourceRealPath TEXT,
      approvedContentHash TEXT,
      approvedIdentity TEXT,
      approvedRealPath TEXT,
      approvedAt TEXT,
      evidenceId TEXT,
      FOREIGN KEY (scanId) REFERENCES scans(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_files_scanId ON files(scanId);
    CREATE INDEX IF NOT EXISTS idx_files_uploadStatus ON files(uploadStatus);
  `);

  const existingScanColumns = new Set(
    (db.prepare('PRAGMA table_info(scans)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  const scanColumns: Array<[string, string]> = [
    ['skippedFiles', 'INTEGER DEFAULT 0'],
    ['skippedSize', 'INTEGER DEFAULT 0'],
    ['limitReason', 'TEXT'],
  ];
  for (const [column, type] of scanColumns) {
    if (!existingScanColumns.has(column)) db.exec(`ALTER TABLE scans ADD COLUMN ${column} ${type}`);
  }

  // Existing desktop installations receive additive local-state migrations.
  const existingFileColumns = new Set(
    (db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  const fileColumns: Array<[string, string]> = [
    ['contentHash', 'TEXT'],
    ['sourceIdentity', 'TEXT'],
    ['sourceRealPath', 'TEXT'],
    ['approvedContentHash', 'TEXT'],
    ['approvedIdentity', 'TEXT'],
    ['approvedRealPath', 'TEXT'],
    ['approvedAt', 'TEXT'],
    ['evidenceId', 'TEXT'],
  ];
  for (const [column, type] of fileColumns) {
    if (!existingFileColumns.has(column)) db.exec(`ALTER TABLE files ADD COLUMN ${column} ${type}`);
  }

  // A process exit can leave a file and its parent scan in the transient
  // `uploading` state. Convert that to an explicit retryable pause so the next
  // launch can resume the approved bytes without rescanning them.
  db.exec(`
    UPDATE files
    SET uploadStatus = 'retryable', uploadProgress = 0,
      errorMessage = COALESCE(errorMessage, 'Upload was interrupted and can be resumed.')
    WHERE uploadStatus = 'uploading';

    UPDATE scans
    SET status = 'upload-paused', completedAt = NULL,
      errorMessage = COALESCE(errorMessage, 'Upload was interrupted and can be resumed.')
    WHERE status = 'uploading';
  `);
  
  console.log('[Database] Initialized at', dbPath);
}

/**
 * Close the database connection
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Create a new scan
 */
export function createScan(
  id: string,
  caseId: string,
  caseName: string,
  autoUpload: boolean,
  excludedFolders: string[]
): void {
  if (!db) throw new Error('Database not initialized');
  
  const stmt = db.prepare(`
    INSERT INTO scans (id, caseId, caseName, status, autoUpload, excludedFolders, startedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    id,
    caseId,
    caseName,
    'scanning',
    autoUpload ? 1 : 0,
    JSON.stringify(excludedFolders),
    new Date().toISOString()
  );
}

/**
 * Update scan progress
 */
export function updateScanProgress(progress: Partial<ScanProgress>): void {
  if (!db) throw new Error('Database not initialized');
  
  const updates: string[] = [];
  const values: any[] = [];
  
  if (progress.status !== undefined) {
    updates.push('status = ?');
    values.push(progress.status);
  }
  
  if (progress.totalFiles !== undefined) {
    updates.push('totalFiles = ?');
    values.push(progress.totalFiles);
  }
  
  if (progress.scannedFiles !== undefined) {
    updates.push('scannedFiles = ?');
    values.push(progress.scannedFiles);
  }
  
  if (progress.uploadedFiles !== undefined) {
    updates.push('uploadedFiles = ?');
    values.push(progress.uploadedFiles);
  }
  
  if (progress.failedFiles !== undefined) {
    updates.push('failedFiles = ?');
    values.push(progress.failedFiles);
  }

  if (progress.skippedFiles !== undefined) {
    updates.push('skippedFiles = ?');
    values.push(progress.skippedFiles);
  }
  
  if (progress.totalSize !== undefined) {
    updates.push('totalSize = ?');
    values.push(progress.totalSize);
  }
  
  if (progress.uploadedSize !== undefined) {
    updates.push('uploadedSize = ?');
    values.push(progress.uploadedSize);
  }

  if (progress.skippedSize !== undefined) {
    updates.push('skippedSize = ?');
    values.push(progress.skippedSize);
  }

  if (progress.limitReason !== undefined) {
    updates.push('limitReason = ?');
    values.push(progress.limitReason);
  }
  
  if (progress.currentFile !== undefined) {
    updates.push('currentFile = ?');
    values.push(progress.currentFile);
  }
  
  if (progress.errorMessage !== undefined) {
    updates.push('errorMessage = ?');
    values.push(progress.errorMessage);
  }
  
  if (progress.status === 'completed' || progress.status === 'failed' || progress.status === 'cancelled') {
    updates.push('completedAt = ?');
    values.push(new Date().toISOString());
  }
  
  if (updates.length === 0) return;
  
  values.push(progress.scanId);
  
  const stmt = db.prepare(`
    UPDATE scans SET ${updates.join(', ')} WHERE id = ?
  `);
  
  stmt.run(...values);
}

/**
 * Get scan by ID
 */
export function getScan(scanId: string): ScanProgress | null {
  if (!db) throw new Error('Database not initialized');
  
  const stmt = db.prepare('SELECT * FROM scans WHERE id = ?');
  const row = stmt.get(scanId) as any;
  
  if (!row) return null;
  
  return {
    scanId: row.id,
    status: row.status as ScanStatus,
    totalFiles: row.totalFiles,
    scannedFiles: row.scannedFiles,
    uploadedFiles: row.uploadedFiles,
    failedFiles: row.failedFiles,
    skippedFiles: row.skippedFiles,
    totalSize: row.totalSize,
    uploadedSize: row.uploadedSize,
    skippedSize: row.skippedSize,
    limitReason: row.limitReason,
    currentFile: row.currentFile,
    errorMessage: row.errorMessage,
  };
}

/**
 * Add file to scan
 */
export function addFile(file: FileItem, scanId: string): void {
  if (!db) throw new Error('Database not initialized');
  
  const stmt = db.prepare(`
    INSERT INTO files (
      id, scanId, path, name, size, mimeType, modifiedAt, uploadStatus, uploadProgress,
      contentHash, sourceIdentity, sourceRealPath
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    file.id,
    scanId,
    file.path,
    file.name,
    file.size,
    file.mimeType,
    file.modifiedAt.toISOString(),
    file.uploadStatus,
    file.uploadProgress,
    file.contentHash ?? null,
    file.sourceIdentity ?? null,
    file.sourceRealPath ?? null
  );
}

/**
 * Update file upload status
 */
export function updateFileStatus(
  fileId: string,
  status: UploadStatus,
  progress?: number,
  errorMessage?: string | null
): void {
  if (!db) throw new Error('Database not initialized');
  
  const updates = ['uploadStatus = ?'];
  const values: any[] = [status];
  
  if (progress !== undefined) {
    updates.push('uploadProgress = ?');
    values.push(progress);
  }
  
  if (errorMessage !== undefined) {
    updates.push('errorMessage = ?');
    values.push(errorMessage);
  }
  
  values.push(fileId);
  
  const stmt = db.prepare(`
    UPDATE files SET ${updates.join(', ')} WHERE id = ?
  `);
  
  stmt.run(...values);
}

function rowToFileItem(row: any): FileItem {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    size: row.size,
    mimeType: row.mimeType,
    modifiedAt: new Date(row.modifiedAt),
    uploadStatus: row.uploadStatus as UploadStatus,
    uploadProgress: row.uploadProgress,
    errorMessage: row.errorMessage ?? undefined,
    contentHash: row.contentHash ?? undefined,
    sourceIdentity: row.sourceIdentity ?? undefined,
    sourceRealPath: row.sourceRealPath ?? undefined,
    approvedContentHash: row.approvedContentHash ?? undefined,
    approvedIdentity: row.approvedIdentity ?? undefined,
    approvedRealPath: row.approvedRealPath ?? undefined,
    approvedAt: row.approvedAt ? new Date(row.approvedAt) : undefined,
    evidenceId: row.evidenceId ?? undefined,
  };
}

/**
 * Get files for a scan
 */
export function getScanFiles(scanId: string): FileItem[] {
  if (!db) throw new Error('Database not initialized');
  
  const stmt = db.prepare('SELECT * FROM files WHERE scanId = ? ORDER BY name');
  const rows = stmt.all(scanId) as any[];
  
  return rows.map(rowToFileItem);
}

export function getScanCaseId(scanId: string): string | null {
  if (!db) throw new Error('Database not initialized');
  const row = db.prepare('SELECT caseId FROM scans WHERE id = ?').get(scanId) as { caseId: string } | undefined;
  return row?.caseId ?? null;
}

export interface FileSelectionResult {
  selected: number;
  reviewRequired: number;
}

/**
 * Persist the user's review decision only when the file still matches the
 * bytes and filesystem identity presented by the scanner.
 */
export async function setScanFileSelection(
  scanId: string,
  selectedFileIds: string[],
): Promise<FileSelectionResult> {
  if (!db) throw new Error('Database not initialized');

  const selected = new Set(selectedFileIds);
  const rows = db
    .prepare("SELECT * FROM files WHERE scanId = ? AND uploadStatus IN ('pending', 'review_required', 'excluded', 'retryable', 'cancelled')")
    .all(scanId)
    .map(rowToFileItem);

  const outcomes: Array<{
    file: FileItem;
    kind: 'excluded' | 'approved' | 'review_required';
    snapshot?: FileSnapshot;
    errorMessage?: string;
  }> = [];
  for (const file of rows) {
    if (!selected.has(file.id)) {
      outcomes.push({ file, kind: 'excluded' });
      continue;
    }
    try {
      const snapshot = await inspectRegularFile(file.path, MAX_EVIDENCE_FILE_BYTES);
      const matchesDiscovery = snapshotMatches(snapshot, {
        contentHash: file.contentHash,
        identity: file.sourceIdentity,
        realPath: file.sourceRealPath,
      });
      outcomes.push({
        file,
        kind: matchesDiscovery ? 'approved' : 'review_required',
        snapshot,
        errorMessage: matchesDiscovery
          ? undefined
          : 'The file changed after scanning. Review the updated file before uploading.',
      });
    } catch (error) {
      outcomes.push({
        file,
        kind: 'review_required',
        errorMessage: error instanceof Error ? error.message : 'The file can no longer be checked safely. Review it again.',
      });
    }
  }

  const exclude = db.prepare(`
    UPDATE files SET uploadStatus = 'excluded', uploadProgress = 0, errorMessage = NULL,
      approvedContentHash = NULL, approvedIdentity = NULL, approvedRealPath = NULL, approvedAt = NULL
    WHERE id = ?
  `);
  const approve = db.prepare(`
    UPDATE files SET size = ?, modifiedAt = ?, contentHash = ?, sourceIdentity = ?, sourceRealPath = ?,
      approvedContentHash = ?, approvedIdentity = ?, approvedRealPath = ?, approvedAt = ?,
      uploadStatus = 'pending', uploadProgress = 0, errorMessage = NULL
    WHERE id = ?
  `);
  const requireReviewWithSnapshot = db.prepare(`
    UPDATE files SET size = ?, modifiedAt = ?, contentHash = ?, sourceIdentity = ?, sourceRealPath = ?,
      approvedContentHash = NULL, approvedIdentity = NULL, approvedRealPath = NULL, approvedAt = NULL,
      uploadStatus = 'review_required', uploadProgress = 0, errorMessage = ?
    WHERE id = ?
  `);
  const requireReview = db.prepare(`
    UPDATE files SET approvedContentHash = NULL, approvedIdentity = NULL, approvedRealPath = NULL, approvedAt = NULL,
      uploadStatus = 'review_required', uploadProgress = 0, errorMessage = ?
    WHERE id = ?
  `);
  const approvedAt = new Date().toISOString();
  const transaction = db.transaction(() => {
    for (const outcome of outcomes) {
      if (outcome.kind === 'excluded') {
        exclude.run(outcome.file.id);
      } else if (outcome.kind === 'approved' && outcome.snapshot) {
        approve.run(
          outcome.snapshot.size,
          outcome.snapshot.modifiedAt.toISOString(),
          outcome.snapshot.sha256,
          outcome.snapshot.identity,
          outcome.snapshot.realPath,
          outcome.snapshot.sha256,
          outcome.snapshot.identity,
          outcome.snapshot.realPath,
          approvedAt,
          outcome.file.id,
        );
      } else if (outcome.snapshot) {
        requireReviewWithSnapshot.run(
          outcome.snapshot.size,
          outcome.snapshot.modifiedAt.toISOString(),
          outcome.snapshot.sha256,
          outcome.snapshot.identity,
          outcome.snapshot.realPath,
          outcome.errorMessage,
          outcome.file.id,
        );
      } else {
        requireReview.run(outcome.errorMessage, outcome.file.id);
      }
    }
  });
  transaction();
  return {
    selected: outcomes.filter((outcome) => outcome.kind === 'approved').length,
    reviewRequired: outcomes.filter((outcome) => outcome.kind === 'review_required').length,
  };
}

export function markFileReviewRequired(
  fileId: string,
  errorMessage: string,
  snapshot?: FileSnapshot,
): void {
  if (!db) throw new Error('Database not initialized');
  if (snapshot) {
    db.prepare(`
      UPDATE files SET size = ?, modifiedAt = ?, contentHash = ?, sourceIdentity = ?, sourceRealPath = ?,
        approvedContentHash = NULL, approvedIdentity = NULL, approvedRealPath = NULL, approvedAt = NULL,
        uploadStatus = 'review_required', uploadProgress = 0, errorMessage = ?
      WHERE id = ?
    `).run(
      snapshot.size,
      snapshot.modifiedAt.toISOString(),
      snapshot.sha256,
      snapshot.identity,
      snapshot.realPath,
      errorMessage,
      fileId,
    );
    return;
  }
  db.prepare(`
    UPDATE files SET approvedContentHash = NULL, approvedIdentity = NULL, approvedRealPath = NULL, approvedAt = NULL,
      uploadStatus = 'review_required', uploadProgress = 0, errorMessage = ?
    WHERE id = ?
  `).run(errorMessage, fileId);
}

export function markFileUploaded(fileId: string, evidenceId: string): void {
  if (!db) throw new Error('Database not initialized');
  db.prepare(`
    UPDATE files SET uploadStatus = 'completed', uploadProgress = 100, errorMessage = NULL, evidenceId = ?
    WHERE id = ?
  `).run(evidenceId, fileId);
}

export function prepareScanUploadResume(scanId: string): void {
  if (!db) throw new Error('Database not initialized');
  db.transaction(() => {
    db!.prepare(`
      UPDATE files SET uploadStatus = 'pending', uploadProgress = 0, errorMessage = NULL
      WHERE scanId = ? AND uploadStatus IN ('retryable', 'uploading', 'cancelled')
    `).run(scanId);
    db!.prepare(`
      UPDATE scans SET status = 'uploading', errorMessage = NULL, completedAt = NULL
      WHERE id = ?
    `).run(scanId);
  })();
}

/** Cancel a persisted upload that no longer has an in-memory worker. */
export function cancelPausedScanUpload(scanId: string): boolean {
  if (!db) throw new Error('Database not initialized');
  return db.transaction(() => {
    const scan = db!.prepare('SELECT status FROM scans WHERE id = ?').get(scanId) as { status: string } | undefined;
    if (!scan || !['upload-paused', 'uploading'].includes(scan.status)) return false;
    db!.prepare(`
      UPDATE files SET uploadStatus = 'cancelled', uploadProgress = 0,
        errorMessage = 'Upload cancelled. The approved file can be resumed.'
      WHERE scanId = ? AND uploadStatus IN ('pending', 'retryable', 'uploading')
    `).run(scanId);
    const summary = getScanUploadSummary(scanId);
    updateScanProgress({
      scanId,
      status: 'cancelled',
      uploadedFiles: summary.completedFiles,
      failedFiles: summary.terminalFiles,
      uploadedSize: summary.completedBytes,
      errorMessage: 'Upload cancelled. Approved files can be resumed.',
    });
    return true;
  })();
}

export interface ScanUploadSummary {
  completedFiles: number;
  completedBytes: number;
  pendingFiles: number;
  retryableFiles: number;
  terminalFiles: number;
  cancelledFiles: number;
  reviewRequiredFiles: number;
}

export function getScanIngestionTotals(scanId: string): { items: number; bytes: number } {
  if (!db) throw new Error('Database not initialized');
  const row = db.prepare(`
    SELECT COUNT(*) AS items, COALESCE(SUM(size), 0) AS bytes
    FROM files
    WHERE scanId = ? AND uploadStatus NOT IN ('excluded', 'review_required')
  `).get(scanId) as { items: number; bytes: number };
  return { items: Number(row.items || 0), bytes: Number(row.bytes || 0) };
}

export function getScanUploadSummary(scanId: string): ScanUploadSummary {
  if (!db) throw new Error('Database not initialized');
  const rows = db.prepare(`
    SELECT uploadStatus AS status, COUNT(*) AS count,
      COALESCE(SUM(CASE WHEN uploadStatus = 'completed' THEN size ELSE 0 END), 0) AS completedBytes
    FROM files
    WHERE scanId = ?
    GROUP BY uploadStatus
  `).all(scanId) as Array<{ status: UploadStatus; count: number; completedBytes: number }>;
  const counts = new Map(rows.map((row) => [row.status, Number(row.count)]));
  return {
    completedFiles: counts.get('completed') ?? 0,
    completedBytes: rows.reduce((sum, row) => sum + Number(row.completedBytes || 0), 0),
    pendingFiles: counts.get('pending') ?? 0,
    retryableFiles: counts.get('retryable') ?? 0,
    terminalFiles: (counts.get('terminal') ?? 0) + (counts.get('failed') ?? 0),
    cancelledFiles: counts.get('cancelled') ?? 0,
    reviewRequiredFiles: counts.get('review_required') ?? 0,
  };
}

export function getReviewRequiredFileCount(scanId: string): number {
  if (!db) throw new Error('Database not initialized');
  const row = db.prepare(`
    SELECT COUNT(*) AS count FROM files WHERE scanId = ? AND uploadStatus = 'review_required'
  `).get(scanId) as { count: number };
  return Number(row.count);
}

/**
 * Get pending upload files
 */
export function getPendingFiles(scanId: string, limit: number = 10): FileItem[] {
  if (!db) throw new Error('Database not initialized');
  
  const stmt = db.prepare(`
    SELECT * FROM files 
    WHERE scanId = ? AND uploadStatus = 'pending'
    ORDER BY size ASC
    LIMIT ?
  `);
  
  const rows = stmt.all(scanId, limit) as any[];
  
  return rows.map(rowToFileItem);
}

/**
 * Get recent scans
 */
export function getRecentScans(limit: number = 10): any[] {
  if (!db) throw new Error('Database not initialized');
  
  const stmt = db.prepare(`
    SELECT * FROM scans 
    ORDER BY startedAt DESC
    LIMIT ?
  `);
  
  return stmt.all(limit) as any[];
}

/**
 * Delete old completed scans (keep last 30 days)
 */
export function cleanupOldScans(): void {
  if (!db) throw new Error('Database not initialized');
  
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  // Delete files first (foreign key constraint)
  db.prepare(`
    DELETE FROM files 
    WHERE scanId IN (
      SELECT id FROM scans 
      WHERE status IN ('completed', 'failed', 'cancelled')
      AND completedAt < ?
    )
  `).run(thirtyDaysAgo.toISOString());
  
  // Delete scans
  db.prepare(`
    DELETE FROM scans 
    WHERE status IN ('completed', 'failed', 'cancelled')
    AND completedAt < ?
  `).run(thirtyDaysAgo.toISOString());
}
