/**
 * File upload manager
 * Handles uploading files to LARO backend with retry logic
 */

import { EventEmitter } from 'events';
import { FileItem } from '../shared/types';
import { evidenceTypeForMime, MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';
import {
  SCANNER_UPLOAD_HEADERS,
  SCANNER_UPLOAD_PATH,
  type ScannerUploadResult,
} from '../shared/scannerUpload';
import {
  getScanUploadSummary,
  updateFileStatus,
  updateScanProgress,
  getPendingFiles,
  getScanCaseId,
  getReviewRequiredFileCount,
  markFileReviewRequired,
  markFileUploaded,
  prepareScanUploadResume,
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
  /** Test seam; production uses the runtime's native fetch. */
  fetchImpl?: typeof fetch;
  /** Test seam for retry timing. */
  wait?: (milliseconds: number) => Promise<void>;
}

class ScannerUploadRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string,
    readonly retryable: boolean,
    readonly authorizationLost: boolean = false,
  ) {
    super(message);
    this.name = 'ScannerUploadRequestError';
  }
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
  private cancelRequested: boolean = false;
  private authorizationPaused: boolean = false;
  
  private uploadedFiles: number = 0;
  private failedFiles: number = 0;
  private uploadedSize: number = 0;
  
  private activeUploads: Set<string> = new Set();
  private activeRequests: Map<string, AbortController> = new Map();
  private resolveHeaders: () => Promise<Record<string, string>>;
  private fetchImpl: typeof fetch;
  private wait: (milliseconds: number) => Promise<void>;
  
  constructor(options: UploaderOptions) {
    super();
    this.scanId = options.scanId;
    this.apiUrl = options.apiUrl;
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 1, 2));
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.remote = options.remote === true;
    this.resolveHeaders = createDesktopScannerHeaders(options.resolveAuth);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
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
    this.cancelRequested = false;
    this.authorizationPaused = false;
    
    try {
      console.log(`[Uploader] Starting upload for scan ${this.scanId}`);
      prepareScanUploadResume(this.scanId);
      this.refreshCounters();
      
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
        const outcomes = await Promise.allSettled(uploadPromises);
        const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
        if (rejected) throw rejected.reason;
      }
      
      if (this.shouldStop) {
        if (this.authorizationPaused) {
          const summary = this.refreshCounters();
          updateScanProgress({
            scanId: this.scanId,
            status: 'upload-paused',
            uploadedFiles: summary.completedFiles,
            failedFiles: summary.retryableFiles + summary.terminalFiles,
            uploadedSize: summary.completedBytes,
            errorMessage: 'Sign in again, then resume the approved uploads.',
          });
          this.emit('authorization-required', {
            retryableFiles: summary.retryableFiles,
            uploadedFiles: summary.completedFiles,
            failedFiles: summary.retryableFiles + summary.terminalFiles,
            uploadedSize: summary.completedBytes,
            error: 'Sign in again, then resume the approved uploads.',
          });
        } else {
          const summary = this.refreshCounters();
          updateScanProgress({
            scanId: this.scanId,
            status: 'cancelled',
            uploadedFiles: summary.completedFiles,
            failedFiles: summary.retryableFiles + summary.terminalFiles,
            uploadedSize: summary.completedBytes,
            errorMessage: 'Upload cancelled. Approved files can be resumed.',
          });
          this.emit('cancelled');
        }
      } else if (getReviewRequiredFileCount(this.scanId) > 0) {
        const reviewRequired = getReviewRequiredFileCount(this.scanId);
        updateScanProgress({
          scanId: this.scanId,
          status: 'review',
          uploadedFiles: this.uploadedFiles,
          failedFiles: this.failedFiles,
          uploadedSize: this.uploadedSize,
          errorMessage: `${reviewRequired} file${reviewRequired === 1 ? '' : 's'} changed and must be reviewed again.`,
        });
        this.emit('review-required', {
          reviewRequired,
          uploadedFiles: this.uploadedFiles,
          failedFiles: this.failedFiles,
          uploadedSize: this.uploadedSize,
        });
      } else {
        const summary = this.refreshCounters();
        if (summary.retryableFiles > 0) {
          updateScanProgress({
            scanId: this.scanId,
            status: 'upload-paused',
            uploadedFiles: summary.completedFiles,
            failedFiles: summary.retryableFiles + summary.terminalFiles,
            uploadedSize: summary.completedBytes,
            errorMessage: `${summary.retryableFiles} upload${summary.retryableFiles === 1 ? '' : 's'} can be resumed.`,
          });
          this.emit('retryable-pending', {
            retryableFiles: summary.retryableFiles,
            uploadedFiles: summary.completedFiles,
            failedFiles: summary.retryableFiles + summary.terminalFiles,
            uploadedSize: summary.completedBytes,
          });
          return;
        }
        updateScanProgress({
          scanId: this.scanId,
          status: summary.terminalFiles > 0 ? 'failed' : 'completed',
          uploadedFiles: summary.completedFiles,
          failedFiles: summary.terminalFiles,
          uploadedSize: summary.completedBytes,
          errorMessage: summary.terminalFiles > 0
            ? `${summary.terminalFiles} file${summary.terminalFiles === 1 ? '' : 's'} were rejected and require correction.`
            : null,
        });
        this.emit('completed', {
          uploadedFiles: summary.completedFiles,
          failedFiles: summary.terminalFiles,
          uploadedSize: summary.completedBytes,
          partial: summary.terminalFiles > 0,
        });
      }
    } catch (error: any) {
      console.error('[Uploader] Fatal error:', error);
      try {
        updateScanProgress({
          scanId: this.scanId,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      } catch (persistError) {
        console.error('[Uploader] Failed to persist fatal upload status:', persistError);
      }
      this.emit('error', error);
    } finally {
      this.isUploading = false;
    }
  }
  
  /**
   * Stop uploading
   */
  stop(): void {
    this.shouldStop = true;
    this.cancelRequested = true;
    this.isPaused = false;
    for (const controller of this.activeRequests.values()) controller.abort();
  }
  
  /**
   * Pause uploading
   */
  pause(): void {
    this.isPaused = true;
    updateScanProgress({ scanId: this.scanId, status: 'upload-paused' });
  }
  
  /**
   * Resume uploading
   */
  resume(): void {
    this.isPaused = false;
    updateScanProgress({ scanId: this.scanId, status: 'uploading', errorMessage: null });
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

      if (this.shouldStop) {
        updateFileStatus(file.id, 'cancelled', 0, 'Upload cancelled. The approved file can be resumed.');
        return;
      }

      updateFileStatus(file.id, 'uploading', 50);

      const uploaded = await this.uploadApprovedBytes(file, approved.bytes, approved.sha256);
      if (uploaded.sha256 !== approved.sha256) {
        throw new ScannerUploadRequestError(
          'Stored evidence digest does not match the approved file digest',
          409,
          'STORED_DIGEST_MISMATCH',
          false,
        );
      }

      // Mark as completed only after the server returns its durable evidence ID.
      markFileUploaded(file.id, uploaded.id);
      const summary = this.refreshCounters();

      this.emit('progress', {
        fileId: file.id,
        fileName: file.name,
        uploadStatus: 'completed',
        uploadedFiles: summary.completedFiles,
        failedFiles: summary.retryableFiles + summary.terminalFiles,
        uploadedSize: summary.completedBytes,
        resumed: uploaded.resumed,
      });

      updateScanProgress({
        scanId: this.scanId,
        uploadedFiles: summary.completedFiles,
        failedFiles: summary.retryableFiles + summary.terminalFiles,
        uploadedSize: summary.completedBytes,
      });

      console.log(`[Uploader] Successfully uploaded: ${file.name}`);
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Uploader] Error uploading ${file.name}:`, message);

      if (error instanceof FileReviewRequiredError) {
        markFileReviewRequired(file.id, message, error.snapshot);
        this.emit('file-review-required', {
          fileId: file.id,
          fileName: file.name,
          uploadStatus: 'review_required',
          error: message,
        });
        return;
      }

      if (this.cancelRequested || (error instanceof Error && error.name === 'AbortError')) {
        updateFileStatus(file.id, 'cancelled', 0, 'Upload cancelled. The approved file can be resumed.');
        this.emit('file-cancelled', {
          fileId: file.id,
          fileName: file.name,
          uploadStatus: 'cancelled',
          error: 'Upload cancelled. The approved file can be resumed.',
        });
        return;
      }

      const requestError = this.classifyRequestError(error);
      if (retryCount < this.maxRetries && requestError.retryable) {
        console.log(`[Uploader] Retrying upload (${retryCount + 1}/${this.maxRetries}): ${file.name}`);
        await this.wait(Math.pow(2, retryCount) * 1000);
        if (this.shouldStop) {
          updateFileStatus(file.id, 'cancelled', 0, 'Upload cancelled. The approved file can be resumed.');
          return;
        }
        this.activeUploads.delete(file.id);
        return this.uploadFile(file, retryCount + 1);
      }

      if (requestError.retryable) {
        updateFileStatus(file.id, 'retryable', 0, message);
        if (requestError.authorizationLost) {
          this.authorizationPaused = true;
          this.shouldStop = true;
        }
        this.emit('file-retryable', {
          fileId: file.id,
          fileName: file.name,
          uploadStatus: 'retryable',
          authorizationRequired: requestError.authorizationLost,
          error: message,
        });
      } else {
        updateFileStatus(file.id, 'terminal', 0, message);
        this.emit('file-failed', {
          fileId: file.id,
          fileName: file.name,
          uploadStatus: 'terminal',
          error: message,
        });
      }
      this.refreshCounters();
    } finally {
      this.activeRequests.delete(file.id);
      this.activeUploads.delete(file.id);
    }
  }

  private async uploadApprovedBytes(
    file: FileItem,
    bytes: Buffer,
    approvedSha256: string,
  ): Promise<ScannerUploadResult> {
    const controller = new AbortController();
    this.activeRequests.set(file.id, controller);
    const response = await this.fetchImpl(
      `${this.apiUrl.replace(/\/$/, '')}${SCANNER_UPLOAD_PATH}`,
      {
        method: 'POST',
        headers: {
          ...(await this.resolveHeaders()),
          'Content-Type': 'application/octet-stream',
          [SCANNER_UPLOAD_HEADERS.uploadId]: file.id,
          [SCANNER_UPLOAD_HEADERS.caseId]: this.getCaseId(),
          [SCANNER_UPLOAD_HEADERS.fileName]: encodeURIComponent(file.name),
          [SCANNER_UPLOAD_HEADERS.fileMime]: file.mimeType,
          [SCANNER_UPLOAD_HEADERS.evidenceType]: evidenceTypeForMime(file.mimeType),
          [SCANNER_UPLOAD_HEADERS.approvedSha256]: approvedSha256,
          [SCANNER_UPLOAD_HEADERS.source]: this.remote ? 'manual' : 'desktop_scanner',
        },
        // Node/Electron fetch accepts Buffer at runtime; the DOM overload used
        // by the shared TypeScript config does not model Node's Buffer subtype.
        body: bytes as unknown as BodyInit,
        signal: controller.signal,
      },
    );

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const body = payload && typeof payload === 'object' ? payload as { error?: unknown; code?: unknown } : {};
      const message = typeof body.error === 'string'
        ? body.error.slice(0, 500)
        : `Scanner upload failed with HTTP ${response.status}`;
      const code = typeof body.code === 'string' ? body.code.slice(0, 100) : `HTTP_${response.status}`;
      const authorizationLost = response.status === 401;
      const retryable = authorizationLost || response.status === 408 || response.status === 425 ||
        response.status === 429 || response.status >= 500;
      throw new ScannerUploadRequestError(message, response.status, code, retryable, authorizationLost);
    }
    if (!payload || typeof payload !== 'object') {
      throw new ScannerUploadRequestError('Scanner upload returned an invalid response', response.status, 'INVALID_RESPONSE', true);
    }
    const result = payload as Partial<ScannerUploadResult>;
    if (
      typeof result.id !== 'string' || !result.id ||
      typeof result.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256) ||
      typeof result.resumed !== 'boolean'
    ) {
      throw new ScannerUploadRequestError('Scanner upload returned an invalid receipt', response.status, 'INVALID_RECEIPT', true);
    }
    return { id: result.id, sha256: result.sha256, resumed: result.resumed };
  }

  private classifyRequestError(error: unknown): ScannerUploadRequestError {
    if (error instanceof ScannerUploadRequestError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const authorizationLost = /(?:sign in to LARO|authentication is required|authorization is unavailable)/i.test(message);
    return new ScannerUploadRequestError(
      message,
      null,
      authorizationLost ? 'AUTHENTICATION_REQUIRED' : 'NETWORK_FAILURE',
      true,
      authorizationLost,
    );
  }

  private refreshCounters() {
    const summary = getScanUploadSummary(this.scanId);
    this.uploadedFiles = summary.completedFiles;
    this.failedFiles = summary.retryableFiles + summary.terminalFiles;
    this.uploadedSize = summary.completedBytes;
    return summary;
  }

  private getCaseId(): string {
    const caseId = getScanCaseId(this.scanId);
    if (!caseId) throw new Error('Scan is not linked to a case');
    return caseId;
  }
}
