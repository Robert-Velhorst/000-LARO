/**
 * File upload manager
 * Handles uploading files to LARO backend with retry logic
 */

import { EventEmitter } from 'events';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '../server/routers';
import { FileItem } from '../shared/types';
import { evidenceTypeForMime, MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';
import {
  updateFileStatus,
  updateScanProgress,
  getPendingFiles,
  getScanCaseId,
  getReviewRequiredFileCount,
  markFileReviewRequired,
  markFileUploaded,
} from './database';
import { createDesktopScannerHeaders } from './scannerAuth';
import { FileReviewRequiredError, readApprovedFile } from './fileApproval';

export interface UploaderOptions {
  scanId: string;
  apiUrl: string;
  resolveAuth: () => Promise<{ sessionCookie: string; scannerSecret: string }>;
  remote?: boolean;
  concurrency?: number; // Number of parallel uploads
  maxRetries?: number;
}

export class FileUploader extends EventEmitter {
  private scanId: string;
  private apiUrl: string;
  private concurrency: number;
  private maxRetries: number;
  private remote: boolean;
  
  private isUploading: boolean = false;
  private isPaused: boolean = false;
  private shouldStop: boolean = false;
  
  private uploadedFiles: number = 0;
  private failedFiles: number = 0;
  private uploadedSize: number = 0;
  
  private activeUploads: Set<string> = new Set();
  private client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;
  
  constructor(options: UploaderOptions) {
    super();
    this.scanId = options.scanId;
    this.apiUrl = options.apiUrl;
    this.concurrency = options.concurrency || 3;
    this.maxRetries = options.maxRetries || 3;
    this.remote = options.remote === true;
    this.client = createTRPCProxyClient<AppRouter>({
      transformer: superjson,
      links: [
        httpBatchLink({
          url: `${this.apiUrl.replace(/\/$/, '')}/api/trpc`,
          headers: createDesktopScannerHeaders(options.resolveAuth),
        }),
      ],
    });
  }
  
  /**
   * Start uploading files
   */
  async start(): Promise<void> {
    if (this.isUploading) {
      throw new Error('Uploader is already running');
    }
    
    this.isUploading = true;
    this.shouldStop = false;
    this.isPaused = false;
    
    try {
      console.log(`[Uploader] Starting upload for scan ${this.scanId}`);
      
      // Update scan status
      updateScanProgress({
        scanId: this.scanId,
        status: 'uploading',
        errorMessage: null,
      });
      
      // Upload files in batches
      while (!this.shouldStop) {
        // Wait if paused
        while (this.isPaused && !this.shouldStop) {
          await new Promise(resolve => {
            setTimeout(resolve, 100);
          });
        }
        
        if (this.shouldStop) break;
        
        // Get next batch of pending files
        const pendingFiles = getPendingFiles(this.scanId, this.concurrency);
        
        if (pendingFiles.length === 0) {
          // No more files to upload
          break;
        }
        
        // Upload files in parallel (up to concurrency limit)
        const uploadPromises = pendingFiles.map(file => this.uploadFile(file));
        await Promise.allSettled(uploadPromises);
      }
      
      if (this.shouldStop) {
        this.emit('cancelled');
        updateScanProgress({
          scanId: this.scanId,
          status: 'cancelled',
        });
      } else if (getReviewRequiredFileCount(this.scanId) > 0) {
        const reviewRequired = getReviewRequiredFileCount(this.scanId);
        this.emit('review-required', {
          reviewRequired,
          uploadedFiles: this.uploadedFiles,
          failedFiles: this.failedFiles,
          uploadedSize: this.uploadedSize,
        });
        updateScanProgress({
          scanId: this.scanId,
          status: 'review',
          uploadedFiles: this.uploadedFiles,
          failedFiles: this.failedFiles,
          uploadedSize: this.uploadedSize,
          errorMessage: `${reviewRequired} file${reviewRequired === 1 ? '' : 's'} changed and must be reviewed again.`,
        });
      } else {
        this.emit('completed', {
          uploadedFiles: this.uploadedFiles,
          failedFiles: this.failedFiles,
          uploadedSize: this.uploadedSize,
        });
        
        updateScanProgress({
          scanId: this.scanId,
          status: 'completed',
          uploadedFiles: this.uploadedFiles,
          failedFiles: this.failedFiles,
          uploadedSize: this.uploadedSize,
        });
      }
    } catch (error: any) {
      console.error('[Uploader] Fatal error:', error);
      this.emit('error', error);
      updateScanProgress({
        scanId: this.scanId,
        status: 'failed',
        errorMessage: error.message,
      });
    } finally {
      this.isUploading = false;
    }
  }
  
  /**
   * Stop uploading
   */
  stop(): void {
    this.shouldStop = true;
    this.isPaused = false;
  }
  
  /**
   * Pause uploading
   */
  pause(): void {
    this.isPaused = true;
  }
  
  /**
   * Resume uploading
   */
  resume(): void {
    this.isPaused = false;
  }
  
  /**
   * Upload a single file with retry logic
   */
  private async uploadFile(file: FileItem, retryCount: number = 0): Promise<void> {
    if (this.shouldStop) return;
    
    // Check if already uploading this file
    if (this.activeUploads.has(file.id)) {
      return;
    }
    
    this.activeUploads.add(file.id);
    
    try {
      console.log(`[Uploader] Uploading file: ${file.name} (${file.size} bytes)`);
      
      // Update status to uploading
      updateFileStatus(file.id, 'uploading', 0, null);

      // Read through the approved file handle and reject any path, identity, or
      // byte change that happened after the user's review decision.
      const approved = await readApprovedFile(file.path, file, MAX_EVIDENCE_FILE_BYTES);

      updateFileStatus(file.id, 'uploading', 50);

      const uploaded = await this.client.evidenceFiles.upload.mutate({
        caseId: this.getCaseId(),
        title: file.name,
        type: evidenceTypeForMime(file.mimeType),
        fileName: file.name,
        mimeType: file.mimeType,
        source: this.remote ? 'manual' : 'desktop_scanner',
        approvedSha256: approved.sha256,
        base64: approved.bytes.toString('base64'),
      });
      if (uploaded.sha256 !== approved.sha256) {
        throw new Error('Stored evidence digest does not match the approved file digest');
      }
      
      // Mark as completed
      markFileUploaded(file.id, uploaded.id);
      
      this.uploadedFiles++;
      this.uploadedSize += approved.size;
      
      // Emit progress
      this.emit('progress', {
        fileId: file.id,
        fileName: file.name,
        uploadedFiles: this.uploadedFiles,
        failedFiles: this.failedFiles,
        uploadedSize: this.uploadedSize,
      });
      
      // Update scan progress
      updateScanProgress({
        scanId: this.scanId,
        uploadedFiles: this.uploadedFiles,
        failedFiles: this.failedFiles,
        uploadedSize: this.uploadedSize,
      });
      
      console.log(`[Uploader] Successfully uploaded: ${file.name}`);
    } catch (error: any) {
      console.error(`[Uploader] Error uploading ${file.name}:`, error.message);
      
      // Retry logic
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof FileReviewRequiredError) {
        markFileReviewRequired(file.id, message, error.snapshot);
        this.emit('file-review-required', {
          fileId: file.id,
          fileName: file.name,
          error: message,
        });
        return;
      }
      const authorizationLost = /(?:sign in to LARO|authorization is unavailable)/i.test(message);
      if (authorizationLost) {
        updateFileStatus(file.id, 'pending', 0, message);
        this.stop();
        this.emit('authorization-lost', { error: message });
        return;
      }
      const nonRetryable = /(?:unauthorized|forbidden|not authenticated|not found|between 1 byte|file type|digest does not match)/i.test(message);
      if (retryCount < this.maxRetries && !nonRetryable) {
        console.log(`[Uploader] Retrying upload (${retryCount + 1}/${this.maxRetries}): ${file.name}`);
        
        // Exponential backoff
        const delay = Math.pow(2, retryCount) * 1000;
        await new Promise(resolve => {
          setTimeout(resolve, delay);
        });
        
        // Retry
        this.activeUploads.delete(file.id);
        return this.uploadFile(file, retryCount + 1);
      } else {
        // Max retries exceeded
        updateFileStatus(file.id, 'failed', 0, message);
        this.failedFiles++;

        this.emit('file-failed', {
          fileId: file.id,
          fileName: file.name,
          error: message,
        });
      }
    } finally {
      this.activeUploads.delete(file.id);
    }
  }

  private getCaseId(): string {
    const caseId = getScanCaseId(this.scanId);
    if (!caseId) throw new Error('Scan is not linked to a case');
    return caseId;
  }
}
