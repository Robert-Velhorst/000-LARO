/**
 * File system scanner
 * Recursively scans directories and discovers evidence files
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import { nanoid } from 'nanoid';
import mime from 'mime-types';
import { FileItem, Platform, ScanConfig } from '../shared/types';
import { shouldExcludePath, shouldExcludeFile } from '../shared/exclusions';
import { isSupportedEvidenceMimeType, MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';
import { addFile, updateScanProgress } from './database';
import { inspectRegularFile } from './fileApproval';
import { EVIDENCE_INGESTION_LIMITS } from '../shared/evidenceIngestion';

export interface ScannerOptions {
  scanId: string;
  config: ScanConfig;
  platform: Platform;
}

export class FileScanner extends EventEmitter {
  private scanId: string;
  private config: ScanConfig;
  private platform: Platform;
  private isScanning: boolean = false;
  private isPaused: boolean = false;
  private shouldStop: boolean = false;
  
  private totalFiles: number = 0;
  private scannedFiles: number = 0;
  private totalSize: number = 0;
  private skippedFiles: number = 0;
  private skippedSize: number = 0;
  private limitReason: string | null = null;
  private budgetExhausted: boolean = false;
  
  constructor(options: ScannerOptions) {
    super();
    this.scanId = options.scanId;
    this.config = options.config;
    this.platform = options.platform;
  }
  
  /**
   * Start scanning
   */
  async start(): Promise<void> {
    if (this.isScanning) {
      throw new Error('Scanner is already running');
    }
    
    this.isScanning = true;
    this.shouldStop = false;
    this.isPaused = false;
    
    try {
      // Get root paths to scan based on platform
      const rootPaths = this.getRootPaths();
      
      console.log(`[Scanner] Starting scan for case ${this.config.caseId}`);
      console.log(`[Scanner] Root paths:`, rootPaths);
      console.log(`[Scanner] Excluded folders:`, this.config.excludedFolders);
      
      // Scan each root path
      for (const rootPath of rootPaths) {
        if (this.shouldStop || this.budgetExhausted) break;
        
        try {
          await this.scanDirectory(rootPath);
        } catch (error: any) {
          console.error(`[Scanner] Error scanning ${rootPath}:`, error.message);
          // Continue with next root path
        }
      }
      
      if (this.shouldStop) {
        this.emit('cancelled');
        updateScanProgress({
          scanId: this.scanId,
          status: 'cancelled',
        });
      } else {
        this.emit('completed', {
          totalFiles: this.totalFiles,
          totalSize: this.totalSize,
          skippedFiles: this.skippedFiles,
          skippedSize: this.skippedSize,
          limitReason: this.limitReason,
          partial: this.skippedFiles > 0,
        });
        
        // Update status based on auto-upload setting
        updateScanProgress({
          scanId: this.scanId,
          status: this.config.autoUpload ? 'uploading' : 'review',
          totalFiles: this.totalFiles,
          scannedFiles: this.scannedFiles,
          skippedFiles: this.skippedFiles,
          totalSize: this.totalSize,
          skippedSize: this.skippedSize,
          limitReason: this.limitReason,
          errorMessage: this.limitReason,
        });
      }
    } catch (error: any) {
      console.error('[Scanner] Fatal error:', error);
      this.emit('error', error);
      updateScanProgress({
        scanId: this.scanId,
        status: 'failed',
        errorMessage: error.message,
      });
    } finally {
      this.isScanning = false;
    }
  }
  
  /**
   * Stop scanning
   */
  stop(): void {
    this.shouldStop = true;
    this.isPaused = false;
  }
  
  /**
   * Pause scanning
   */
  pause(): void {
    this.isPaused = true;
  }
  
  /**
   * Resume scanning
   */
  resume(): void {
    this.isPaused = false;
  }
  
  /**
   * Get root paths to scan based on platform
   */
  private getRootPaths(): string[] {
    if (!this.config.folders?.length) {
      throw new Error('Select at least one folder before starting a scan');
    }
    return this.config.folders;
  }
  
  /**
   * Recursively scan a directory
   */
  private async scanDirectory(dirPath: string): Promise<void> {
    // Check if we should stop or pause
    while (this.isPaused && !this.shouldStop) {
      await new Promise(resolve => {
        setTimeout(resolve, 100);
      });
    }
    
    if (this.shouldStop) return;
    if (this.budgetExhausted) return;
    
    // Check if path should be excluded
    if (shouldExcludePath(dirPath, this.platform, this.config.excludedFolders)) {
      console.log(`[Scanner] Skipping excluded path: ${dirPath}`);
      return;
    }
    
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (this.shouldStop || this.budgetExhausted) break;
        
        // Wait if paused
        while (this.isPaused && !this.shouldStop) {
          await new Promise(resolve => {
            setTimeout(resolve, 100);
          });
        }
        
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          // Recursively scan subdirectory
          await this.scanDirectory(fullPath);
        } else if (entry.isFile()) {
          // Process file
          await this.processFile(fullPath, entry.name);
        }
      }
    } catch (error: any) {
      // Skip directories we don't have permission to read
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        console.log(`[Scanner] Permission denied: ${dirPath}`);
      } else {
        console.error(`[Scanner] Error reading directory ${dirPath}:`, error.message);
      }
    }
  }
  
  /**
   * Process a single file
   */
  private async processFile(filePath: string, fileName: string): Promise<void> {
    try {
      // Check if file should be excluded
      if (shouldExcludeFile(fileName)) {
        return;
      }
      
      // Determine MIME type
      const mimeType = mime.lookup(filePath) || 'application/octet-stream';
      if (!isSupportedEvidenceMimeType(mimeType)) return;

      const metadata = await fs.stat(filePath);
      if (!metadata.size || metadata.size > EVIDENCE_INGESTION_LIMITS.maxFileBytes) {
        this.skippedFiles += 1;
        this.skippedSize += Math.max(0, metadata.size);
        this.limitReason ??= 'Partial scan: one or more empty or oversized files were skipped.';
        return;
      }
      if (this.totalFiles >= EVIDENCE_INGESTION_LIMITS.maxJobItems) {
        this.skippedFiles += 1;
        this.skippedSize += metadata.size;
        this.limitReason = `Partial scan: the ${EVIDENCE_INGESTION_LIMITS.maxJobItems}-item ingestion limit was reached.`;
        this.budgetExhausted = true;
        return;
      }
      if (this.totalSize + metadata.size > EVIDENCE_INGESTION_LIMITS.maxJobBytes) {
        this.skippedFiles += 1;
        this.skippedSize += metadata.size;
        this.limitReason = `Partial scan: the ${EVIDENCE_INGESTION_LIMITS.maxJobBytes}-byte ingestion limit was reached.`;
        this.budgetExhausted = true;
        return;
      }

      // Capture the exact bytes and filesystem identity shown for review.
      const snapshot = await inspectRegularFile(filePath, MAX_EVIDENCE_FILE_BYTES);
      if (this.totalSize + snapshot.size > EVIDENCE_INGESTION_LIMITS.maxJobBytes) {
        this.skippedFiles += 1;
        this.skippedSize += snapshot.size;
        this.limitReason = `Partial scan: the ${EVIDENCE_INGESTION_LIMITS.maxJobBytes}-byte ingestion limit was reached.`;
        this.budgetExhausted = true;
        return;
      }
      
      // Create file item
      const fileItem: FileItem = {
        id: nanoid(),
        path: filePath,
        name: fileName,
        size: snapshot.size,
        mimeType,
        modifiedAt: snapshot.modifiedAt,
        uploadStatus: 'pending',
        uploadProgress: 0,
        contentHash: snapshot.sha256,
        sourceIdentity: snapshot.identity,
        sourceRealPath: snapshot.realPath,
      };
      
      // Add to database
      addFile(fileItem, this.scanId);
      
      // Update counters
      this.totalFiles++;
      this.scannedFiles++;
      this.totalSize += snapshot.size;
      
      // Emit progress event every 10 files
      if (this.totalFiles % 10 === 0) {
        this.emit('progress', {
          totalFiles: this.totalFiles,
          scannedFiles: this.scannedFiles,
          totalSize: this.totalSize,
          currentFile: filePath,
        });
        
        // Update database
        updateScanProgress({
          scanId: this.scanId,
          totalFiles: this.totalFiles,
          scannedFiles: this.scannedFiles,
          totalSize: this.totalSize,
          currentFile: filePath,
        });
      }
    } catch (error: any) {
      this.skippedFiles += 1;
      this.limitReason ??= 'Partial scan: one or more files could not be read safely.';
      // Skip files we can't access
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        console.log(`[Scanner] Permission denied: ${filePath}`);
      } else {
        console.error(`[Scanner error] Error processing file ${filePath}:`, error.message);
      }
    }
  }
}
