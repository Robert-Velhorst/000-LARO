import { getDb } from './db';
import { eq, and, desc, gt, lt } from 'drizzle-orm';
import { notifyOwner } from './notification';
import {
  autoCollectionSettings,
  autoCollectionLogs,
  keywordPullJobs,
  keywordMatches,
  emailMessages,
  googleDriveFiles,
  emailAccounts,
  evidence as evidenceTable,
  cases as casesTable,
} from './schema';
import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import { downloadAndUploadGoogleDriveFile, getGoogleDriveFileMetadata } from './googleDriveService';
import { decryptToken, encryptToken, refreshGmailToken } from './emailOAuth';
import { searchGmailEmails, getGmailMessage, getGmailAttachment } from './gmailService';
import { getAllFilesInFolder } from './googleDriveService';
import { storagePut } from './storage';
import { createEvidenceFile } from './evidence';
import { analyzeStoredEvidence } from './documentAnalysisService';
import { supportsDocumentAnalysisMime } from './documentIntelligence';
import { getStoredGmailEvidenceState, resolveGmailAccountIds } from './gmailCollectionPolicy';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Evidence Auto-Collection Service
 * Automatically collects emails and files from Gmail and Google Drive based on keywords
 */

interface AutoCollectionConfig {
  caseId: string;
  userId: string;
  keywords: string[];
  keywordMatchMode: 'all' | 'any';
  dateRangeStart?: Date;
  dateRangeEnd?: Date;
  emailAccountIds: string[];
  googleDriveAccountId?: string;
  googleDriveFolderIds?: string[];
  autoDownloadAttachments: boolean;
  autoDownloadGoogleDriveFiles: boolean;
}

