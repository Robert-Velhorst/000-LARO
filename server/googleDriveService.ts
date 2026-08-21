import { google } from 'googleapis';
import { getDb } from './db';
import { emailAccounts, googleDriveFiles } from './schema';
import { eq, and } from 'drizzle-orm';
import { storagePut } from './storage';
import { v4 as uuidv4 } from 'uuid';
import { decryptToken, encryptToken, refreshGmailToken } from './emailOAuth';
import { MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';
import { collectBoundedBytes, withByteReadAdmission } from './boundedBytes';
import { PROVIDER_LIMITS, ProviderBatchBudget } from './providerLimits';

/**
 * Google Drive Service
 * Handles file metadata retrieval and downloads from Google Drive
 */

/**
 * Get an authenticated Drive client for a user
 */
async function getDriveClient(userId: string, accountId?: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const accounts = await db
    .select()
    .from(emailAccounts)
    .where(and(
      eq(emailAccounts.userId, userId),
      eq(emailAccounts.provider, 'gmail'),
      ...(accountId ? [eq(emailAccounts.id, accountId)] : []),
    ))
    .limit(2);

  if (accounts.length === 0) {
    throw new Error(accountId ? 'Selected Google account is not connected.' : 'No Google account is connected.');
  }
  if (!accountId && accounts.length > 1) {
    throw new Error('Multiple Google accounts are connected. Select the Drive account to use.');
  }

  const emailAccount = accounts[0];
  if (emailAccount.status !== 'connected' || !emailAccount.accessToken) {
    throw new Error('Selected Google account is not connected.');
  }
  let accessToken = decryptToken(emailAccount.accessToken!);

  // Refresh token if expired
  const now = new Date();
  if (emailAccount.tokenExpiry && new Date(emailAccount.tokenExpiry) <= now) {
    if (!emailAccount.refreshToken) {
      throw new Error('Selected Google account requires reconnection.');
    }
    const refreshToken = decryptToken(emailAccount.refreshToken!);
    const newTokens = await refreshGmailToken(refreshToken);
    
    accessToken = newTokens.accessToken;
    
    await db.update(emailAccounts)
      .set({
        accessToken: encryptToken(accessToken),
        tokenExpiry: new Date(newTokens.expiryDate),
      })
      .where(eq(emailAccounts.id, emailAccount.id));
  }

  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  
  return google.drive({ version: 'v3', auth });
}

/**
 * Get file metadata from a Google Drive folder
 * Note: This implementation assumes it can find the userId from the context
 * mapping if not provided, but for background jobs, we might need to adjust.
 * For now, we'll try to find the user associated with the folder if possible,
 * or use a fallback mechanism.
 */
export async function getGoogleDriveFileMetadata(folderId: string, userId: string, accountId?: string) {
  if (!userId) throw new Error('Google Drive metadata lookup requires an explicit user');
  const drive = await getDriveClient(userId, accountId);
  
  const response = await drive.files.list({
    q: `'${escapeDriveQueryLiteral(folderId)}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, webViewLink, modifiedTime)',
    pageSize: 100,
  });

  return response.data.files || [];
}

/**
 * Download a file from Google Drive and upload it to local/S3 storage
 */
export function downloadAndUploadGoogleDriveFile(fileId: string, caseId: string, userId?: string, accountId?: string) {
  return withByteReadAdmission(() => downloadAndUploadGoogleDriveFileAdmitted(fileId, caseId, userId, accountId));
}

async function downloadAndUploadGoogleDriveFileAdmitted(fileId: string, caseId: string, userId?: string, accountId?: string) {
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
    fields: 'name, mimeType, size, modifiedTime',
  });

  let fileName = fileMetadata.data.name || 'document';
  const sourceMimeType = fileMetadata.data.mimeType || 'application/octet-stream';
  let mimeType = sourceMimeType;
  const fileSize = fileMetadata.data.size;
  const modifiedTime = fileMetadata.data.modifiedTime;
  const declaredSize = Number(fileSize);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error('Google Drive file exceeds the 7 MB evidence limit');
  }

  // Google-native documents have no media body. Export them to PDF so the
  // same source-grounded text extraction pipeline can analyze them.
  const googleNative = sourceMimeType.startsWith('application/vnd.google-apps.');
  const response = googleNative
    ? await drive.files.export(
        { fileId, mimeType: 'application/pdf' },
        { responseType: 'stream' }
      )
    : await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );
  if (googleNative) {
    mimeType = 'application/pdf';
    if (!fileName.toLowerCase().endsWith('.pdf')) fileName += '.pdf';
  }

  const buffer = await collectBoundedBytes(response.data, {
    maxBytes: MAX_EVIDENCE_FILE_BYTES,
    label: 'Google Drive file',
    limitMessage: 'Google Drive file exceeds the 7 MB evidence limit',
  });

  // 3. Upload to our storage
  const storagePath = `evidence/${caseId}/gdrive/${uuidv4()}-${fileName}`;
  const { key, url, sha256 } = await storagePut(storagePath, buffer, mimeType);

  return { 
    key, 
    url, 
    sha256,
    fileName, 
    mimeType, 
    sourceMimeType,
    size: fileSize || buffer.length.toString(),
    modifiedTime: modifiedTime ? new Date(modifiedTime) : new Date(),
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
): Promise<Array<{ id: string; name: string; mimeType?: string | null; size?: string | null; webViewLink?: string | null }>> {
  const drive = await getDriveClient(userId, accountId);
  const allFiles: Array<{ id: string; name: string; mimeType?: string | null; size?: string | null; webViewLink?: string | null; modifiedTime?: string | null }> = [];
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
        fields: 'nextPageToken, files(id, name, mimeType, size, webViewLink, modifiedTime)',
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

function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Find exact filename matches across the selected account without walking folders. */
export async function findGoogleDriveFilesByExactName(
  userId: string,
  exactFileName: string,
  accountId?: string,
): Promise<Array<{ id: string; name: string; mimeType?: string | null; size?: string | null; webViewLink?: string | null; modifiedTime?: string | null }>> {
  const name = exactFileName.trim();
  if (!name) return [];
  const drive = await getDriveClient(userId, accountId);
  const files: Array<{ id: string; name: string; mimeType?: string | null; size?: string | null; webViewLink?: string | null; modifiedTime?: string | null }> = [];
  const budget = new ProviderBatchBudget({
    pages: PROVIDER_LIMITS.googleDrive.maxListPages,
    files: PROVIDER_LIMITS.googleDrive.maxExactNameMatches,
  });
  let pageToken: string | undefined;
  do {
    budget.consume('pages', 1, 'Google Drive exact-name page limit exceeded');
    const response = await drive.files.list({
      q: `name = '${escapeDriveQueryLiteral(name)}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
      fields: 'nextPageToken, files(id, name, mimeType, size, webViewLink, modifiedTime)',
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

/**
 * Search files in Google Drive by query
 */
export async function searchGoogleDriveFiles(
  userId: string, 
  query: string,
  inFolder?: string,
  accountId?: string,
) {
  const drive = await getDriveClient(userId, accountId);
  
  let searchQuery = `name contains '${escapeDriveQueryLiteral(query)}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  
  if (inFolder) {
    searchQuery += ` and '${escapeDriveQueryLiteral(inFolder)}' in parents`;
  }

  const response = await drive.files.list({
    q: searchQuery,
    fields: 'files(id, name, mimeType, size, webViewLink, modifiedTime)',
    orderBy: 'modifiedTime desc',
    pageSize: 100,
  });

  return response.data.files || [];
}
