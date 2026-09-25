import { google } from 'googleapis';
import { getDb } from './db';
import { eq } from 'drizzle-orm';
import { storagePutStream } from './storage';
import { v4 as uuidv4 } from 'uuid';
import { getProviderAccessToken } from './providerConnections';
import { MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';
import { withByteReadAdmission } from './boundedBytes';
import { PROVIDER_LIMITS, ProviderBatchBudget } from './providerLimits';
import {
  EvidenceIngestionBudget,
  EvidenceIngestionLimitError,
} from './evidenceIngestionBudget';

/**
 * Google Drive Service
 * Handles file metadata retrieval and downloads from Google Drive
 */

/**
 * Get an authenticated Drive client for a user
 */
async function getDriveClient(userId: string, accountId?: string) {
  const accessToken = await getProviderAccessToken({
    userId,
    accountId,
    provider: 'gmail',
  });

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  
  return google.drive({ version: 'v3', auth });
}

export interface GoogleDriveFileListing {
  id: string;
  name: string;
  mimeType?: string | null;
  size?: string | null;
  webViewLink?: string | null;
  modifiedTime?: string | null;
  version?: string | null;
  md5Checksum?: string | null;
}

export function googleDriveProviderRevision(file: {
  version?: string | null;
  md5Checksum?: string | null;
  modifiedTime?: string | Date | null;
}): string | null {
  if (file.version) return `drive-version:${file.version}`;
  if (file.md5Checksum) return `drive-md5:${file.md5Checksum}`;
  if (!file.modifiedTime) return null;
  const modified = file.modifiedTime instanceof Date
    ? file.modifiedTime
    : new Date(file.modifiedTime);
  return Number.isNaN(modified.getTime()) ? null : `drive-modified:${modified.toISOString()}`;
}

/**
 * Download a file from Google Drive and upload it to local/S3 storage
 */
export function downloadAndUploadGoogleDriveFile(
  fileId: string,
  caseId: string,
  userId?: string,
  accountId?: string,
  options: { budget?: EvidenceIngestionBudget; signal?: AbortSignal } = {},
) {
  const budget = options.budget ?? new EvidenceIngestionBudget(options.signal);
  return downloadAndUploadGoogleDriveFileAdmitted(fileId, caseId, userId, accountId, budget, options.signal);
}

async function downloadAndUploadGoogleDriveFileAdmitted(
  fileId: string,
  caseId: string,
  userId: string | undefined,
  accountId: string | undefined,
  budget: EvidenceIngestionBudget,
  signal?: AbortSignal,
) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  // If userId not provided, look up the case to find the owner
  let targetUserId = userId;
  if (!targetUserId) {
    const { cases } = await import('./schema');
    const caseData = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!caseData[0]) throw new Error(`Case ${caseId} not found`);
    targetUserId = caseData[0].userId;
  }

  const drive = await getDriveClient(targetUserId, accountId);

  // 1. Get metadata to know the filename
  const fileMetadata = await drive.files.get({
    fileId,
    fields: 'name, mimeType, size, modifiedTime, version, md5Checksum',
  }, signal ? { signal } : undefined);

  let fileName = fileMetadata.data.name || 'document';
  const sourceMimeType = fileMetadata.data.mimeType || 'application/octet-stream';
  let mimeType = sourceMimeType;
  const fileSize = fileMetadata.data.size;
  const modifiedTime = fileMetadata.data.modifiedTime;
  const providerVersion = fileMetadata.data.version || null;
  const md5Checksum = fileMetadata.data.md5Checksum || null;
  const declaredSize = Number(fileSize);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_EVIDENCE_FILE_BYTES) {
    budget.recordSkip('google_drive', 'file_too_large');
    throw new Error('Google Drive file exceeds the 7 MB evidence limit');
  }

  // Google-native documents have no media body. Export them to PDF so the
  // same source-grounded text extraction pipeline can analyze them.
  const googleNative = sourceMimeType.startsWith('application/vnd.google-apps.');
  if (googleNative) {
    mimeType = 'application/pdf';
    if (!fileName.toLowerCase().endsWith('.pdf')) fileName += '.pdf';
  }
  const preflightBytes = !googleNative && Number.isSafeInteger(declaredSize) && declaredSize > 0
    ? declaredSize
    : null;
  const reservation = await budget.reserve('google_drive', preflightBytes);
  if (!reservation) {
    throw new EvidenceIngestionLimitError(
      'google_drive',
      Number.isFinite(declaredSize) && declaredSize > MAX_EVIDENCE_FILE_BYTES ? 'file_too_large' : 'job_byte_limit',
      Number.isFinite(declaredSize) && declaredSize > MAX_EVIDENCE_FILE_BYTES
        ? 'Google Drive file exceeds the 7 MB evidence limit'
        : 'Google Drive ingestion reached its item, byte, or storage-headroom limit',
    );
  }

  const storagePath = `evidence/${caseId}/gdrive/${uuidv4()}-${fileName}`;
  let completed = false;
  let stored: Awaited<ReturnType<typeof storagePutStream>>;
  try {
    stored = await reservation.run(() => withByteReadAdmission(async () => {
      budget.throwIfCancelled('google_drive');
      const response = googleNative
        ? await drive.files.export(
            { fileId, mimeType: 'application/pdf' },
            { responseType: 'stream', signal }
          )
        : await drive.files.get(
            { fileId, alt: 'media' },
            { responseType: 'stream', signal }
          );
      return storagePutStream(storagePath, response.data, mimeType, {
        maxBytes: reservation.declaredBytes,
        ...(preflightBytes !== null ? { expectedBytes: preflightBytes } : {}),
        signal,
      });
    }));
    reservation.complete(stored.bytes);
    completed = true;
  } catch (error) {
    if (!completed) reservation.skip(error instanceof EvidenceIngestionLimitError ? error.code : 'store_failed');
    throw error;
  }

  return { 
    key: stored.key,
    url: stored.url,
    sha256: stored.sha256,
    fileName, 
    mimeType, 
    sourceMimeType,
    size: stored.bytes,
    modifiedTime: modifiedTime ? new Date(modifiedTime) : new Date(),
    providerVersion,
    md5Checksum,
    providerRevision: googleDriveProviderRevision({
      version: providerVersion,
      md5Checksum,
      modifiedTime,
    }),
  };
}

