/**
 * Local SQLite database for agent state management
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import { FileItem, ScanProgress, ScanStatus, UploadStatus } from '../shared/types';
import { remoteScannerDatabaseName } from './remoteConnection';

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
      totalSize INTEGER DEFAULT 0,
      uploadedSize INTEGER DEFAULT 0,
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
      FOREIGN KEY (scanId) REFERENCES scans(id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_files_scanId ON files(scanId);
    CREATE INDEX IF NOT EXISTS idx_files_uploadStatus ON files(uploadStatus);
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
  
  if (progress.totalSize !== undefined) {
    updates.push('totalSize = ?');
    values.push(progress.totalSize);
  }
  
  if (progress.uploadedSize !== undefined) {
    updates.push('uploadedSize = ?');
    values.push(progress.uploadedSize);
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
    totalSize: row.totalSize,
    uploadedSize: row.uploadedSize,
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
    INSERT INTO files (id, scanId, path, name, size, mimeType, modifiedAt, uploadStatus, uploadProgress)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    file.uploadProgress
  );
}

/**
 * Update file upload status
 */
export function updateFileStatus(
  fileId: string,
  status: UploadStatus,
  progress?: number,
  errorMessage?: string
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

/**
 * Get files for a scan
 */
export function getScanFiles(scanId: string): FileItem[] {
  if (!db) throw new Error('Database not initialized');
  
  const stmt = db.prepare('SELECT * FROM files WHERE scanId = ? ORDER BY name');
  const rows = stmt.all(scanId) as any[];
  
  return rows.map(row => ({
    id: row.id,
    path: row.path,
    name: row.name,
    size: row.size,
    mimeType: row.mimeType,
    modifiedAt: new Date(row.modifiedAt),
    uploadStatus: row.uploadStatus as UploadStatus,
    uploadProgress: row.uploadProgress,
    errorMessage: row.errorMessage,
  }));
}

export function getScanCaseId(scanId: string): string | null {
  if (!db) throw new Error('Database not initialized');
  const row = db.prepare('SELECT caseId FROM scans WHERE id = ?').get(scanId) as { caseId: string } | undefined;
  return row?.caseId ?? null;
}

/** Persist the user's review decision before any upload starts. */
export function setScanFileSelection(scanId: string, selectedFileIds: string[]): number {
  if (!db) throw new Error('Database not initialized');

  const selected = new Set(selectedFileIds);
  const rows = db
    .prepare("SELECT id FROM files WHERE scanId = ? AND uploadStatus IN ('pending', 'excluded')")
    .all(scanId) as Array<{ id: string }>;

  const update = db.prepare('UPDATE files SET uploadStatus = ?, uploadProgress = 0, errorMessage = NULL WHERE id = ?');
  const transaction = db.transaction(() => {
    for (const row of rows) update.run(selected.has(row.id) ? 'pending' : 'excluded', row.id);
  });
  transaction();
  return rows.filter((row) => selected.has(row.id)).length;
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
  
  return rows.map(row => ({
    id: row.id,
    path: row.path,
    name: row.name,
    size: row.size,
    mimeType: row.mimeType,
    modifiedAt: new Date(row.modifiedAt),
    uploadStatus: row.uploadStatus as UploadStatus,
    uploadProgress: row.uploadProgress,
    errorMessage: row.errorMessage,
  }));
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