async function analyzeImportedEvidence(
  evidenceId: string,
  userId: string,
  mimeType: string,
  label: string,
  errors: string[],
): Promise<number> {
  if (!supportsDocumentAnalysisMime(mimeType)) return 0;
  try {
    const analysis = await analyzeStoredEvidence({ userId, evidenceId, deepAnalysis: false });
    return analysis.result.analyzedWords ?? countWords(analysis.result.summary || '');
  } catch (error) {
    errors.push(`Analysis for "${label}" failed: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}

/**
 * Get auto-collection settings for a case
 */
export async function getAutoCollectionSettings(caseId: string) {
  const db = await getDb();
  if (!db) {
    return null;
  }

  const settings = await db
    .select()
    .from(autoCollectionSettings)
    .where(eq(autoCollectionSettings.caseId, caseId))
    .limit(1);

  return settings.length > 0 ? settings[0] : null;
}

/**
 * Create or update auto-collection settings
 */
export async function upsertAutoCollectionSettings(config: AutoCollectionConfig) {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const existing = await getAutoCollectionSettings(config.caseId);
  const metadata = existing?.metadata
    ? (() => {
        try { return JSON.parse(existing.metadata); } catch { return {}; }
      })()
    : {};
  if (config.googleDriveAccountId) metadata.googleDriveAccountId = config.googleDriveAccountId;
  else delete metadata.googleDriveAccountId;

  const settingsData = {
    caseId: config.caseId,
    userId: config.userId,
    keywords: JSON.stringify(config.keywords),
    keywordMatchMode: config.keywordMatchMode,
    dateRangeStart: config.dateRangeStart,
    dateRangeEnd: config.dateRangeEnd,
    emailAccountIds: JSON.stringify(config.emailAccountIds),
    metadata: JSON.stringify(metadata),
    googleDriveFolderIds: config.googleDriveFolderIds ? JSON.stringify(config.googleDriveFolderIds) : null,
    autoDownloadAttachments: config.autoDownloadAttachments,
    autoDownloadGoogleDriveFiles: config.autoDownloadGoogleDriveFiles,
  };

  if (existing) {
    await db
      .update(autoCollectionSettings)
      .set(settingsData)
      .where(eq(autoCollectionSettings.caseId, config.caseId));
  } else {
    await db.insert(autoCollectionSettings).values({
      id: uuidv4(),
      ...settingsData,
      isEnabled: true,
      status: 'active',
    });
  }
}

/**
 * Check if text matches keywords
 */
function matchesKeywords(text: string, keywords: string[], mode: 'all' | 'any'): boolean {
  const lowerText = text.toLowerCase();
  const matchedKeywords = keywords.filter((kw) => lowerText.includes(kw.toLowerCase()));

  if (mode === 'all') {
    return matchedKeywords.length === keywords.length;
  } else {
    return matchedKeywords.length > 0;
  }
}

/**
 * Run auto-collection for a case
 */
async function runAutoCollectionLegacy(caseId: string): Promise<{
  emailsFound: number;
  emailsProcessed: number;
  filesFound: number;
  filesDownloaded: number;
  errors: string[];
}> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const settings = await getAutoCollectionSettings(caseId);
  if (!settings) {
    throw new Error('Auto-collection settings not found for case');
  }

  const logId = uuidv4();
  const startTime = new Date();
  const errors: string[] = [];

  let emailsFound = 0;
  let emailsProcessed = 0;
  let filesFound = 0;
  let filesDownloaded = 0;

  try {
    const keywords = JSON.parse(settings.keywords || '[]');
    const emailAccountIds = JSON.parse(settings.emailAccountIds || '[]');
    const keywordMatchMode = (settings.keywordMatchMode as 'all' | 'any') || 'any';

    // Collect emails from Gmail
    for (const accountId of emailAccountIds) {
      try {
        const emailsResult = await collectEmailsFromGmail(
          caseId,
          accountId,
          keywords,
          keywordMatchMode,
          settings.dateRangeStart || undefined,
          settings.dateRangeEnd || undefined
        );
        emailsFound += emailsResult.found;
        emailsProcessed += emailsResult.processed;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error collecting emails';
        errors.push(`Email collection error for account ${accountId}: ${errorMsg}`);
      }
    }

    // Collect files from Google Drive
    if (settings.autoDownloadGoogleDriveFiles) {
      const googleDriveFolderIds = settings.googleDriveFolderIds
        ? JSON.parse(settings.googleDriveFolderIds)
        : [];

      for (const folderId of googleDriveFolderIds) {
        try {
          const filesResult = await collectFilesFromGoogleDrive(
            caseId,
            folderId,
            keywords,
            keywordMatchMode
          );
          filesFound += filesResult.found;
          filesDownloaded += filesResult.downloaded;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error collecting files';
          errors.push(`File collection error for folder ${folderId}: ${errorMsg}`);
        }
      }
    }

    // Save log
    const executionTime = (new Date().getTime() - startTime.getTime()) / 1000;
    await db.insert(autoCollectionLogs).values({
      id: logId,
      caseId,
      settingsId: settings.id,
      userId: settings.userId,
      runStartedAt: startTime,
      runCompletedAt: new Date(),
      status: 'completed',
      emailsFound: String(emailsFound),
      emailsProcessed: String(emailsProcessed),
      filesFound: String(filesFound),
      filesDownloaded: String(filesDownloaded),
      errorCount: String(errors.length),
      executionTimeSeconds: String(Math.round(executionTime)),
    });

    // Update settings
    await db
      .update(autoCollectionSettings)
      .set({
        lastRunAt: new Date(),
        totalItemsCollected: String(emailsProcessed + filesDownloaded),
        totalEmailsCollected: String(emailsProcessed),
        totalFilesCollected: String(filesDownloaded),
      })
      .where(eq(autoCollectionSettings.caseId, caseId));

    return {
      emailsFound,
      emailsProcessed,
      filesFound,
      filesDownloaded,
      errors,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    errors.push(errorMsg);

    // Save failed log
    const executionTime = (new Date().getTime() - startTime.getTime()) / 1000;
    await db.insert(autoCollectionLogs).values({
      id: logId,
      caseId,
      settingsId: settings.id,
      userId: settings.userId,
      runStartedAt: startTime,
      runCompletedAt: new Date(),
      status: 'failed',
      errorMessage: errorMsg,
      errorCount: String(errors.length),
      executionTimeSeconds: String(Math.round(executionTime)),
    });

    throw error;
  }
}

/**
 * Collect emails from Gmail based on keywords
 */
async function collectEmailsFromGmail(
  caseId: string,
  accountId: string,
  keywords: string[],
  matchMode: 'all' | 'any',
  dateRangeStart?: Date,
  dateRangeEnd?: Date
): Promise<{
  found: number;
  processed: number;
}> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const conditions = [eq(emailMessages.accountId, accountId)];
  
  if (dateRangeStart) {
    conditions.push(gt(emailMessages.date, dateRangeStart));
  }
  if (dateRangeEnd) {
    conditions.push(lt(emailMessages.date, dateRangeEnd));
  }
  
  const messages = await db.select().from(emailMessages).where(and(...conditions));

  let found = 0;
  let processed = 0;

  for (const message of messages) {
    // Check if message matches keywords
    const searchText = `${message.subject || ''} ${message.body || ''} ${message.snippet || ''}`;
    const matches = matchesKeywords(searchText, keywords, matchMode);

    if (matches) {
      found++;

      // Link message to case if not already linked
      if (!message.caseId) {
        await db
          .update(emailMessages)
          .set({ caseId })
          .where(eq(emailMessages.id, message.id));
        processed++;
      }

      // Record keyword match
      const matchedKeywords = keywords.filter((kw) => searchText.toLowerCase().includes(kw.toLowerCase()));
      if (matchedKeywords.length > 0) {
        await db.insert(keywordMatches).values({
          id: uuidv4(),
          caseId,
          itemId: message.id,
          itemType: 'email',
          matchedKeywords: JSON.stringify(matchedKeywords),
          matchCount: String(matchedKeywords.length),
        });
      }
    }
  }

  return { found, processed };
}

/**
 * Collect files from Google Drive based on keywords
 */
async function collectFilesFromGoogleDrive(
  caseId: string,
  folderId: string,
  keywords: string[],
  matchMode: 'all' | 'any'
): Promise<{
  found: number;
  downloaded: number;
}> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const { evidence } = await import('./schema');

  let found = 0;
  let downloaded = 0;

  try {
    // Resolve the owner before opening Drive so background collection cannot
    // fall back to an unrelated connected Google account.
    const { cases } = await import('./schema');
    const caseData = await db.select().from(cases).where(eq(cases.id, caseId)).limit(1);
    if (!caseData[0]) throw new Error(`Case ${caseId} not found`);
    const userId = caseData[0].userId;
    if (!userId) throw new Error(`Case ${caseId} has no owner`);

    // 1. Get file list from folder
    const files = await getGoogleDriveFileMetadata(folderId, userId);
    
    for (const file of files) {
      if (!file.name) continue;

      // 2. Check file names against keywords
      const matches = matchesKeywords(file.name, keywords, matchMode);
      
      if (matches) {
        found++;

        // 3. Check if already downloaded/exists in evidence table
        const existingEvidence = await db
          .select()
          .from(evidence)
          .where(and(
            eq(evidence.caseId, caseId),
            eq(evidence.source, 'google_drive')
          ));

        const alreadyImported = existingEvidence.some(e => {
          const metadata = e.metadata ? JSON.parse(e.metadata) : {};
          return metadata.driveFileId === file.id;
        });

        if (alreadyImported) {
          console.log(`[AutoCollection] File ${file.name} already imported, skipping`);
          continue;
        }

        try {
          // 4. Download and upload to local storage/S3
          const fileData = await downloadAndUploadGoogleDriveFile(file.id!, caseId, userId);
          
          // 5. Create evidence record
          const evidenceId = uuidv4();
          await db.insert(evidence).values({
            id: evidenceId,
            caseId,
            userId,
            type: determineEvidenceType(fileData.mimeType),
            source: 'google_drive',
            title: file.name,
            description: `Auto-collected from Google Drive`,
            fileUrl: fileData.url,
            fileName: fileData.fileName,
            fileSize: fileData.size,
            mimeType: fileData.mimeType,
            metadata: JSON.stringify({
              driveFileId: file.id,
              folderId,
              autoCollected: true,
              collectedAt: new Date().toISOString(),
              modifiedTime: fileData.modifiedTime,
            }),
            relevant: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          // Also insert into googleDriveFiles for tracking
          await db.insert(googleDriveFiles).values({
            id: uuidv4(),
            userId,
            caseId,
            googleFileId: file.id,
            fileName: fileData.fileName,
            mimeType: fileData.mimeType,
            fileSize: fileData.size,
            s3Key: fileData.key,
            s3Url: fileData.url,
            googleWebViewLink: file.webViewLink || null,
            googleModifiedTime: fileData.modifiedTime,
            evidenceType: determineEvidenceType(fileData.mimeType),
            isIncluded: 'Yes',
            metadata: JSON.stringify({
              folderId,
              sourceMimeType: fileData.sourceMimeType,
            }),
          });
          
          downloaded++;
          console.log(`[AutoCollection] Downloaded and created evidence for: ${file.name}`);
        } catch (downloadError) {
          console.error(`[AutoCollection] Failed to download ${file.name}:`, downloadError);
        }
      }
    }
  } catch (error) {
    console.error(`[AutoCollection] Google Drive scan failed for folder ${folderId}:`, error);
  }

  return { found, downloaded };
}

/**
 * Determine evidence type from MIME type
 */
function determineEvidenceType(mimeType?: string): string {
  if (!mimeType) return 'document';

  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('pdf')) return 'document';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'document';
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) return 'document';
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) return 'document';
  if (mimeType.includes('text')) return 'document';

  return 'document';
}

/**
 * Get auto-collection logs for a case
 */
export async function getAutoCollectionLogs(caseId: string, limit: number = 10) {
  const db = await getDb();
  if (!db) {
    return [];
  }

  const logs = await db
    .select()
    .from(autoCollectionLogs)
    .where(eq(autoCollectionLogs.caseId, caseId))
    .orderBy(desc(autoCollectionLogs.runStartedAt))
    .limit(limit);

  return logs;
}

/**
 * Run auto-collection for all cases with enabled settings
 * Called by cron scheduler daily at 2:00 AM
 */
export async function runAutoCollectionForAllCases(): Promise<{
  casesProcessed: number;
  emailsCollected: number;
  filesCollected: number;
  errors: string[];
}> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  // Get all enabled auto-collection settings
  const enabledSettings = await db
    .select()
    .from(autoCollectionSettings)
    .where(
      and(
        eq(autoCollectionSettings.isEnabled, true),
        eq(autoCollectionSettings.status, 'active')
      )
    );

  console.log(`[AutoCollection] Found ${enabledSettings.length} cases with enabled auto-collection`);

  let casesProcessed = 0;
  let totalEmailsCollected = 0;
  let totalFilesCollected = 0;
  const errors: string[] = [];

  for (const settings of enabledSettings) {
    if (!settings.caseId) {
      errors.push(`Auto-collection setting ${settings.id} has no case and was skipped`);
      continue;
    }
    try {
      console.log(`[AutoCollection] Processing case ${settings.caseId}...`);
      const result = await runAutoCollection(settings.caseId);
      casesProcessed++;
      totalEmailsCollected += result.emailsProcessed;
      totalFilesCollected += result.filesDownloaded;
      
      if (result.errors.length > 0) {
        errors.push(...result.errors.map(e => `Case ${settings.caseId}: ${e}`));
      }
      
      console.log(`[AutoCollection] Case ${settings.caseId}: ${result.emailsProcessed} emails, ${result.filesDownloaded} files`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      errors.push(`Case ${settings.caseId}: ${errorMsg}`);
      console.error(`[AutoCollection] Error processing case ${settings.caseId}:`, errorMsg);
    }
  }

  // Send notification to owner about collection results
  if (casesProcessed > 0 || errors.length > 0) {
    try {
      const hasNewEvidence = totalEmailsCollected > 0 || totalFilesCollected > 0;
      const title = hasNewEvidence 
        ? `📧 Auto-Collection: ${totalEmailsCollected + totalFilesCollected} new items found`
        : `📧 Auto-Collection completed`;
      
      let content = `**Daily Evidence Auto-Collection Report**\n\n`;
      content += `- Cases processed: ${casesProcessed}\n`;
      content += `- Emails collected: ${totalEmailsCollected}\n`;
      content += `- Files collected: ${totalFilesCollected}\n`;
      
      if (errors.length > 0) {
        content += `\n**Errors (${errors.length}):**\n`;
        content += errors.slice(0, 5).map(e => `- ${e}`).join('\n');
        if (errors.length > 5) {
          content += `\n- ... and ${errors.length - 5} more errors`;
        }
      }
      
      await notifyOwner({ title, content });
      console.log('[AutoCollection] Notification sent to owner');
    } catch (notifyError) {
      console.error('[AutoCollection] Failed to send notification:', notifyError);
    }
  }

  return {
    casesProcessed,
    emailsCollected: totalEmailsCollected,
    filesCollected: totalFilesCollected,
    errors,
  };
}

/**
 * Get keyword matches for a case
 */
export async function getKeywordMatches(caseId: string) {
  const db = await getDb();
  if (!db) {
    return [];
  }

  const matches = await db
    .select()
    .from(keywordMatches)
    .where(eq(keywordMatches.caseId, caseId));

  return matches;
}

// ────────────────────────────────────────────────────────────────────────────
// One-shot keyword pull: pulls evidence from every connected source for a case
// in a single call, without requiring saved auto-collection settings.
// ────────────────────────────────────────────────────────────────────────────

export interface PullByKeywordsResult {
  gmailMessages: number;
  gmailAttachments: number;
  driveFiles: number;
  localFiles: number;
  errors: string[];
}

export type PullProgressPhase = 'queued' | 'discovering' | 'gmail' | 'drive' | 'local' | 'finalizing';

export interface PullProgressUpdate {
  phase: PullProgressPhase;
  message: string;
  processedWordsDelta?: number;
  totalWordsDelta?: number;
  processedItemsDelta?: number;
  totalItemsDelta?: number;
}

export type PullProgressReporter = (update: PullProgressUpdate) => void;

function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/**
 * Read & decrypt a Gmail access token for the user, refreshing if expired.
 * Returns null when the user has no connected Gmail account.
 */
async function getFreshGmailAccessToken(userId: string, accountId?: string): Promise<{ accessToken: string; accountId: string; email: string } | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(emailAccounts)
    .where(and(
      eq(emailAccounts.userId, userId),
      eq(emailAccounts.provider, 'gmail'),
      ...(accountId ? [eq(emailAccounts.id, accountId)] : []),
    ))
    .limit(2);

  if (!accountId && rows.length > 1) {
    throw new Error('Multiple Google accounts are connected. Select the account to use.');
  }
  const account = rows[0];
  if (!account || account.status !== 'connected' || !account.accessToken) return null;

  let accessToken = decryptToken(account.accessToken);

  // Refresh if expired (or within 60s of expiry).
  const expiryMs = account.tokenExpiry ? new Date(account.tokenExpiry).getTime() : 0;
  if (expiryMs && expiryMs - Date.now() < 60_000 && account.refreshToken) {
    try {
      const refreshed = await refreshGmailToken(decryptToken(account.refreshToken));
      accessToken = refreshed.accessToken;
      await db
        .update(emailAccounts)
        .set({
          accessToken: encryptToken(accessToken),
          tokenExpiry: new Date(refreshed.expiryDate),
        })
        .where(eq(emailAccounts.id, account.id));
    } catch (err) {
      console.warn('[AutoCollection] Gmail token refresh failed:', err);
    }
  }

  return { accessToken, accountId: account.id, email: account.email || '' };
}

/**
 * Pull matching emails (and their attachments) from Gmail for the given case
 * + user using Gmail's native query syntax. Each matching email becomes an
 * evidence record; each attachment is downloaded and becomes its own evidence
 * record so attorneys can preview/download from the case view.
 */
async function pullFromGmail(
  caseId: string,
  userId: string,
  keywords: string[],
  matchMode: 'all' | 'any',
  errors: string[],
  dateStart?: Date,
  dateEnd?: Date,
  includeAttachments = true,
  accountIds?: string[],
  onProgress?: PullProgressReporter,
): Promise<{ messages: number; attachments: number }> {
  const db = await getDb();
  if (!db) return { messages: 0, attachments: 0 };

  const selectedAccountIds = [...new Set((accountIds || []).filter(Boolean))];
  if (selectedAccountIds.length > 1) {
    let messages = 0;
    let attachments = 0;
    for (const selectedAccountId of selectedAccountIds) {
      const result = await pullFromGmail(
        caseId,
        userId,
        keywords,
        matchMode,
        errors,
        dateStart,
        dateEnd,
        includeAttachments,
        [selectedAccountId],
        onProgress,
      );
      messages += result.messages;
      attachments += result.attachments;
    }
    return { messages, attachments };
  }

  const selectedAccountId = selectedAccountIds[0];
  const cred = await getFreshGmailAccessToken(userId, selectedAccountId);
  if (!cred) {
    if (selectedAccountId) errors.push(`Selected Gmail account ${selectedAccountId} is unavailable.`);
    return { messages: 0, attachments: 0 };
  }

  // Build a Gmail-syntax query. For "any", OR keywords together; for "all",
  // AND them (Gmail's default is AND).
  const quoted = keywords.map((k) => (k.includes(' ') ? `"${k.replace(/"/g, '')}"` : k));
  const keywordPart =
    matchMode === 'any' ? `(${quoted.join(' OR ')})` : quoted.join(' ');
  // Gmail uses after:/before: with YYYY/MM/DD.
  const fmt = (d: Date) =>
    `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const datePart = [
    dateStart ? `after:${fmt(dateStart)}` : '',
    dateEnd ? `before:${fmt(dateEnd)}` : '',
  ].filter(Boolean).join(' ');
  const query = [keywordPart, datePart].filter(Boolean).join(' ');

  let threads: { id: string }[] = [];
  try {
    threads = await searchGmailEmails(cred.accessToken, { maxResults: 30 }).then(
      // Cast: searchGmailEmails returns GmailThread[]
      (t: any[]) => t.map((row) => ({ id: row.id })),
    );
    // searchGmailEmails ignores the query arg; bypass it by calling listGmailThreads directly.
  } catch {
    threads = [];
  }

  // Re-list with the real keyword query (searchGmailEmails only handles structured filters).
  try {
    const params = new URLSearchParams({ maxResults: '30', q: query });
    const res = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      { headers: { Authorization: `Bearer ${cred.accessToken}` } },
    );
    const data = (await res.json()) as { messages?: { id: string; threadId: string }[]; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    threads = (data.messages || []).map((m) => ({ id: m.id }));
  } catch (err) {
    errors.push(`Gmail search failed: ${err instanceof Error ? err.message : String(err)}`);
    return { messages: 0, attachments: 0 };
  }

  let messagesIngested = 0;
  let attachmentsIngested = 0;
  onProgress?.({
    phase: 'gmail',
    message: `Reviewing ${threads.length} Gmail message${threads.length === 1 ? '' : 's'}`,
    totalItemsDelta: threads.length,
    totalWordsDelta: threads.length,
  });

  for (const t of threads) {
    let messageWords = 1;
    try {
      const msg = await getGmailMessage(cred.accessToken, t.id);
      const headers = (msg.payload?.headers || []).reduce<Record<string, string>>(
        (acc, h) => ((acc[h.name.toLowerCase()] = h.value), acc),
        {},
      );
      const subject = headers.subject || '(no subject)';
      const from = headers.from || 'unknown';
      const date = msg.internalDate
        ? new Date(parseInt(msg.internalDate, 10))
        : new Date();

      // Dedupe each message part independently so attachments can be backfilled
      // after attachment collection is enabled for an already-known message.
      const existing = await db
        .select()
        .from(evidenceTable)
        .where(and(eq(evidenceTable.caseId, caseId), eq(evidenceTable.source, 'gmail')));
      const storedState = getStoredGmailEvidenceState(
        existing.map((e) => e.metadata),
        cred.accountId,
        msg.id,
      );

      // Build a plain-text body excerpt.
      let body = '';
      const collectBody = (payload: any) => {
        if (!payload) return;
        if (payload.body?.data && payload.mimeType?.startsWith('text/')) {
          try {
            body += Buffer.from(payload.body.data, 'base64').toString('utf-8') + '\n';
          } catch {}
        }
        if (payload.parts) payload.parts.forEach(collectBody);
      };
      collectBody(msg.payload);
      messageWords = Math.max(1, countWords(`${from} ${subject} ${body}`));
      onProgress?.({
        phase: 'gmail',
        message: `Reading Gmail message: ${subject}`,
        totalWordsDelta: Math.max(0, messageWords - 1),
      });

      if (!storedState.messageStored) {
        const messageSource = [
          `From: ${from}`,
          `Subject: ${subject}`,
          `Date: ${date.toISOString()}`,
          '',
          body,
        ].join('\n');
        const messageStorageKey = `evidence/${caseId}/gmail/${uuidv4()}-${msg.id}.eml`;
        const storedMessage = await storagePut(messageStorageKey, Buffer.from(messageSource), 'message/rfc822');
        const messageEvidenceId = await createEvidenceFile(userId, {
          caseId,
          type: 'email',
          source: 'gmail',
          title: subject,
          description: `From ${from} on ${date.toISOString()}`,
          fileUrl: storedMessage.url,
          fileName: `${msg.id}.eml`,
          fileSize: String(Buffer.byteLength(messageSource)),
          mimeType: 'message/rfc822',
          metadata: JSON.stringify({
            storageKey: storedMessage.key,
            gmailMessageId: msg.id,
            gmailThreadId: (msg as any).threadId,
            from,
            subject,
            date: date.toISOString(),
            bodyExcerpt: body.slice(0, 2000),
            accountId: cred.accountId,
            autoCollected: true,
          }),
          contentHash: storedMessage.sha256,
          relevant: true,
        });
        await analyzeImportedEvidence(messageEvidenceId, userId, 'message/rfc822', subject, errors);
        messagesIngested++;
      }

      // Download attachments.
      const attachments: { partId: string; filename: string; mimeType: string; attachmentId: string }[] = [];
      const collectAttachments = (payload: any) => {
        if (!payload) return;
        if (payload.filename && payload.body?.attachmentId) {
          attachments.push({
            partId: payload.partId,
            filename: payload.filename,
            mimeType: payload.mimeType || 'application/octet-stream',
            attachmentId: payload.body.attachmentId,
          });
        }
        if (payload.parts) payload.parts.forEach(collectAttachments);
      };
      collectAttachments(msg.payload);
      if (!includeAttachments) attachments.length = 0;
      if (attachments.length > 0) {
        onProgress?.({
          phase: 'gmail',
          message: `Found ${attachments.length} Gmail attachment${attachments.length === 1 ? '' : 's'}`,
          totalItemsDelta: attachments.length,
        });
      }

      for (const att of attachments) {
        let attachmentWords = 0;
        try {
          if (storedState.attachmentIds.has(att.attachmentId)) continue;
          const a = await getGmailAttachment(cred.accessToken, msg.id, att.attachmentId);
          if (!a?.data) continue;
          // Gmail uses URL-safe base64.
          const normalized = a.data.replace(/-/g, '+').replace(/_/g, '/');
          const buf = Buffer.from(normalized, 'base64');
          const safeName = path.basename(att.filename.replace(/\\/g, '/')) || 'attachment';
          const storageKey = `evidence/${caseId}/gmail/${uuidv4()}-${safeName}`;
          const storedAttachment = await storagePut(storageKey, buf, att.mimeType);
          const attachmentEvidenceId = await createEvidenceFile(userId, {
            caseId,
            type: determineEvidenceType(att.mimeType),
            source: 'gmail',
            title: safeName,
            description: `Attachment from email "${subject}"`,
            fileUrl: storedAttachment.url,
            fileName: safeName,
            fileSize: String(buf.length),
            mimeType: att.mimeType,
            metadata: JSON.stringify({
              storageKey: storedAttachment.key,
              gmailMessageId: msg.id,
              attachmentId: att.attachmentId,
              accountId: cred.accountId,
              parentSubject: subject,
              autoCollected: true,
            }),
            contentHash: storedAttachment.sha256,
            relevant: true,
          });
          attachmentWords = await analyzeImportedEvidence(
            attachmentEvidenceId,
            userId,
            att.mimeType,
            safeName,
            errors,
          );
          storedState.attachmentIds.add(att.attachmentId);
          attachmentsIngested++;
        } catch (err) {
          errors.push(`Attachment "${att.filename}" failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          onProgress?.({
            phase: 'gmail',
            message: `Reviewed Gmail attachment: ${att.filename}`,
            processedItemsDelta: 1,
            processedWordsDelta: attachmentWords,
            totalWordsDelta: attachmentWords,
          });
        }
      }
    } catch (err) {
      errors.push(`Gmail message fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      onProgress?.({
        phase: 'gmail',
        message: 'Reviewed a Gmail message',
        processedItemsDelta: 1,
        processedWordsDelta: messageWords,
      });
    }
  }

  return { messages: messagesIngested, attachments: attachmentsIngested };
}

/**
 * Pull files from Google Drive that match keywords by filename.
 * If folderIds is empty, falls back to scanning the user's "root" folder.
 */
async function pullFromDrive(
  caseId: string,
  userId: string,
  keywords: string[],
  matchMode: 'all' | 'any',
  folderIds: string[],
  errors: string[],
  accountId?: string,
  dateStart?: Date,
  dateEnd?: Date,
  onProgress?: PullProgressReporter,
): Promise<{ files: number }> {
  const db = await getDb();
  if (!db) return { files: 0 };

  // Verify the user has Drive access via Gmail OAuth.
  const cred = await getFreshGmailAccessToken(userId, accountId);
  if (!cred) return { files: 0 };

  const folders = folderIds.length > 0 ? folderIds : ['root'];
  let downloaded = 0;

  for (const folderId of folders) {
    try {
      const files = await getAllFilesInFolder(userId, folderId, true, cred.accountId);
      const candidates = files.filter((file) => {
        if (!file.name || !file.id || !matchesKeywords(file.name, keywords, matchMode)) return false;
        const modified = (file as any).modifiedTime ? new Date((file as any).modifiedTime) : null;
        if (dateStart && modified && modified < dateStart) return false;
        if (dateEnd && modified && modified > dateEnd) return false;
        return true;
      });
      onProgress?.({
        phase: 'drive',
        message: `Reviewing ${candidates.length} matching Drive file${candidates.length === 1 ? '' : 's'}`,
        totalItemsDelta: candidates.length,
      });
      for (const file of candidates) {
        if (!file.name || !file.id) continue;
        let fileWords = 0;
        try {
          const existing = await db
            .select()
            .from(evidenceTable)
            .where(and(eq(evidenceTable.caseId, caseId), eq(evidenceTable.source, 'google_drive')));
          const already = existing.some((e) => {
            try {
              const meta = e.metadata ? JSON.parse(e.metadata) : {};
              return meta.driveFileId === file.id;
            } catch {
              return false;
            }
          });
          if (already) continue;

          const fileData = await downloadAndUploadGoogleDriveFile(file.id, caseId, userId, cred.accountId);
          const evidenceId = await createEvidenceFile(userId, {
            caseId,
            type: determineEvidenceType(fileData.mimeType),
            source: 'google_drive',
            title: file.name,
            description: 'Auto-collected from Google Drive',
            fileUrl: fileData.url,
            fileName: fileData.fileName,
            fileSize: fileData.size,
            mimeType: fileData.mimeType,
            metadata: JSON.stringify({
              storageKey: fileData.key,
              driveFileId: file.id,
              driveAccountId: cred.accountId,
              folderId,
              sourceMimeType: fileData.sourceMimeType,
              autoCollected: true,
              collectedAt: new Date().toISOString(),
              modifiedTime: fileData.modifiedTime,
            }),
            contentHash: fileData.sha256,
            relevant: true,
          });
          fileWords = await analyzeImportedEvidence(evidenceId, userId, fileData.mimeType, file.name, errors);
          await db.insert(googleDriveFiles).values({
            id: uuidv4(),
            userId,
            caseId,
            googleFileId: file.id,
            fileName: fileData.fileName,
            mimeType: fileData.mimeType,
            fileSize: fileData.size,
            s3Key: fileData.key,
            s3Url: fileData.url,
            googleWebViewLink: file.webViewLink || null,
            googleModifiedTime: fileData.modifiedTime,
            evidenceType: determineEvidenceType(fileData.mimeType),
            isIncluded: 'Yes',
            metadata: JSON.stringify({ sourceMimeType: fileData.sourceMimeType }),
          });
          downloaded++;
        } catch (err) {
          errors.push(`Drive file "${file.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          onProgress?.({
            phase: 'drive',
            message: `Reviewed Drive file: ${file.name}`,
            processedItemsDelta: 1,
            processedWordsDelta: fileWords,
            totalWordsDelta: fileWords,
          });
        }
      }
    } catch (err) {
      errors.push(`Drive folder ${folderId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { files: downloaded };
}

/**
 * Recursively scan a local directory for files whose names match keywords.
 * Limits depth and file count so we never lock up the server on huge trees.
 */
async function scanLocalDirectory(
  rootPath: string,
  keywords: string[],
  matchMode: 'all' | 'any',
  errors: string[],
  maxFiles = 500,
  maxDepth = 6,
): Promise<{ absPath: string; name: string }[]> {
  const matches: { absPath: string; name: string }[] = [];

  async function walk(dir: string, depth: number) {
    if (matches.length >= maxFiles || depth > maxDepth) return;
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`Cannot read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip common noise.
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (matchesKeywords(entry.name, keywords, matchMode)) {
          matches.push({ absPath: full, name: entry.name });
        }
      }
    }
  }

  await walk(rootPath, 0);
  return matches;
}

