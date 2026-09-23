import { getDb } from './db';
import { eq, and, desc } from 'drizzle-orm';
import { notifyOwner } from './notification';
import {
  autoCollectionSettings,
  keywordPullJobs,
  emailAccounts,
  evidence as evidenceTable,
  cases as casesTable,
} from './schema';
import { v4 as uuidv4 } from 'uuid';
import { google } from 'googleapis';
import {
  downloadAndUploadGoogleDriveFile,
  findGoogleDriveFilesByExactName,
  getAllFilesInFolder,
  googleDriveProviderRevision,
} from './googleDriveService';
import { getProviderAccessToken, listProviderConnections } from './providerConnections';
import { getGmailMessage, getGmailAttachmentBytes } from './gmailService';
import { searchGmailMessageIds } from './gmailMessageSearch';
import { getLocalStorageDirectory, storageDelete, storagePut, storagePutStream } from './storage';
import { createEvidenceFile } from './evidence';
import { analyzeStoredEvidence } from './documentAnalysisService';
import { supportsDocumentAnalysisMime } from './documentIntelligence';
import { getWorkflowPreferences } from './workflowPreferences';
import { getStoredGmailEvidenceState, resolveGmailAccountIds } from './gmailCollectionPolicy';
import { emitRealtimeDataChange } from './realtime';
import { linkInboundOutreachReply } from './inboundOutreach';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import { withByteReadAdmission } from './boundedBytes';
import { MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';
import { googleDriveSourcesSchema, savedGoogleDriveSources, type GoogleDriveSource } from '../shared/googleDriveSources';
import {
  EvidenceIngestionBudget,
  EvidenceIngestionLimitError,
} from './evidenceIngestionBudget';
import type {
  EvidenceIngestionSource,
  EvidenceIngestionSummary,
} from '../shared/evidenceIngestion';
import { EVIDENCE_INGESTION_LIMITS } from '../shared/evidenceIngestion';

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
  googleDriveSources?: GoogleDriveSource[];
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
  autoAnalyzeImports?: boolean,
  budget?: EvidenceIngestionBudget,
  source: EvidenceIngestionSource = 'manual',
): Promise<number> {
  if (!supportsDocumentAnalysisMime(mimeType)) return 0;
  try {
    if (autoAnalyzeImports === false) return 0;
    if (autoAnalyzeImports === undefined && !(await getWorkflowPreferences(userId)).autoAnalyzeImports) return 0;
    if (budget && !budget.claimAnalysis(source)) {
      errors.push(`Analysis deferred for ${source}: the ingestion analysis limit was reached`);
      return 0;
    }
    const analysis = await analyzeStoredEvidence({ userId, evidenceId });
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
  if (config.googleDriveSources !== undefined) {
    metadata.googleDriveSources = googleDriveSourcesSchema.parse(config.googleDriveSources);
    delete metadata.googleDriveAccountId;
  } else {
    delete metadata.googleDriveSources;
  }

  const settingsData = {
    caseId: config.caseId,
    userId: config.userId,
    keywords: JSON.stringify(config.keywords),
    keywordMatchMode: config.keywordMatchMode,
    dateRangeStart: config.dateRangeStart,
    dateRangeEnd: config.dateRangeEnd,
    emailAccountIds: JSON.stringify(config.emailAccountIds),
    metadata: JSON.stringify(metadata),
    googleDriveFolderIds: config.googleDriveSources !== undefined ? null : config.googleDriveFolderIds ? JSON.stringify(config.googleDriveFolderIds) : null,
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
  outcome?: EvidenceIngestionSummary['outcome'];
  ingestion?: EvidenceIngestionSummary;
  monitoring: KeywordPullMonitoring;
}

export const KEYWORD_PULL_SOURCES = ['gmail', 'google_drive', 'local'] as const;
export type KeywordPullSource = typeof KEYWORD_PULL_SOURCES[number];
export type KeywordPullCompleteness =
  | 'queued'
  | 'running'
  | 'complete'
  | 'complete_zero'
  | 'partial'
  | 'limited'
  | 'interrupted'
  | 'cancelled'
  | 'failed';

export interface KeywordPullSourceSummary {
  source: KeywordPullSource;
  status: 'queued' | 'running' | 'completed' | 'partial' | 'limited' | 'cancelled' | 'failed';
  processedItems: number;
  storedItems: number;
  skippedItems: number;
  matchedKeywords: string[];
  errors: string[];
}

export interface KeywordPullRevision {
  evidenceId: string;
  source: string;
  title: string;
  sourceIdentity: string | null;
  contentRevision: string | null;
  revisionNumber: number | null;
  matchedKeywords: string[];
  matchReason: string;
}

export interface KeywordPullMonitoring {
  schemaVersion: 1;
  requestedKeywords: string[];
  matchedKeywords: string[];
  matchMode: 'all' | 'any';
  requestedSources: KeywordPullSource[];
  completedSources: KeywordPullSource[];
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  completeness: KeywordPullCompleteness;
  processedItems: number;
  storedItems: number;
  skippedItems: number;
  processedBytes: number;
  matchReasons: string[];
  sources: KeywordPullSourceSummary[];
  revisions: KeywordPullRevision[];
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

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function matchingKeywords(text: string, keywords: string[]): string[] {
  const normalized = text.toLocaleLowerCase();
  return uniqueStrings(keywords.filter((keyword) => normalized.includes(keyword.toLocaleLowerCase())));
}

function requestedPullSources(params: {
  includeGmail?: boolean;
  includeDrive?: boolean;
  includeLocal?: boolean;
}): KeywordPullSource[] {
  return KEYWORD_PULL_SOURCES.filter((source) => source === 'gmail'
    ? params.includeGmail !== false
    : source === 'google_drive'
      ? params.includeDrive !== false
      : params.includeLocal !== false);
}

function ingestionSourceGroup(source: EvidenceIngestionSource): KeywordPullSource | null {
  if (source === 'gmail_message' || source === 'gmail_attachment') return 'gmail';
  if (source === 'google_drive') return 'google_drive';
  if (source === 'local') return 'local';
  return null;
}

function initialKeywordPullMonitoring(
  params: {
    keywords: string[];
    matchMode?: 'all' | 'any';
    includeGmail?: boolean;
    includeDrive?: boolean;
    includeLocal?: boolean;
  },
  completeness: 'queued' | 'running' = 'queued',
  startedAt: Date | null = null,
): KeywordPullMonitoring {
  const requestedSources = requestedPullSources(params);
  return {
    schemaVersion: 1,
    requestedKeywords: uniqueStrings(params.keywords),
    matchedKeywords: [],
    matchMode: params.matchMode || 'any',
    requestedSources,
    completedSources: [],
    startedAt: startedAt?.toISOString() ?? null,
    completedAt: null,
    durationMs: null,
    completeness,
    processedItems: 0,
    storedItems: 0,
    skippedItems: 0,
    processedBytes: 0,
    matchReasons: [],
    sources: requestedSources.map((source) => ({
      source,
      status: completeness,
      processedItems: 0,
      storedItems: 0,
      skippedItems: 0,
      matchedKeywords: [],
      errors: [],
    })),
    revisions: [],
  };
}

class KeywordPullTracker {
  readonly revisions: KeywordPullRevision[] = [];
  readonly matchedKeywords = new Set<string>();
  readonly matchReasons = new Set<string>();

  observe(keywords: string[], reason: string): void {
    keywords.forEach((keyword) => this.matchedKeywords.add(keyword));
    if (reason.trim()) this.matchReasons.add(reason.trim());
  }

  revision(value: KeywordPullRevision): void {
    this.revisions.push(value);
    this.observe(value.matchedKeywords, value.matchReason);
  }
}

function countWords(value: string): number {
  return value.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/**
 * Read & decrypt a Gmail access token for the user, refreshing if expired.
 * Returns null when the user has no connected Gmail account.
 */
async function getFreshGmailAccessToken(userId: string, accountId?: string): Promise<{ accessToken: string; accountId: string; email: string } | null> {
  const rows = (await listProviderConnections(userId, 'gmail'))
    .filter((account) => account.status === 'connected' && (!accountId || account.id === accountId));

  if (!accountId && rows.length > 1) {
    throw new Error('Multiple Google accounts are connected. Select the account to use.');
  }
  const account = rows[0];
  if (!account) return null;
  const accessToken = await getProviderAccessToken({
    userId,
    accountId: account.id,
    provider: 'gmail',
  });
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
  autoAnalyzeImports?: boolean,
  budget: EvidenceIngestionBudget = new EvidenceIngestionBudget(),
  collectionRunId?: string,
  tracker?: KeywordPullTracker,
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
        autoAnalyzeImports,
        budget,
        collectionRunId,
        tracker,
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
  if (!budget.hasCapacity()) {
    budget.recordCapacityLimit('gmail_message');
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

  const search = await searchGmailMessageIds(
    cred.accessToken, query, budget.remainingItems(), budget.signal,
  );
  const threads = search.messages;
  errors.push(...search.warnings);

  let messagesIngested = 0;
  let attachmentsIngested = 0;
  onProgress?.({
    phase: 'gmail',
    message: `Reviewing ${threads.length} Gmail message${threads.length === 1 ? '' : 's'}`,
    totalItemsDelta: threads.length,
    totalWordsDelta: threads.length,
  });

  for (const t of threads) {
    if (budget.signal?.aborted) break;
    if (!budget.hasCapacity()) {
      budget.recordCapacityLimit('gmail_message');
      break;
    }
    let messageWords = 1;
    try {
      const msg = await getGmailMessage(cred.accessToken, t.id, budget.signal);
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
      if (storedState.messageStored) budget.recordSkip('gmail_message', 'duplicate');

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
      try {
        await linkInboundOutreachReply({
          userId,
          caseId,
          message: {
            gmailMessageId: msg.id,
            gmailThreadId: (msg as any).threadId,
            from,
            subject,
            body,
            receivedAt: date,
            messageId: headers['message-id'],
            inReplyTo: headers['in-reply-to'],
            references: headers.references,
          },
        });
      } catch (error) {
        errors.push(`Reply linking for "${subject}" failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      messageWords = Math.max(1, countWords(`${from} ${subject} ${body}`));
      const messageMatchedKeywords = matchingKeywords(`${from} ${subject} ${body}`, keywords);
      const messageMatchReason = messageMatchedKeywords.length > 0
        ? 'Gmail message content matched the persisted pull keywords.'
        : 'Gmail returned this message for the persisted keyword query.';
      tracker?.observe(messageMatchedKeywords, messageMatchReason);
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
        const messageBytes = Buffer.from(messageSource);
        const reservation = await budget.reserve('gmail_message', messageBytes.length);
        if (reservation) {
          const messageStorageKey = `evidence/${caseId}/gmail/${uuidv4()}-${msg.id}.eml`;
          const storedMessageRef: { value: Awaited<ReturnType<typeof storagePut>> | null } = { value: null };
          try {
            await reservation.run(async () => {
              const storedMessage = await storagePut(messageStorageKey, messageBytes, 'message/rfc822');
              storedMessageRef.value = storedMessage;
              const messageEvidenceId = await createEvidenceFile(userId, {
                caseId,
                type: 'email',
                source: 'gmail',
                title: subject,
                description: `From ${from} on ${date.toISOString()}`,
                fileUrl: storedMessage.url,
                fileName: `${msg.id}.eml`,
                fileSize: String(messageBytes.length),
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
                  sourceIdentity: JSON.stringify(['gmail', cred.accountId, msg.id]),
                  sourceRevision: String((msg as any).historyId || msg.internalDate || storedMessage.sha256),
                  revisionNumber: 1,
                  keywordPullJobId: collectionRunId,
                  matchedKeywords: messageMatchedKeywords,
                  matchReason: messageMatchReason,
                  autoCollected: true,
                  collectedAt: new Date().toISOString(),
                }),
                contentHash: storedMessage.sha256,
                relevant: true,
              });
              await analyzeImportedEvidence(
                messageEvidenceId, userId, 'message/rfc822', subject, errors,
                autoAnalyzeImports, budget, 'gmail_message',
              );
              tracker?.revision({
                evidenceId: messageEvidenceId,
                source: 'gmail',
                title: subject,
                sourceIdentity: JSON.stringify(['gmail', cred.accountId, msg.id]),
                contentRevision: String((msg as any).historyId || msg.internalDate || storedMessage.sha256),
                revisionNumber: 1,
                matchedKeywords: messageMatchedKeywords,
                matchReason: messageMatchReason,
              });
            });
            reservation.complete(messageBytes.length);
            messagesIngested++;
          } catch (error) {
            reservation.skip(error instanceof EvidenceIngestionLimitError ? error.code : 'store_failed');
            if (storedMessageRef.value) await storageDelete(storedMessageRef.value.key).catch(() => undefined);
            throw error;
          }
        }
      }

      // Download attachments.
      const attachments: { partId: string; filename: string; mimeType: string; attachmentId: string; size?: number }[] = [];
      const collectAttachments = (payload: any) => {
        if (!payload) return;
        if (payload.filename && payload.body?.attachmentId) {
          attachments.push({
            partId: payload.partId,
            filename: payload.filename,
            mimeType: payload.mimeType || 'application/octet-stream',
            attachmentId: payload.body.attachmentId,
            size: payload.body.size,
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
        if (budget.signal?.aborted) break;
        if (!budget.hasCapacity()) {
          budget.recordCapacityLimit('gmail_attachment');
          break;
        }
        let attachmentWords = 0;
        tracker?.observe(messageMatchedKeywords, 'Attachment from a Gmail message returned by the persisted keyword query.');
        try {
          if (storedState.attachmentIds.has(att.attachmentId)) {
            budget.recordSkip('gmail_attachment', 'duplicate');
            continue;
          }
          if (typeof att.size === 'number' && att.size > MAX_EVIDENCE_FILE_BYTES) {
            budget.recordSkip('gmail_attachment', 'file_too_large');
            throw new Error('Gmail attachment exceeds the 7 MB evidence limit');
          }
          const reservation = await budget.reserve('gmail_attachment', att.size);
          if (!reservation) continue;
          const storedAttachmentRef: { value: Awaited<ReturnType<typeof storagePut>> | null } = { value: null };
          try {
            await reservation.run(async () => {
              const buf = await getGmailAttachmentBytes(
                cred.accessToken, msg.id, att.attachmentId, budget.signal,
              );
              if (!buf) throw new Error('Gmail attachment returned no bytes');
              reservation.validateActualBytes(buf.length);
              const safeName = path.basename(att.filename.replace(/\\/g, '/')) || 'attachment';
              const storageKey = `evidence/${caseId}/gmail/${uuidv4()}-${safeName}`;
              const storedAttachment = await storagePut(storageKey, buf, att.mimeType);
              storedAttachmentRef.value = storedAttachment;
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
                  sourceIdentity: JSON.stringify(['gmail_attachment', cred.accountId, msg.id, att.attachmentId]),
                  sourceRevision: att.attachmentId,
                  revisionNumber: 1,
                  keywordPullJobId: collectionRunId,
                  matchedKeywords: messageMatchedKeywords,
                  matchReason: 'Attachment from a Gmail message returned by the persisted keyword query.',
                  autoCollected: true,
                  collectedAt: new Date().toISOString(),
                }),
                contentHash: storedAttachment.sha256,
                relevant: true,
              });
              attachmentWords = await analyzeImportedEvidence(
                attachmentEvidenceId, userId, att.mimeType, safeName, errors,
                autoAnalyzeImports, budget, 'gmail_attachment',
              );
              tracker?.revision({
                evidenceId: attachmentEvidenceId,
                source: 'gmail',
                title: safeName,
                sourceIdentity: JSON.stringify(['gmail_attachment', cred.accountId, msg.id, att.attachmentId]),
                contentRevision: att.attachmentId,
                revisionNumber: 1,
                matchedKeywords: messageMatchedKeywords,
                matchReason: 'Attachment from a Gmail message returned by the persisted keyword query.',
              });
              reservation.complete(buf.length);
            });
            storedState.attachmentIds.add(att.attachmentId);
            attachmentsIngested++;
          } catch (error) {
            reservation.skip(error instanceof EvidenceIngestionLimitError ? error.code : 'store_failed');
            if (storedAttachmentRef.value) await storageDelete(storedAttachmentRef.value.key).catch(() => undefined);
            throw error;
          }
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
interface StoredDriveRevision {
  id: string;
  sourceRevision: string | null;
  revisionNumber: number;
}

function driveSourceIdentity(accountId: string, fileId: string): string {
  return JSON.stringify(['google_drive', accountId, fileId]);
}

function readMetadataObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function pullFromDrive(
  caseId: string,
  userId: string,
  keywords: string[],
  matchMode: 'all' | 'any',
  folderIds: string[],
  errors: string[],
  accountId?: string,
  exactFileName?: string,
  dateStart?: Date,
  dateEnd?: Date,
  onProgress?: PullProgressReporter,
  autoAnalyzeImports?: boolean,
  budget: EvidenceIngestionBudget = new EvidenceIngestionBudget(),
  collectionRunId?: string,
  tracker?: KeywordPullTracker,
): Promise<{ files: number }> {
  const db = await getDb();
  if (!db) return { files: 0 };

  // Verify the user has Drive access via Gmail OAuth.
  const cred = await getFreshGmailAccessToken(userId, accountId);
  if (!cred) return { files: 0 };

  const normalizedExactFileName = exactFileName?.trim().toLowerCase();
  const folders = normalizedExactFileName
    ? ['exact-name-query']
    : folderIds.length > 0 ? folderIds : ['root'];
  let downloaded = 0;

  // Canonical evidence is the only Drive ingestion store. Load its version
  // state once so every candidate avoids a per-file full-table scan.
  const existingEvidence = await db
    .select({ id: evidenceTable.id, metadata: evidenceTable.metadata })
    .from(evidenceTable)
    .where(and(
      eq(evidenceTable.caseId, caseId),
      eq(evidenceTable.userId, userId),
      eq(evidenceTable.source, 'google_drive'),
    ));
  const storedByIdentity = new Map<string, StoredDriveRevision[]>();
  for (const row of existingEvidence) {
    const metadata = readMetadataObject(row.metadata);
    const driveFileId = typeof metadata.driveFileId === 'string' ? metadata.driveFileId : null;
    const driveAccountId = typeof metadata.driveAccountId === 'string' ? metadata.driveAccountId : null;
    if (!driveFileId || driveAccountId !== cred.accountId) continue;
    const identity = driveSourceIdentity(driveAccountId, driveFileId);
    const revisions = storedByIdentity.get(identity) ?? [];
    revisions.push({
      id: row.id,
      sourceRevision: typeof metadata.sourceRevision === 'string' ? metadata.sourceRevision : null,
      revisionNumber: Number.isSafeInteger(metadata.revisionNumber) && Number(metadata.revisionNumber) > 0
        ? Number(metadata.revisionNumber)
        : 1,
    });
    storedByIdentity.set(identity, revisions);
  }

  for (const folderId of folders) {
    try {
      const files = normalizedExactFileName
        ? await findGoogleDriveFilesByExactName(userId, exactFileName!, cred.accountId)
        : await getAllFilesInFolder(userId, folderId, true, cred.accountId);
      const candidates = files.filter((file) => {
        if (!file.name || !file.id) return false;
        if (normalizedExactFileName) {
          if (file.name.trim().toLowerCase() !== normalizedExactFileName) return false;
        } else if (!matchesKeywords(file.name, keywords, matchMode)) {
          return false;
        }
        const modified = (file as any).modifiedTime ? new Date((file as any).modifiedTime) : null;
        if (dateStart && modified && modified < dateStart) return false;
        if (dateEnd && modified && modified > dateEnd) return false;
        return true;
      });
      if (normalizedExactFileName && candidates.length !== 1) {
        errors.push(`Drive exact-name selection matched ${candidates.length} files; expected exactly one`);
        continue;
      }
      onProgress?.({
        phase: 'drive',
        message: `Reviewing ${candidates.length} matching Drive file${candidates.length === 1 ? '' : 's'}`,
        totalItemsDelta: candidates.length,
      });
      for (const file of candidates) {
        if (budget.signal?.aborted) break;
        if (!budget.hasCapacity()) {
          budget.recordCapacityLimit('google_drive');
          break;
        }
        if (!file.name || !file.id) continue;
        const fileMatchedKeywords = matchingKeywords(file.name, keywords);
        const fileMatchReason = normalizedExactFileName
          ? 'Google Drive file was selected by an exact-name pull.'
          : 'Google Drive filename matched the persisted pull keywords.';
        tracker?.observe(fileMatchedKeywords, fileMatchReason);
        let fileWords = 0;
        try {
          const sourceIdentity = driveSourceIdentity(cred.accountId, file.id);
          const priorVersions = storedByIdentity.get(sourceIdentity) ?? [];
          const listedRevision = googleDriveProviderRevision(file);
          if (listedRevision && priorVersions.some((version) => version.sourceRevision === listedRevision)) {
            budget.recordSkip('google_drive', 'duplicate');
            continue;
          }

          const fileData = await downloadAndUploadGoogleDriveFile(
            file.id, caseId, userId, cred.accountId, { budget, signal: budget.signal },
          );
          const sourceRevision = fileData.providerRevision ?? listedRevision;
          if (sourceRevision && priorVersions.some((version) => version.sourceRevision === sourceRevision)) {
            await storageDelete(fileData.key).catch(() => undefined);
            budget.recordSkip('google_drive', 'duplicate');
            continue;
          }
          await budget.run(async () => {
            let evidenceId: string;
            const previousVersionIds = priorVersions.map((version) => version.id);
            const revisionNumber = priorVersions.reduce(
              (highest, version) => Math.max(highest, version.revisionNumber),
              0,
            ) + 1;
            try {
              evidenceId = await createEvidenceFile(userId, {
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
                sourceIdentity,
                sourceRevision,
                revisionNumber,
                isCurrent: true,
                previousVersionIds,
                folderId,
                sourceMimeType: fileData.sourceMimeType,
                providerVersion: fileData.providerVersion,
                md5Checksum: fileData.md5Checksum,
                keywordPullJobId: collectionRunId,
                matchedKeywords: fileMatchedKeywords,
                matchReason: fileMatchReason,
                autoCollected: true,
                collectedAt: new Date().toISOString(),
                modifiedTime: fileData.modifiedTime,
              }),
              contentHash: fileData.sha256,
              relevant: true,
              });
            } catch (error) {
              await storageDelete(fileData.key).catch(() => undefined);
              throw error;
            }
            fileWords = await analyzeImportedEvidence(
              evidenceId, userId, fileData.mimeType, file.name, errors,
              autoAnalyzeImports, budget, 'google_drive',
            );
            tracker?.revision({
              evidenceId,
              source: 'google_drive',
              title: file.name,
              sourceIdentity,
              contentRevision: sourceRevision,
              revisionNumber,
              matchedKeywords: fileMatchedKeywords,
              matchReason: fileMatchReason,
            });
            storedByIdentity.set(sourceIdentity, [...priorVersions, {
              id: evidenceId,
              sourceRevision,
              revisionNumber,
            }]);
            downloaded++;
          });
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
  maxFiles = EVIDENCE_INGESTION_LIMITS.maxJobItems,
  maxDepth = 6,
): Promise<{ absPath: string; name: string }[]> {
  const matches: { absPath: string; name: string }[] = [];
  const storageDirectory = await fs.realpath(getLocalStorageDirectory()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return getLocalStorageDirectory();
    throw error;
  });
  const within = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  };
  if (within(rootPath, storageDirectory)) {
    errors.push('Local folder rejected: LARO managed evidence storage is not an import source');
    return matches;
  }
  let fileLimitReached = false;
  let depthLimitReached = false;

  async function walk(dir: string, depth: number) {
    if (within(dir, storageDirectory)) return;
    if (matches.length >= maxFiles) { fileLimitReached = true; return; }
    if (depth > maxDepth) { depthLimitReached = true; return; }
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      errors.push(`Cannot read directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxFiles) { fileLimitReached = true; return; }
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
  if (fileLimitReached) errors.push(`Partial local scan: file limit of ${maxFiles} reached in ${rootPath}; select smaller source folders to collect the remainder`);
  if (depthLimitReached) errors.push(`Partial local scan: depth limit of ${maxDepth} reached in ${rootPath}; select deeper source folders to collect the remainder`);
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
  autoAnalyzeImports?: boolean,
  budget: EvidenceIngestionBudget = new EvidenceIngestionBudget(),
  collectionRunId?: string,
  tracker?: KeywordPullTracker,
): Promise<{ files: number }> {
  const db = await getDb();
  if (!db) return { files: 0 };
  if (!folderPaths.length) return { files: 0 };

  let ingested = 0;
  const existingLocalEvidence = await db
    .select({ id: evidenceTable.id, metadata: evidenceTable.metadata })
    .from(evidenceTable)
    .where(and(eq(evidenceTable.caseId, caseId), eq(evidenceTable.userId, userId), eq(evidenceTable.source, 'local')));
  const pathKey = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const storedLocalVersions = new Map<string, Array<{ id: string; hash: string | null }>>();
  for (const item of existingLocalEvidence) {
    try {
      const metadata = item.metadata ? JSON.parse(item.metadata) : {};
      if (typeof metadata.absPath === 'string' && metadata.absPath) {
        const key = pathKey(metadata.absPath);
        const versions = storedLocalVersions.get(key) || [];
        versions.push({ id: item.id, hash: typeof metadata.contentHash === 'string' ? metadata.contentHash : null });
        storedLocalVersions.set(key, versions);
      }
    } catch {
      // Invalid legacy metadata cannot safely participate in deduplication.
    }
  }

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
      if (budget.signal?.aborted) break;
      if (!budget.hasCapacity()) {
        budget.recordCapacityLimit('local');
        break;
      }
      const fileMatchedKeywords = matchingKeywords(file.name, keywords);
      const fileMatchReason = 'Local filename matched the persisted pull keywords.';
      tracker?.observe(fileMatchedKeywords, fileMatchReason);
      let fileWords = 0;
      try {
        const stat = await fs.stat(file.absPath);
        if (dateStart && stat.mtime < dateStart) continue;
        if (dateEnd && stat.mtime > dateEnd) continue;
        if (stat.size > MAX_EVIDENCE_FILE_BYTES) {
          budget.recordSkip('local', 'file_too_large');
          throw new Error('Local evidence file exceeds the 7 MB evidence limit');
        }
        const reservation = await budget.reserve('local', stat.size);
        if (!reservation) continue;
        // A source path can change; preserve each distinct byte version instead
        // of treating the filename as permanent proof that the file is imported.
        const key = pathKey(file.absPath);
        const versions = storedLocalVersions.get(key) || [];
        const ext = path.extname(file.name).toLowerCase();
        const mimeType = guessMimeFromExt(ext);
        const storageKey = `evidence/${caseId}/local/${uuidv4()}-${file.name}`;
        const storedFileRef: { value: Awaited<ReturnType<typeof storagePutStream>> | null } = { value: null };
        try {
          await reservation.run(async () => {
            const storedFile = await withByteReadAdmission(() => storagePutStream(
              storageKey,
              createReadStream(file.absPath),
              mimeType,
              { maxBytes: reservation.declaredBytes, expectedBytes: stat.size, signal: budget.signal },
            ));
            storedFileRef.value = storedFile;
            if (versions.some((version) => version.hash === storedFile!.sha256)) {
              await storageDelete(storedFile.key);
              storedFileRef.value = null;
              reservation.skip('duplicate');
              return;
            }
            const evidenceId = await createEvidenceFile(userId, {
              caseId,
              type: determineEvidenceType(mimeType),
              source: 'local',
              title: file.name,
              description: `Auto-collected from local folder ${path.basename(resolvedFolderPath) || "selected folder"}`,
              fileUrl: storedFile.url,
              fileName: file.name,
              fileSize: String(storedFile.bytes),
              mimeType,
              metadata: JSON.stringify({
                storageKey: storedFile.key,
                absPath: file.absPath,
                sourceFolder: resolvedFolderPath,
                sourceFolderLabel: path.basename(resolvedFolderPath) || "selected folder",
                autoCollected: true,
                collectedAt: new Date().toISOString(),
                modifiedTime: stat.mtime.toISOString(),
                previousVersionIds: versions.map((version) => version.id),
                sourceIdentity: JSON.stringify(['local', key]),
                sourceRevision: storedFile.sha256,
                revisionNumber: versions.length + 1,
                keywordPullJobId: collectionRunId,
                matchedKeywords: fileMatchedKeywords,
                matchReason: fileMatchReason,
              }),
              contentHash: storedFile.sha256,
              relevant: true,
            });
            fileWords = await analyzeImportedEvidence(
              evidenceId, userId, mimeType, file.name, errors,
              autoAnalyzeImports, budget, 'local',
            );
            tracker?.revision({
              evidenceId,
              source: 'local',
              title: file.name,
              sourceIdentity: JSON.stringify(['local', key]),
              contentRevision: storedFile.sha256,
              revisionNumber: versions.length + 1,
              matchedKeywords: fileMatchedKeywords,
              matchReason: fileMatchReason,
            });
            reservation.complete(storedFile.bytes);
            versions.push({ id: evidenceId, hash: storedFile.sha256 });
            storedLocalVersions.set(key, versions);
          });
          if (storedFileRef.value) ingested++;
        } catch (error) {
          reservation.skip(error instanceof EvidenceIngestionLimitError ? error.code : 'store_failed');
          try { if (storedFileRef.value) await storageDelete(storedFileRef.value.key); }
          catch { errors.push(`Storage cleanup failed for local import "${file.name}"`); }
          throw error;
        }
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
export interface KeywordPullParams {
  caseId: string;
  userId: string;
  keywords: string[];
  matchMode?: 'all' | 'any';
  gmailAccountIds?: string[];
  driveAccountId?: string;
  driveSources?: GoogleDriveSource[];
  driveFolderIds?: string[];
  driveExactFileName?: string;
  localFolderPaths?: string[];
  dateStart?: Date;
  dateEnd?: Date;
  includeGmail?: boolean;
  includeGmailAttachments?: boolean;
  includeDrive?: boolean;
  includeLocal?: boolean;
  onProgress?: PullProgressReporter;
  signal?: AbortSignal;
  ingestionBudget?: EvidenceIngestionBudget;
  collectionRunId?: string;
}

async function performEvidenceByKeywords(
  params: KeywordPullParams & { collectionRunId: string },
): Promise<PullByKeywordsResult> {
  const startedAt = new Date();
  const matchMode = params.matchMode || 'any';
  const gmailErrors: string[] = [];
  const driveErrors: string[] = [];
  const localErrors: string[] = [];
  const tracker = new KeywordPullTracker();
  const ingestionBudget = params.ingestionBudget ?? new EvidenceIngestionBudget(params.signal);

  if (!params.keywords || params.keywords.length === 0) {
    throw new Error('At least one keyword is required');
  }

  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const autoAnalyzeImports = (await getWorkflowPreferences(params.userId)).autoAnalyzeImports;
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

  const driveSources = params.driveSources !== undefined
    ? googleDriveSourcesSchema.parse(params.driveSources)
    : params.driveAccountId !== undefined || params.driveFolderIds !== undefined
      ? undefined
      : savedGoogleDriveSources(settings?.metadata);
  // Validate every selected account before any provider request starts.
  if (params.includeDrive !== false && driveSources) {
    for (const source of driveSources) {
      const [account] = await db.select({ id: emailAccounts.id }).from(emailAccounts).where(and(
        eq(emailAccounts.id, source.accountId), eq(emailAccounts.userId, params.userId),
        eq(emailAccounts.provider, 'gmail'), eq(emailAccounts.status, 'connected'),
      )).limit(1);
      if (!account) throw new Error('Selected Google Drive account is unavailable. Reconnect it or remove it from Sources.');
    }
  }
  const collectDriveSources = async () => {
    let files = 0;
    const sources = driveSources ?? [{ accountId: params.driveAccountId, folderIds: driveFolderIds }];
    for (const source of sources) {
      try {
        const result = await pullFromDrive(params.caseId, params.userId, params.keywords, matchMode,
          source.folderIds, driveErrors, source.accountId, params.driveExactFileName,
          params.dateStart, params.dateEnd, params.onProgress, autoAnalyzeImports, ingestionBudget,
          params.collectionRunId, tracker);
        files += result.files;
      } catch (error) {
        driveErrors.push(`Drive account ${source.accountId || 'default'} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { files };
  };

  let localFolderPaths = params.localFolderPaths;
  if (!localFolderPaths || localFolderPaths.length === 0) {
    localFolderPaths = await getConfiguredLocalFolders(params.caseId);
  }

  const [gmail, drive, local] = await Promise.all([
    (params.includeGmail === false ? Promise.resolve({ messages: 0, attachments: 0 }) : pullFromGmail(params.caseId, params.userId, params.keywords, matchMode, gmailErrors, params.dateStart, params.dateEnd, params.includeGmailAttachments !== false, gmailAccountIds, params.onProgress, autoAnalyzeImports, ingestionBudget, params.collectionRunId, tracker)).catch((err) => {
      gmailErrors.push(`Gmail pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return { messages: 0, attachments: 0 };
    }),
    (params.includeDrive === false ? Promise.resolve({ files: 0 }) : collectDriveSources()).catch((err) => {
      driveErrors.push(`Drive pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return { files: 0 };
    }),
    (params.includeLocal === false ? Promise.resolve({ files: 0 }) : pullFromLocalFolders(params.caseId, params.userId, params.keywords, matchMode, localFolderPaths, localErrors, params.dateStart, params.dateEnd, params.onProgress, autoAnalyzeImports, ingestionBudget, params.collectionRunId, tracker)).catch((err) => {
      localErrors.push(`Local pull failed: ${err instanceof Error ? err.message : String(err)}`);
      return { files: 0 };
    }),
  ]);
  const ingestion = ingestionBudget.summary();
  const errors = [...gmailErrors, ...driveErrors, ...localErrors];
  for (const reason of ingestion.reasons) {
    if (reason.code !== 'duplicate') {
      errors.push(`Partial ${reason.source} ingestion: ${reason.code} (${reason.count})`);
    }
  }

  const revisions = tracker.revisions;

  const requestedSources = requestedPullSources(params);
  const storedBySource: Record<KeywordPullSource, number> = {
    gmail: gmail.messages + gmail.attachments,
    google_drive: drive.files,
    local: local.files,
  };
  const errorsBySource: Record<KeywordPullSource, string[]> = {
    gmail: gmailErrors,
    google_drive: driveErrors,
    local: localErrors,
  };
  const limitedCodes = new Set([
    'concurrency_limit',
    'file_empty',
    'file_too_large',
    'job_byte_limit',
    'job_item_limit',
    'analysis_limit',
    'storage_headroom',
  ]);
  const sourceSummaries: KeywordPullSourceSummary[] = requestedSources.map((source) => {
    const reasons = ingestion.reasons.filter((reason) => ingestionSourceGroup(reason.source) === source);
    const skippedItems = reasons.reduce((sum, reason) => sum + reason.count, 0);
    const sourceErrors = [
      ...errorsBySource[source],
      ...reasons.filter((reason) => reason.code !== 'duplicate')
        .map((reason) => `${reason.source}: ${reason.code} (${reason.count})`),
    ];
    const limited = reasons.some((reason) => limitedCodes.has(reason.code));
    const cancelled = ingestion.outcome === 'cancelled';
    const storedItems = storedBySource[source];
    const status: KeywordPullSourceSummary['status'] = cancelled ? 'cancelled'
      : limited ? 'limited'
        : sourceErrors.length > 0 ? storedItems > 0 ? 'partial' : 'failed'
          : 'completed';
    return {
      source,
      status,
      processedItems: storedItems + skippedItems,
      storedItems,
      skippedItems,
      matchedKeywords: uniqueStrings(revisions
        .filter((revision) => revision.source === (source === 'gmail' ? 'gmail' : source))
        .flatMap((revision) => revision.matchedKeywords)),
      errors: uniqueStrings(sourceErrors),
    };
  });
  const completedSources = sourceSummaries
    .filter((source) => source.status === 'completed')
    .map((source) => source.source);
  const storedItems = gmail.messages + gmail.attachments + drive.files + local.files;
  const hasLimits = ingestion.reasons.some((reason) => limitedCodes.has(reason.code));
  const hasSourceErrors = sourceSummaries.some((source) => source.status === 'failed' || source.status === 'partial');
  const completeness: KeywordPullCompleteness = ingestion.outcome === 'cancelled' ? 'cancelled'
    : hasLimits ? 'limited'
      : hasSourceErrors ? storedItems > 0 || completedSources.length > 0 ? 'partial' : 'failed'
        : storedItems === 0 ? 'complete_zero' : 'complete';
  const completedAt = new Date();
  const monitoring: KeywordPullMonitoring = {
    schemaVersion: 1,
    requestedKeywords: uniqueStrings(params.keywords),
    matchedKeywords: uniqueStrings([...tracker.matchedKeywords]),
    matchMode,
    requestedSources,
    completedSources,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - startedAt.getTime()),
    completeness,
    processedItems: ingestion.processedItems + ingestion.skippedItems,
    storedItems,
    skippedItems: ingestion.skippedItems,
    processedBytes: ingestion.processedBytes,
    matchReasons: uniqueStrings([...tracker.matchReasons]),
    sources: sourceSummaries,
    revisions,
  };

  return {
    gmailMessages: gmail.messages,
    gmailAttachments: gmail.attachments,
    driveFiles: drive.files,
    localFiles: local.files,
    errors,
    outcome: ingestion.outcome,
    ingestion,
    monitoring,
  };
}

function persistedJobStatus(completeness: KeywordPullCompleteness): 'completed' | 'completed_with_errors' | 'cancelled' | 'failed' {
  if (completeness === 'cancelled') return 'cancelled';
  if (completeness === 'failed' || completeness === 'interrupted') return 'failed';
  if (completeness === 'partial' || completeness === 'limited') return 'completed_with_errors';
  return 'completed';
}

function persistedJobMessage(completeness: KeywordPullCompleteness): string {
  switch (completeness) {
    case 'complete': return 'Pull complete';
    case 'complete_zero': return 'Pull complete - no new evidence revisions';
    case 'partial': return 'Pull completed with source warnings';
    case 'limited': return 'Pull completed with bounded partial results';
    case 'cancelled': return 'Pull cancelled with bounded partial results';
    case 'interrupted': return 'Pull interrupted before completion';
    case 'failed': return 'Pull failed';
    case 'queued': return 'Waiting to start';
    case 'running': return 'Checking connected evidence sources';
  }
}

function failedKeywordPullMonitoring(
  params: KeywordPullParams,
  startedAt: Date,
  completedAt: Date,
  completeness: 'failed' | 'interrupted' | 'cancelled',
  error: string | null,
): KeywordPullMonitoring {
  const monitoring = initialKeywordPullMonitoring(params, 'running', startedAt);
  return {
    ...monitoring,
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - startedAt.getTime()),
    completeness,
    sources: monitoring.sources.map((source) => ({
      ...source,
      status: completeness === 'cancelled' ? 'cancelled' : 'failed',
      errors: error ? [error] : [],
    })),
  };
}

/**
 * Execute a keyword pull and make its terminal state durable even for direct
 * and scheduled callers. Background jobs provide their own ID so progress and
 * terminal monitoring resolve to the same row.
 */
export async function pullEvidenceByKeywords(params: KeywordPullParams): Promise<PullByKeywordsResult> {
  if (!params.keywords?.length) throw new Error('At least one keyword is required');
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const ownsJob = !params.collectionRunId;
  const jobId = params.collectionRunId || uuidv4();
  const startedAt = new Date();
  if (ownsJob) {
    const monitoring = initialKeywordPullMonitoring(params, 'running', startedAt);
    await db.insert(keywordPullJobs).values({
      id: jobId,
      caseId: params.caseId,
      userId: params.userId,
      status: 'running',
      phase: 'discovering',
      message: persistedJobMessage('running'),
      processedWords: 0,
      totalWords: 0,
      processedItems: 0,
      totalItems: 0,
      result: JSON.stringify({ monitoring }),
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
    });
  }

  try {
    const result = await performEvidenceByKeywords({ ...params, collectionRunId: jobId });
    if (ownsJob) {
      const completedAt = result.monitoring.completedAt
        ? new Date(result.monitoring.completedAt)
        : new Date();
      await db.update(keywordPullJobs).set({
        status: persistedJobStatus(result.monitoring.completeness),
        phase: 'finalizing',
        message: persistedJobMessage(result.monitoring.completeness),
        processedItems: result.monitoring.processedItems,
        totalItems: result.monitoring.processedItems,
        estimatedSecondsRemaining: 0,
        result: JSON.stringify(result),
        error: result.monitoring.completeness === 'failed' ? result.errors[0] || 'Pull failed' : null,
        completedAt,
        updatedAt: completedAt,
      }).where(and(eq(keywordPullJobs.id, jobId), eq(keywordPullJobs.userId, params.userId)));
    }
    return result;
  } catch (error) {
    if (ownsJob) {
      const completedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      const monitoring = failedKeywordPullMonitoring(params, startedAt, completedAt, 'failed', message);
      await db.update(keywordPullJobs).set({
        status: 'failed',
        phase: 'finalizing',
        message: persistedJobMessage('failed'),
        result: JSON.stringify({
          gmailMessages: 0,
          gmailAttachments: 0,
          driveFiles: 0,
          localFiles: 0,
          errors: [message],
          monitoring,
        }),
        error: message,
        completedAt,
        updatedAt: completedAt,
      }).where(and(eq(keywordPullJobs.id, jobId), eq(keywordPullJobs.userId, params.userId)));
    }
    throw error;
  }
}

type KeywordPullJobParams = Omit<KeywordPullParams, 'onProgress' | 'signal' | 'ingestionBudget' | 'collectionRunId'>;
const runningKeywordPullJobIds = new Set<string>();
const runningKeywordPullJobControllers = new Map<string, AbortController>();

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
    const completedAt = new Date();
    const startedAt = active.startedAt || active.createdAt;
    const monitoring = failedKeywordPullMonitoring(
      params,
      startedAt,
      completedAt,
      'interrupted',
      'The application stopped while this pull was active. Start it again to retry safely.',
    );
    await db.update(keywordPullJobs).set({
      status: 'failed',
      message: 'Pull interrupted before completion',
      error: 'The application stopped while this pull was active. Start it again to retry safely.',
      result: JSON.stringify({ monitoring }),
      completedAt,
      updatedAt: completedAt,
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
    result: JSON.stringify({ monitoring: initialKeywordPullMonitoring(params) }),
    createdAt: now,
    updatedAt: now,
  });

  runningKeywordPullJobIds.add(id);
  const controller = new AbortController();
  runningKeywordPullJobControllers.set(id, controller);
  setImmediate(() => {
    void executeKeywordPullJob(id, params, controller);
  });

  const [job] = await db.select().from(keywordPullJobs).where(eq(keywordPullJobs.id, id)).limit(1);
  return job;
}

async function executeKeywordPullJob(
  id: string,
  params: KeywordPullJobParams,
  controller: AbortController,
): Promise<void> {
  const db = await getDb();
  if (!db) {
    runningKeywordPullJobIds.delete(id);
    runningKeywordPullJobControllers.delete(id);
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
    result: JSON.stringify({ monitoring: initialKeywordPullMonitoring(params, 'running', startedAt) }),
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
    const result = await pullEvidenceByKeywords({
      ...params,
      onProgress,
      signal: controller.signal,
      collectionRunId: id,
    });
    onProgress({ phase: 'finalizing', message: 'Updating the case evidence index' });
    await writeChain;
    const completedAt = new Date();
    const completeness = controller.signal.aborted ? 'cancelled' : result.monitoring.completeness;
    await db.update(keywordPullJobs).set({
      status: persistedJobStatus(completeness),
      phase: 'finalizing',
      message: persistedJobMessage(completeness),
      processedWords: completeness === 'cancelled' ? state.processedWords : Math.max(state.processedWords, state.totalWords),
      totalWords: Math.max(state.processedWords, state.totalWords),
      processedItems: completeness === 'cancelled'
        ? state.processedItems
        : Math.max(state.processedItems, state.totalItems, result.monitoring.processedItems),
      totalItems: Math.max(state.processedItems, state.totalItems, result.monitoring.processedItems),
      estimatedSecondsRemaining: 0,
      result: JSON.stringify(result),
      completedAt,
      updatedAt: completedAt,
    }).where(eq(keywordPullJobs.id, id));
    emitRealtimeDataChange(params.userId, { scope: 'evidence', caseId: params.caseId });
  } catch (error) {
    await writeChain;
    const completedAt = new Date();
    const errorMessage = controller.signal.aborted ? null : error instanceof Error ? error.message : String(error);
    const completeness = controller.signal.aborted ? 'cancelled' : 'failed';
    const monitoring = failedKeywordPullMonitoring(params, startedAt, completedAt, completeness, errorMessage);
    await db.update(keywordPullJobs).set({
      status: persistedJobStatus(completeness),
      phase: 'finalizing',
      message: persistedJobMessage(completeness),
      error: errorMessage,
      estimatedSecondsRemaining: null,
      result: JSON.stringify({
        gmailMessages: 0,
        gmailAttachments: 0,
        driveFiles: 0,
        localFiles: 0,
        errors: errorMessage ? [errorMessage] : [],
        monitoring,
      }),
      completedAt,
      updatedAt: completedAt,
    }).where(eq(keywordPullJobs.id, id));
    emitRealtimeDataChange(params.userId, { scope: 'evidence', caseId: params.caseId });
  } finally {
    runningKeywordPullJobIds.delete(id);
    runningKeywordPullJobControllers.delete(id);
  }
}

export async function cancelKeywordPullJob(id: string, userId: string) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [job] = await db.select().from(keywordPullJobs)
    .where(and(eq(keywordPullJobs.id, id), eq(keywordPullJobs.userId, userId)))
    .limit(1);
  if (!job) return null;
  if (!['queued', 'running'].includes(job.status)) return job;

  runningKeywordPullJobControllers.get(id)?.abort();
  const completedAt = new Date();
  const base = monitoringForJob(job);
  const monitoring: KeywordPullMonitoring = {
    ...base,
    completeness: 'cancelled',
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - (job.startedAt || job.createdAt).getTime()),
    sources: base.sources.map((source) => ({ ...source, status: 'cancelled' })),
  };
  await db.update(keywordPullJobs).set({
    status: 'cancelled',
    message: 'Pull cancelled with bounded partial results',
    estimatedSecondsRemaining: 0,
    result: JSON.stringify({ ...jsonObject(job.result), monitoring }),
    completedAt,
    updatedAt: completedAt,
  }).where(and(eq(keywordPullJobs.id, id), eq(keywordPullJobs.userId, userId)));
  const [cancelled] = await db.select().from(keywordPullJobs)
    .where(and(eq(keywordPullJobs.id, id), eq(keywordPullJobs.userId, userId)))
    .limit(1);
  return cancelled ?? null;
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
  return interruptKeywordPullJob(active);
}

type KeywordPullJobRow = typeof keywordPullJobs.$inferSelect;

function jsonObject(value: string | null): Record<string, any> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function dateIso(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function legacyMonitoringForJob(job: KeywordPullJobRow): KeywordPullMonitoring {
  const result = jsonObject(job.result);
  const ingestion = result.ingestion && typeof result.ingestion === 'object' ? result.ingestion : {};
  const storedBySource: Record<KeywordPullSource, number> = {
    gmail: Number(result.gmailMessages || 0) + Number(result.gmailAttachments || 0),
    google_drive: Number(result.driveFiles || 0),
    local: Number(result.localFiles || 0),
  };
  const requestedSources = KEYWORD_PULL_SOURCES.filter((source) => source === 'gmail'
    ? 'gmailMessages' in result || 'gmailAttachments' in result
    : source === 'google_drive' ? 'driveFiles' in result : 'localFiles' in result);
  const normalizedSources = requestedSources.length > 0 ? requestedSources : [...KEYWORD_PULL_SOURCES];
  const storedItems = Object.values(storedBySource).reduce((sum, count) => sum + count, 0);
  const reasons = Array.isArray(ingestion.reasons) ? ingestion.reasons : [];
  const skippedItems = Number(ingestion.skippedItems || 0);
  const interrupted = job.message === 'Pull interrupted before completion'
    || String(job.error || '').includes('stopped while this pull was active');
  const completeness: KeywordPullCompleteness = job.status === 'queued' ? 'queued'
    : job.status === 'running' ? 'running'
      : job.status === 'cancelled' ? 'cancelled'
        : job.status === 'failed' ? interrupted ? 'interrupted' : 'failed'
          : job.status === 'completed_with_errors'
            ? reasons.some((reason: any) => reason?.code && reason.code !== 'duplicate') ? 'limited' : 'partial'
            : storedItems === 0 ? 'complete_zero' : 'complete';
  const startedAt = job.startedAt || job.createdAt;
  const completedAt = job.completedAt;
  return {
    schemaVersion: 1,
    requestedKeywords: [],
    matchedKeywords: [],
    matchMode: 'any',
    requestedSources: normalizedSources,
    completedSources: ['complete', 'complete_zero'].includes(completeness) ? normalizedSources : [],
    startedAt: dateIso(startedAt),
    completedAt: dateIso(completedAt),
    durationMs: startedAt && completedAt
      ? Math.max(1, completedAt.getTime() - startedAt.getTime())
      : null,
    completeness,
    processedItems: Number(ingestion.processedItems || storedItems) + skippedItems,
    storedItems,
    skippedItems,
    processedBytes: Number(ingestion.processedBytes || 0),
    matchReasons: [],
    sources: normalizedSources.map((source) => ({
      source,
      status: completeness === 'queued' || completeness === 'running' ? completeness
        : completeness === 'cancelled' ? 'cancelled'
          : completeness === 'failed' || completeness === 'interrupted' ? 'failed'
            : completeness === 'limited' ? 'limited'
              : completeness === 'partial' ? 'partial' : 'completed',
      processedItems: storedBySource[source],
      storedItems: storedBySource[source],
      skippedItems: 0,
      matchedKeywords: [],
      errors: job.error ? [job.error] : [],
    })),
    revisions: [],
  };
}

function monitoringForJob(job: KeywordPullJobRow): KeywordPullMonitoring {
  const persisted = jsonObject(job.result).monitoring;
  const monitoring: KeywordPullMonitoring = persisted?.schemaVersion === 1
    && Array.isArray(persisted.requestedSources)
    && Array.isArray(persisted.sources)
    ? persisted as KeywordPullMonitoring
    : legacyMonitoringForJob(job);
  const interrupted = job.message === 'Pull interrupted before completion'
    || String(job.error || '').includes('stopped while this pull was active');
  const override: KeywordPullCompleteness | null = job.status === 'queued' ? 'queued'
    : job.status === 'running' ? 'running'
      : job.status === 'cancelled' ? 'cancelled'
        : job.status === 'failed' ? interrupted ? 'interrupted' : 'failed'
          : null;
  if (!override || monitoring.completeness === override) return monitoring;
  return {
    ...monitoring,
    completeness: override,
    completedAt: dateIso(job.completedAt) ?? monitoring.completedAt,
    durationMs: job.startedAt && job.completedAt
      ? Math.max(1, job.completedAt.getTime() - job.startedAt.getTime())
      : monitoring.durationMs,
    sources: monitoring.sources.map((source) => ({
      ...source,
      status: override === 'queued' || override === 'running' ? override
        : override === 'cancelled' ? 'cancelled' : 'failed',
      errors: job.error ? uniqueStrings([...source.errors, job.error]) : source.errors,
    })),
  };
}

async function interruptKeywordPullJob(job: KeywordPullJobRow): Promise<KeywordPullJobRow> {
  const db = await getDb();
  if (!db) return job;
  const completedAt = new Date();
  const base = monitoringForJob(job);
  const error = 'The application stopped while this pull was active. Start it again to retry safely.';
  const monitoring: KeywordPullMonitoring = {
    ...base,
    completeness: 'interrupted',
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(1, completedAt.getTime() - (job.startedAt || job.createdAt).getTime()),
    sources: base.sources.map((source) => ({ ...source, status: 'failed', errors: uniqueStrings([...source.errors, error]) })),
  };
  const result = { ...jsonObject(job.result), monitoring };
  await db.update(keywordPullJobs).set({
    status: 'failed',
    phase: 'finalizing',
    message: persistedJobMessage('interrupted'),
    error,
    result: JSON.stringify(result),
    completedAt,
    updatedAt: completedAt,
  }).where(and(eq(keywordPullJobs.id, job.id), eq(keywordPullJobs.userId, job.userId)));
  return {
    ...job,
    status: 'failed',
    phase: 'finalizing',
    message: persistedJobMessage('interrupted'),
    error,
    result: JSON.stringify(result),
    completedAt,
    updatedAt: completedAt,
  };
}

export async function getKeywordPullMonitoring(caseId: string, userId: string, limit = 20) {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const rows = await db.select().from(keywordPullJobs)
    .where(and(eq(keywordPullJobs.caseId, caseId), eq(keywordPullJobs.userId, userId)))
    .orderBy(desc(keywordPullJobs.createdAt))
    .limit(Math.max(1, Math.min(50, limit)));
  const reconciled: KeywordPullJobRow[] = [];
  for (const row of rows) {
    reconciled.push(
      (row.status === 'queued' || row.status === 'running') && !runningKeywordPullJobIds.has(row.id)
        ? await interruptKeywordPullJob(row)
        : row,
    );
  }
  const jobs = reconciled.map((job) => ({
    id: job.id,
    caseId: job.caseId,
    status: job.status,
    phase: job.phase,
    message: job.message,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    monitoring: monitoringForJob(job),
  }));
  const summary = jobs.reduce((totals, job) => {
    totals.processedItems += job.monitoring.processedItems;
    totals.storedItems += job.monitoring.storedItems;
    totals.skippedItems += job.monitoring.skippedItems;
    totals.processedBytes += job.monitoring.processedBytes;
    totals.states[job.monitoring.completeness] = (totals.states[job.monitoring.completeness] || 0) + 1;
    return totals;
  }, {
    totalRuns: jobs.length,
    processedItems: 0,
    storedItems: 0,
    skippedItems: 0,
    processedBytes: 0,
    states: {} as Partial<Record<KeywordPullCompleteness, number>>,
  });
  return { summary, jobs };
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
    driveSources: savedGoogleDriveSources(settings.metadata),
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
  emitRealtimeDataChange(settings.userId, { scope: 'evidence', caseId });
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
