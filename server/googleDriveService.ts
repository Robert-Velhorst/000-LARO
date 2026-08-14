import { google } from 'googleapis';
import { getDb } from './db';
import { emailAccounts, googleDriveFiles } from './schema';
import { eq, and } from 'drizzle-orm';
import { storagePut } from './storage';
import { v4 as uuidv4 } from 'uuid';
import { decryptToken, encryptToken, refreshGmailToken } from './emailOAuth';

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
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, size, webViewLink, modifiedTime)',
  });

  return response.data.files || [];
}

/**
 * Download a file from Google Drive and upload it to local/S3 storage
 */
export async function downloadAndUploadGoogleDriveFile(fileId: string, caseId: string, userId?: string, accountId?: string) {
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

  // Google-native documents have no media body. Export them to PDF so the
  // same source-grounded text extraction pipeline can analyze them.
  const googleNative = sourceMimeType.startsWith('application/vnd.google-apps.');
  const response = googleNative
    ? await drive.files.export(
        { fileId, mimeType: 'application/pdf' },
        { responseType: 'arraybuffer' }
      )
    : await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
  if (googleNative) {
    mimeType = 'application/pdf';
    if (!fileName.toLowerCase().endsWith('.pdf')) fileName += '.pdf';
  }

  const buffer = Buffer.from(response.data as ArrayBuffer);

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
    query += ` and '${parentId}' in parents`;
  } else {
    query += " and 'root' in parents";
  }

  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name, modifiedTime, parents)',
    orderBy: 'name',
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

  async function scanFolder(currentFolderId: string) {
    let pageToken: string | undefined;
    do {
      const response = await drive.files.list({
        q: `'${currentFolderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, webViewLink, modifiedTime)',
        pageToken,
      });

      const items = response.data.files || [];
      for (const item of items) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          if (recursive) {
            await scanFolder(item.id!);
          }
        } else {
          allFiles.push(item as any);
        }
      }
      pageToken = response.data.nextPageToken || undefined;
    } while (pageToken);
  }
  
  await scanFolder(folderId);
  return allFiles;
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
  
  let searchQuery = `name contains '${query}' and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  
  if (inFolder) {
    searchQuery += ` and '${inFolder}' in parents`;
  }

  const response = await drive.files.list({
    q: searchQuery,
    fields: 'files(id, name, mimeType, size, webViewLink, modifiedTime)',
    orderBy: 'modifiedTime desc',
  });

  return response.data.files || [];
}