async function resolveAllowedLocalFolder(folderPath: string): Promise<string> {
  if (!path.isAbsolute(folderPath)) throw new Error('Local scan paths must be absolute');
  const resolved = await fs.realpath(folderPath);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error('Local scan path is not a directory');
  if (process.env.LARO_PACKAGED_DESKTOP === 'true') return resolved;

  const configuredRoots = (process.env.LOCAL_SCAN_ROOTS || '')
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  if (configuredRoots.length === 0) {
    throw new Error('Local folder collection is disabled; configure LOCAL_SCAN_ROOTS on the server');
  }
  const allowedRoots = await Promise.all(configuredRoots.map(async (root) => fs.realpath(root)));
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error('Local scan path is outside LOCAL_SCAN_ROOTS');
  }
  return resolved;
}

/**
 * Pull matching files from one or more local folders. Files are copied into
 * the evidence storage layer (S3 if configured, on-disk fallback otherwise)
 * so they live alongside the case forever, independent of the source folder.
 */
async function pullFromLocalFolders(
  caseId: string,
  userId: string,
  keywords: string[],
  matchMode: 'all' | 'any',
  folderPaths: string[],
  errors: string[],
  dateStart?: Date,
  dateEnd?: Date,
  onProgress?: PullProgressReporter,
): Promise<{ files: number }> {
  const db = await getDb();
  if (!db) return { files: 0 };
  if (!folderPaths.length) return { files: 0 };

  let ingested = 0;

  for (const folderPath of folderPaths) {
    let resolvedFolderPath: string;
    try {
      resolvedFolderPath = await resolveAllowedLocalFolder(folderPath);
    } catch (error) {
      errors.push(`Local folder rejected: ${folderPath} (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }

    const found = await scanLocalDirectory(resolvedFolderPath, keywords, matchMode, errors);
    onProgress?.({
      phase: 'local',
      message: `Reviewing ${found.length} matching local file${found.length === 1 ? '' : 's'}`,
      totalItemsDelta: found.length,
    });

    for (const file of found) {
      let fileWords = 0;
      try {
        // Dedupe by absolute path.
        const existing = await db
          .select()
          .from(evidenceTable)
          .where(and(eq(evidenceTable.caseId, caseId), eq(evidenceTable.source, 'local')));
        const already = existing.some((e) => {
          try {
            const meta = e.metadata ? JSON.parse(e.metadata) : {};
            return meta.absPath === file.absPath;
          } catch {
            return false;
          }
        });
        if (already) continue;

        const stat = await fs.stat(file.absPath);
        if (dateStart && stat.mtime < dateStart) continue;
        if (dateEnd && stat.mtime > dateEnd) continue;
        const buf = await fs.readFile(file.absPath);
        const ext = path.extname(file.name).toLowerCase();
        const mimeType = guessMimeFromExt(ext);
        const storageKey = `evidence/${caseId}/local/${uuidv4()}-${file.name}`;
        const storedFile = await storagePut(storageKey, buf, mimeType);

        const evidenceId = await createEvidenceFile(userId, {
          caseId,
          type: determineEvidenceType(mimeType),
          source: 'local',
          title: file.name,
          description: `Auto-collected from local folder ${resolvedFolderPath}`,
          fileUrl: storedFile.url,
          fileName: file.name,
          fileSize: String(stat.size),
          mimeType,
          metadata: JSON.stringify({
            storageKey: storedFile.key,
            absPath: file.absPath,
            sourceFolder: resolvedFolderPath,
            autoCollected: true,
            collectedAt: new Date().toISOString(),
            modifiedTime: stat.mtime.toISOString(),
          }),
          contentHash: storedFile.sha256,
          relevant: true,
        });
        fileWords = await analyzeImportedEvidence(evidenceId, userId, mimeType, file.name, errors);
        ingested++;
      } catch (err) {
        errors.push(`Local file "${file.absPath}" failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        onProgress?.({
          phase: 'local',
          message: `Reviewed local file: ${file.name}`,
          processedItemsDelta: 1,
          processedWordsDelta: fileWords,
          totalWordsDelta: fileWords,
        });
      }
    }
  }

  return { files: ingested };
}