/**
 * List folders in Google Drive (root or specific parent)
 * Used for folder browsing UI
 */
export async function listGoogleDriveFolders(userId: string, parentId?: string, accountId?: string) {
  const drive = await getDriveClient(userId, accountId);
  
  let query = "mimeType='application/vnd.google-apps.folder' and trashed=false";
  
  if (parentId) {
    query += ` and '${escapeDriveQueryLiteral(parentId)}' in parents`;
  } else {
    query += " and 'root' in parents";
  }

  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name, modifiedTime, parents)',
    orderBy: 'name',
    pageSize: 100,
  });

  return response.data.files || [];
}

/**
 * Get all files in a folder (with optional recursive scanning)
 */
export async function getAllFilesInFolder(
  userId: string, 
  folderId: string, 
  recursive: boolean = false,
  accountId?: string,
): Promise<GoogleDriveFileListing[]> {
  const drive = await getDriveClient(userId, accountId);
  const allFiles: GoogleDriveFileListing[] = [];
  const budget = new ProviderBatchBudget({
    pages: PROVIDER_LIMITS.googleDrive.maxListPages,
    folders: PROVIDER_LIMITS.googleDrive.maxFoldersScanned,
    files: PROVIDER_LIMITS.googleDrive.maxListedFiles,
  });
  const pendingFolders = [folderId];
  const discoveredFolders = new Set([folderId]);
  budget.consume('folders', 1, 'Google Drive folder limit exceeded');

  while (pendingFolders.length > 0) {
    const currentFolderId = pendingFolders.shift()!;
    let pageToken: string | undefined;
    do {
      budget.consume('pages', 1, 'Google Drive page limit exceeded');
      const response = await drive.files.list({
        q: `'${escapeDriveQueryLiteral(currentFolderId)}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, webViewLink, modifiedTime, version, md5Checksum)',
        pageToken,
        pageSize: 100,
      });

      const items = response.data.files || [];
      for (const item of items) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          if (recursive && item.id && !discoveredFolders.has(item.id)) {
            budget.consume('folders', 1, 'Google Drive folder limit exceeded');
            discoveredFolders.add(item.id);
            pendingFolders.push(item.id);
          }
        } else {
          budget.consume('files', 1, 'Google Drive file limit exceeded');
          allFiles.push(item as any);
        }
      }
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
  }

  return allFiles;
}

export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Find exact filename matches across the selected account without walking folders. */
export async function findGoogleDriveFilesByExactName(
  userId: string,
  exactFileName: string,
  accountId?: string,
): Promise<GoogleDriveFileListing[]> {
  const name = exactFileName.trim();
  if (!name) return [];
  const drive = await getDriveClient(userId, accountId);
  const files: GoogleDriveFileListing[] = [];
  const budget = new ProviderBatchBudget({
    pages: PROVIDER_LIMITS.googleDrive.maxListPages,
    files: PROVIDER_LIMITS.googleDrive.maxExactNameMatches,
  });
  let pageToken: string | undefined;
  do {
    budget.consume('pages', 1, 'Google Drive exact-name page limit exceeded');
    const response = await drive.files.list({
      q: `name = '${escapeDriveQueryLiteral(name)}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name, mimeType, size, webViewLink, modifiedTime, version, md5Checksum)',
      pageToken,
      pageSize: 100,
    });
    const pageFiles = (response.data.files || []) as typeof files;
    budget.consume('files', pageFiles.length, 'Google Drive exact-name match limit exceeded');
    files.push(...pageFiles);
    pageToken = response.data.nextPageToken || undefined;
  } while (pageToken);
  return files.filter((file) => file.name?.trim().toLowerCase() === name.toLowerCase());
}