function guessMimeFromExt(ext: string): string {
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.doc': return 'application/msword';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls': return 'application/vnd.ms-excel';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.txt': return 'text/plain';
    case '.csv': return 'text/csv';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.heic': return 'image/heic';
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.eml': return 'message/rfc822';
    default: return 'application/octet-stream';
  }
}

/**
 * Read configured local folder paths for a case (stored in
 * autoCollectionSettings.metadata as JSON).
 */
async function getConfiguredLocalFolders(caseId: string): Promise<string[]> {
  const s = await getAutoCollectionSettings(caseId);
  if (!s?.metadata) return [];
  try {
    const meta = typeof s.metadata === 'string' ? JSON.parse(s.metadata) : s.metadata;
    return Array.isArray(meta.localFolderPaths) ? meta.localFolderPaths : [];
  } catch {
    return [];
  }
}

/**
 * One-shot autonomous pull: given a case and a set of keywords, pull matching
 * evidence from every connected source (Gmail, Google Drive, local folders)
 * in a single call. This is the entry point used by the case-view "Pull
 * evidence by keyword" panel.
 */
export async function pullEvidenceByKeywords(params: {
  caseId: string;
  userId: string;
  keywords: string[];
  matchMode?: 'all' | 'any';
  gmailAccountIds?: string[];
  driveAccountId?: string;
  driveFolderIds?: string[];
  localFolderPaths?: string[];
  dateStart?: Date;
  dateEnd?: Date;
  includeGmail?: boolean;
  includeGmailAttachments?: boolean;
  includeDrive?: boolean;
  includeLocal?: boolean;
  onProgress?: PullProgressReporter;
}): Promise<PullByKeywordsResult> {
  const matchMode = params.matchMode || 'any';
  const errors: string[] = [];

  if (!params.keywords || params.keywords.length === 0) {
    throw new Error('At least one keyword is required');
  }

  const db = await getDb();
  if (!db) throw new Error('Database not available');
  params.onProgress?.({ phase: 'discovering', message: 'Checking connected evidence sources' });

  // Resolve sources. Fall back to settings-configured sources, then to defaults.
  const settings = await getAutoCollectionSettings(params.caseId);
  const gmailAccountIds = resolveGmailAccountIds(
    params.gmailAccountIds,
    settings?.emailAccountIds,
  );

  let driveFolderIds = params.driveFolderIds;
  if (!driveFolderIds || driveFolderIds.length === 0) {
    if (settings?.googleDriveFolderIds) {
      try {
        driveFolderIds = JSON.parse(settings.googleDriveFolderIds);
      } catch {
        driveFolderIds = [];
      }
    }
  }
  driveFolderIds = driveFolderIds || [];

  let localFolderPaths = params.localFolderPaths;
  if (!localFolderPaths || localFolderPaths.length === 0) {
    localFolderPaths = await getConfiguredLocalFolders(params.caseId);
  }

  const [gmail, drive, local] = await Promise.all([
    (params.includeGmail === false ? Promise.resolve({ messages: 0, attachments: 0 }) : pullFromGmail(params.caseId, params.userId, params.keywords, matchMode, errors, params.dateStart, params.dateEnd, params.includeGmailAttachments !== false, gmailAccountIds, params.onProgress)).catch((err) => {
      errors.push(`Gmail pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return { messages: 0, attachments: 0 };
    }),
    (params.includeDrive === false ? Promise.resolve({ files: 0 }) : pullFromDrive(params.caseId, params.userId, params.keywords, matchMode, driveFolderIds, errors, params.driveAccountId, params.dateStart, params.dateEnd, params.onProgress)).catch((err) => {
      errors.push(`Drive pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return { files: 0 };
    }),
    (params.includeLocal === false ? Promise.resolve({ files: 0 }) : pullFromLocalFolders(params.caseId, params.userId, params.keywords, matchMode, localFolderPaths, errors, params.dateStart, params.dateEnd, params.onProgress)).catch((err) => {
      errors.push(`Local pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return { files: 0 };
    }),
  ]);

  // Log this run.
  try {
    await db.insert(autoCollectionLogs).values({
      id: uuidv4(),
      caseId: params.caseId,
      settingsId: settings?.id || null,
      userId: params.userId,
      runStartedAt: new Date(),
      runCompletedAt: new Date(),
      status: errors.length === 0 ? 'completed' : 'completed_with_errors',
      emailsFound: String(gmail.messages),
      emailsProcessed: String(gmail.messages),
      filesFound: String(drive.files + local.files + gmail.attachments),
      filesDownloaded: String(drive.files + local.files + gmail.attachments),
      errorCount: String(errors.length),
      errorMessage: errors.slice(0, 3).join('; ') || null,
      executionTimeSeconds: '0',
    });
  } catch (err) {
    console.warn('[AutoCollection] Failed to log one-shot run:', err);
  }

  return {
    gmailMessages: gmail.messages,
    gmailAttachments: gmail.attachments,
    driveFiles: drive.files,
    localFiles: local.files,
    errors,
  };
}

type KeywordPullJobParams = Omit<Parameters<typeof pullEvidenceByKeywords>[0], 'onProgress'>;
const runningKeywordPullJobIds = new Set<string>();

export async function startKeywordPullJob(params: KeywordPullJobParams) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const recent = await db
    .select()
    .from(keywordPullJobs)
    .where(and(eq(keywordPullJobs.caseId, params.caseId), eq(keywordPullJobs.userId, params.userId)))
    .orderBy(desc(keywordPullJobs.createdAt))
    .limit(10);
  const active = recent.find((job) => job.status === 'queued' || job.status === 'running');
  if (active && runningKeywordPullJobIds.has(active.id)) return active;
  if (active) {
    await db.update(keywordPullJobs).set({
      status: 'failed',
      message: 'Pull interrupted before completion',
      error: 'The application stopped while this pull was active. Start it again to retry safely.',
      completedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(keywordPullJobs.id, active.id));
  }

  const now = new Date();
  const id = uuidv4();
  await db.insert(keywordPullJobs).values({
    id,
    caseId: params.caseId,
    userId: params.userId,
    status: 'queued',
    phase: 'queued',
    message: 'Waiting to start',
    processedWords: 0,
    totalWords: 0,
    processedItems: 0,
    totalItems: 0,
    createdAt: now,
    updatedAt: now,
  });

  runningKeywordPullJobIds.add(id);
  setImmediate(() => {
    void executeKeywordPullJob(id, params);
  });

  const [job] = await db.select().from(keywordPullJobs).where(eq(keywordPullJobs.id, id)).limit(1);
  return job;
}

async function executeKeywordPullJob(id: string, params: KeywordPullJobParams): Promise<void> {
  const db = await getDb();
  if (!db) {
    runningKeywordPullJobIds.delete(id);
    return;
  }
  const startedAt = new Date();
  const state = {
    processedWords: 0,
    totalWords: 0,
    processedItems: 0,
    totalItems: 0,
    phase: 'discovering' as PullProgressPhase,
    message: 'Checking connected evidence sources',
  };
  let writeChain = Promise.resolve();

  const persistProgress = () => {
    const elapsedSeconds = Math.max(1, (Date.now() - startedAt.getTime()) / 1000);
    const remainingWords = Math.max(0, state.totalWords - state.processedWords);
    const remainingItems = Math.max(0, state.totalItems - state.processedItems);
    const wordRate = state.processedWords / elapsedSeconds;
    const itemRate = state.processedItems / elapsedSeconds;
    const estimatedSecondsRemaining = remainingWords > 0 && wordRate > 0
      ? Math.ceil(remainingWords / wordRate)
      : remainingItems > 0 && itemRate > 0
        ? Math.ceil(remainingItems / itemRate)
        : null;
    const snapshot = { ...state, estimatedSecondsRemaining, updatedAt: new Date() };
    writeChain = writeChain
      .then(async () => {
        await db.update(keywordPullJobs).set(snapshot).where(eq(keywordPullJobs.id, id));
      })
      .catch((error) => {
        console.warn('[KeywordPull] Failed to persist progress:', error);
      });
  };

  await db.update(keywordPullJobs).set({
    status: 'running',
    phase: state.phase,
    message: state.message,
    startedAt,
    updatedAt: startedAt,
  }).where(eq(keywordPullJobs.id, id));

  const onProgress: PullProgressReporter = (update) => {
    state.phase = update.phase;
    state.message = update.message;
    state.processedWords += update.processedWordsDelta ?? 0;
    state.totalWords += update.totalWordsDelta ?? 0;
    state.processedItems += update.processedItemsDelta ?? 0;
    state.totalItems += update.totalItemsDelta ?? 0;
    persistProgress();
  };

  try {
    const result = await pullEvidenceByKeywords({ ...params, onProgress });
    onProgress({ phase: 'finalizing', message: 'Updating the case evidence index' });
    await writeChain;
    const completedAt = new Date();
    await db.update(keywordPullJobs).set({
      status: result.errors.length > 0 ? 'completed_with_errors' : 'completed',
      phase: 'finalizing',
      message: result.errors.length > 0 ? 'Pull completed with source warnings' : 'Pull complete',
      processedWords: Math.max(state.processedWords, state.totalWords),
      totalWords: Math.max(state.processedWords, state.totalWords),
      processedItems: Math.max(state.processedItems, state.totalItems),
      totalItems: Math.max(state.processedItems, state.totalItems),
      estimatedSecondsRemaining: 0,
      result: JSON.stringify(result),
      completedAt,
      updatedAt: completedAt,
    }).where(eq(keywordPullJobs.id, id));
  } catch (error) {
    await writeChain;
    const completedAt = new Date();
    await db.update(keywordPullJobs).set({
      status: 'failed',
      message: 'Pull failed',
      error: error instanceof Error ? error.message : String(error),
      estimatedSecondsRemaining: null,
      completedAt,
      updatedAt: completedAt,
    }).where(eq(keywordPullJobs.id, id));
  } finally {
    runningKeywordPullJobIds.delete(id);
  }
}

export async function getKeywordPullJob(id: string, userId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [job] = await db
    .select()
    .from(keywordPullJobs)
    .where(and(eq(keywordPullJobs.id, id), eq(keywordPullJobs.userId, userId)))
    .limit(1);
  return job ?? null;
}

export async function getActiveKeywordPullJob(caseId: string, userId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const rows = await db
    .select()
    .from(keywordPullJobs)
    .where(and(eq(keywordPullJobs.caseId, caseId), eq(keywordPullJobs.userId, userId)))
    .orderBy(desc(keywordPullJobs.createdAt))
    .limit(10);
  const active = rows.find((job) => job.status === 'queued' || job.status === 'running');
  if (!active) return null;
  if (runningKeywordPullJobIds.has(active.id)) return active;

  const completedAt = new Date();
  const interrupted = {
    ...active,
    status: 'failed',
    message: 'Pull interrupted before completion',
    error: 'The application stopped while this pull was active. Start it again to retry safely.',
    completedAt,
    updatedAt: completedAt,
  };
  await db.update(keywordPullJobs).set({
    status: interrupted.status,
    message: interrupted.message,
    error: interrupted.error,
    completedAt,
    updatedAt: completedAt,
  }).where(eq(keywordPullJobs.id, active.id));
  return interrupted;
}

export async function runAutoCollection(caseId: string): Promise<{
  emailsFound: number;
  emailsProcessed: number;
  filesFound: number;
  filesDownloaded: number;
  errors: string[];
}> {
  const settings = await getAutoCollectionSettings(caseId);
  if (!settings?.userId) throw new Error('Auto-collection settings not found for case');
  const keywords = JSON.parse(settings.keywords || '[]') as string[];
  const accountIds = JSON.parse(settings.emailAccountIds || '[]') as string[];
  const driveFolderIds = JSON.parse(settings.googleDriveFolderIds || '[]') as string[];
  const driveAccountId = (() => {
    try {
      const metadata = settings.metadata ? JSON.parse(settings.metadata) : {};
      return typeof metadata.googleDriveAccountId === 'string' ? metadata.googleDriveAccountId : undefined;
    } catch {
      return undefined;
    }
  })();
  const result = await pullEvidenceByKeywords({
    caseId,
    userId: settings.userId,
    keywords,
    matchMode: settings.keywordMatchMode === 'all' ? 'all' : 'any',
    gmailAccountIds: accountIds,
    driveAccountId,
    driveFolderIds,
    dateStart: settings.dateRangeStart || undefined,
    dateEnd: settings.dateRangeEnd || undefined,
    includeGmail: accountIds.length > 0,
    includeGmailAttachments: Boolean(settings.autoDownloadAttachments),
    includeDrive: Boolean(settings.autoDownloadGoogleDriveFiles),
    includeLocal: true,
  });
  const files = result.gmailAttachments + result.driveFiles + result.localFiles;
  const db = await getDb();
  await db.update(autoCollectionSettings).set({
    lastRunAt: new Date(),
    totalItemsCollected: String(result.gmailMessages + files),
    totalEmailsCollected: String(result.gmailMessages),
    totalFilesCollected: String(files),
  }).where(eq(autoCollectionSettings.caseId, caseId));
  return {
    emailsFound: result.gmailMessages,
    emailsProcessed: result.gmailMessages,
    filesFound: files,
    filesDownloaded: files,
    errors: result.errors,
  };
}

/**
 * Save the list of local folder paths a case wants auto-scanned. Stored in
 * the existing `autoCollectionSettings.metadata` text column.
 */
export async function setLocalFolderPaths(caseId: string, userId: string, paths: string[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const validatedPaths = await Promise.all(paths.map((folderPath) => resolveAllowedLocalFolder(folderPath)));

  const existing = await getAutoCollectionSettings(caseId);
  const meta = existing?.metadata
    ? (() => {
        try {
          return JSON.parse(existing.metadata);
        } catch {
          return {};
        }
      })()
    : {};
  meta.localFolderPaths = Array.from(new Set(validatedPaths));

  if (existing) {
    await db
      .update(autoCollectionSettings)
      .set({ metadata: JSON.stringify(meta) })
      .where(eq(autoCollectionSettings.caseId, caseId));
  } else {
    await db.insert(autoCollectionSettings).values({
      id: uuidv4(),
      caseId,
      userId,
      keywords: JSON.stringify([]),
      keywordMatchMode: 'any',
      emailAccountIds: JSON.stringify([]),
      autoDownloadAttachments: true,
      autoDownloadGoogleDriveFiles: true,
      isEnabled: true,
      status: 'active',
      metadata: JSON.stringify(meta),
    });
  }
}

export async function getLocalFolderPaths(caseId: string): Promise<string[]> {
  return getConfiguredLocalFolders(caseId);
}
