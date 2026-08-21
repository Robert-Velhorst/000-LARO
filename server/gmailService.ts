/**
 * Gmail Service
 * Integrates with Gmail API for OAuth and email data access
 * Supports email thread listing, message reading, and attachment extraction
 * Includes advanced filtering by sender, subject, and date range
 */

import { storagePut } from './storage';
import { getDb } from './db';
import { evidenceSources, evidenceItems } from './schema';
import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';
import { ENV } from './_core/env';
import { collectBoundedBytes, withByteReadAdmission } from './boundedBytes';
import { MAX_EVIDENCE_BASE64_CHARS, MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';

const MAX_GMAIL_ATTACHMENT_RESPONSE_BYTES = MAX_EVIDENCE_BASE64_CHARS + 128 * 1024;

async function readBoundedGmailJson<T>(response: Response, label: string): Promise<T> {
  const declaredBytes = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_GMAIL_ATTACHMENT_RESPONSE_BYTES) {
    throw new Error(`${label} exceeds the 7 MB evidence limit`);
  }
  const responseBytes = await collectBoundedBytes(response.body, {
    maxBytes: MAX_GMAIL_ATTACHMENT_RESPONSE_BYTES,
    label: `${label} response`,
    limitMessage: `${label} exceeds the 7 MB evidence limit`,
  });
  return JSON.parse(responseBytes.toString('utf8')) as T;
}

export interface GmailThread {
  id: string;
  snippet: string;
  historyId: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet: string;
  internalDate: string;
  payload?: {
    headers?: Array<{ name: string; value: string }>;
    parts?: Array<{
      partId: string;
      mimeType: string;
      filename?: string;
      body?: { attachmentId?: string; size?: number; data?: string };
      headers?: Array<{ name: string; value: string }>;
    }>;
    body?: { data?: string };
  };
}

interface GmailAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  data?: string;
}

export interface SyncProgress {
  totalThreads: number;
  processedThreads: number;
  totalMessages: number;
  totalAttachments: number;
  errors: string[];
}

interface EmailFilterOptions {
  sender?: string;
  subject?: string;
  startDate?: Date;
  endDate?: Date;
  maxResults?: number;
}

/**
 * Get Gmail OAuth configuration
 * Uses the same OAuth credentials as email accounts
 */
export function getGmailOAuthConfig() {
  return {
    clientId: ENV.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '',
    clientSecret: ENV.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
    redirectUri: `${process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3000'}/api/oauth/gmail/callback`,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  };
}

/**
 * Generate Gmail OAuth authorization URL
 */
export function getGmailAuthorizationUrl(userId: string, caseId: string): string {
  const config = getGmailOAuthConfig();

  // Store userId and caseId in state parameter for callback
  const state = Buffer.from(JSON.stringify({ userId, caseId })).toString('base64');

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    access_type: 'offline',
    prompt: 'consent',
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeGmailCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}> {
  const config = getGmailOAuthConfig();

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  const data = await response.json();

  if (!data.access_token) {
    console.error('[Gmail] Token exchange failed:', data);
    throw new Error(`Gmail token exchange failed: ${data.error_description || data.error}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in || 3600,
  };
}

/**
 * Build Gmail query string from filter options
 * Gmail uses a special query syntax for filtering
 */
function buildGmailQuery(filters: EmailFilterOptions): string {
  const queryParts: string[] = [];

  if (filters.sender) {
    queryParts.push(`from:${filters.sender}`);
  }

  if (filters.subject) {
    queryParts.push(`subject:${filters.subject}`);
  }

  if (filters.startDate) {
    const startDateStr = filters.startDate.toISOString().split('T')[0];
    queryParts.push(`after:${startDateStr}`);
  }

  if (filters.endDate) {
    const endDateStr = filters.endDate.toISOString().split('T')[0];
    queryParts.push(`before:${endDateStr}`);
  }

  return queryParts.join(' ');
}

/**
 * List email threads with optional filtering
 */
export async function listGmailThreads(
  accessToken: string,
  query: string = '',
  maxResults: number = 10
): Promise<GmailThread[]> {
  const params = new URLSearchParams({
    maxResults: maxResults.toString(),
  });
  if (query) params.append('q', query);

  const response = await fetch(`https://www.googleapis.com/gmail/v1/users/me/threads?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = await response.json();

  if (data.error) {
    console.error('[Gmail] Failed to list threads:', data);
    throw new Error(`Failed to list Gmail threads: ${data.error.message}`);
  }

  return data.threads || [];
}

/**
 * Search Gmail emails with advanced filtering
 */
export async function searchGmailEmails(
  accessToken: string,
  filters: EmailFilterOptions
): Promise<GmailThread[]> {
  const query = buildGmailQuery(filters);
  const maxResults = filters.maxResults || 20;

  return listGmailThreads(accessToken, query, maxResults);
}

/**
 * Get full message details
 */
export async function getGmailMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  return withByteReadAdmission(async () => {
    const response = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const data = await readBoundedGmailJson<GmailMessage & { error?: { message?: string } }>(response, 'Gmail message');

    if (data.error) {
      console.error('[Gmail] Failed to get message:', data);
      throw new Error(`Failed to get Gmail message: ${data.error.message}`);
    }

    return data;
  });
}

/**
 * Get attachment data
 */
export async function getGmailAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string
): Promise<GmailAttachment | null> {
  return withByteReadAdmission(() => getGmailAttachmentAdmitted(accessToken, messageId, attachmentId));
}

async function getGmailAttachmentAdmitted(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<GmailAttachment | null> {
  const response = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  const data = await readBoundedGmailJson<GmailAttachment & { error?: { message?: string } }>(response, 'Gmail attachment');

  if (data.error) {
    console.error('[Gmail] Failed to get attachment:', data);
    return null;
  }

  return data;
}

export async function getGmailAttachmentBytes(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer | null> {
  return withByteReadAdmission(async () => {
    const attachment = await getGmailAttachmentAdmitted(accessToken, messageId, attachmentId);
    if (!attachment?.data) return null;
    if (attachment.size > MAX_EVIDENCE_FILE_BYTES || attachment.data.length > MAX_EVIDENCE_BASE64_CHARS) {
      throw new Error('Gmail attachment exceeds the 7 MB evidence limit');
    }
    const normalized = attachment.data.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length > MAX_EVIDENCE_FILE_BYTES) {
      throw new Error('Gmail attachment exceeds the 7 MB evidence limit');
    }
    return bytes;
  });
}

/**
 * Extract email headers
 */
function extractHeaders(headers: Array<{ name: string; value: string }> = []) {
  const result: Record<string, string> = {};
  if (Array.isArray(headers)) {
    headers.forEach((h) => {
      result[h.name.toLowerCase()] = h.value;
    });
  }
  return result;
}

/**
 * Get email body text
 */
function getEmailBody(payload: GmailMessage['payload']): string {
  if (!payload) return '';

  // Check if body is directly in payload
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } catch (e) {
      return '';
    }
  }

  // Check parts for text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        try {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        } catch (e) {
          continue;
        }
      }
    }
  }

  return '';
}

/**
 * Extract attachments from message
 */
function extractAttachments(payload: GmailMessage['payload']): Array<{ partId: string; filename: string; mimeType: string }> {
  const attachments: Array<{ partId: string; filename: string; mimeType: string }> = [];

  if (!payload?.parts) return attachments;

  for (const part of payload.parts) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        partId: part.partId,
        filename: part.filename,
        mimeType: part.mimeType,
      });
    }
  }

  return attachments;
}

/**
 * Sync Gmail threads for a case with optional filtering
 */
export async function syncGmailForCase(
  userId: string,
  caseId: string,
  accessToken: string,
  filters?: EmailFilterOptions
): Promise<SyncProgress> {
  const progress: SyncProgress = {
    totalThreads: 0,
    processedThreads: 0,
    totalMessages: 0,
    totalAttachments: 0,
    errors: [],
  };

  try {
    const db = await getDb();
    if (!db) {
      throw new Error('Database not available');
    }

    // Search threads with filters
    const threads = filters ? await searchGmailEmails(accessToken, filters) : await listGmailThreads(accessToken, '', 20);
    progress.totalThreads = threads.length;

    for (const thread of threads) {
      try {
        // Get all messages in thread
        const threadResponse = await fetch(
          `https://www.googleapis.com/gmail/v1/users/me/threads/${thread.id}?format=full`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        const threadData = await threadResponse.json();
        if (threadData.error) {
          progress.errors.push(`Failed to get thread ${thread.id}: ${threadData.error.message}`);
          continue;
        }

        const messages = threadData.messages || [];

        for (const message of messages) {
          try {
            const headers = extractHeaders(message.payload?.headers);
            const from = headers.from || 'Unknown';
            const to = headers.to || '';
            const subject = headers.subject || 'No Subject';
            const date = new Date(parseInt(message.internalDate));
            const body = getEmailBody(message.payload);

            // Create evidence item for email
            const itemId = uuidv4();
            const content = `From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date.toISOString()}\n\n${body}`;

            await db.insert(evidenceItems).values({
              id: itemId,
              caseId,
              sourceId: thread.id,
              source: 'gmail',
              type: 'email',
              title: subject,
              content,
              metadata: JSON.stringify({
                from,
                to,
                subject,
                date: date.toISOString(),
                messageId: message.id,
                threadId: thread.id,
              }),
              createdAt: new Date(),
            });

            progress.totalMessages++;

            // Handle attachments
            const attachments = extractAttachments(message.payload);
            for (const attachment of attachments) {
              try {
                const attachmentData = await getGmailAttachment(accessToken, message.id, attachment.partId);
                if (attachmentData?.data) {
                  const buffer = Buffer.from(attachmentData.data, 'base64');
                  const { key, url } = await storagePut(
                    `evidence/${caseId}/gmail/${uuidv4()}-${attachment.filename}`,
                    buffer,
                    attachment.mimeType
                  );

                  // Create evidence item for attachment
                  const attachmentItemId = uuidv4();
                  await db.insert(evidenceItems).values({
                    id: attachmentItemId,
                    caseId,
                    sourceId: thread.id,
                    source: 'gmail',
                    type: 'attachment',
                    title: attachment.filename,
                    content: `Attachment from email: ${subject}`,
                    metadata: JSON.stringify({
                      filename: attachment.filename,
                      mimeType: attachment.mimeType,
                      size: buffer.length,
                      storageKey: key,
                      storageUrl: url,
                      messageId: message.id,
                      threadId: thread.id,
                    }),
                    createdAt: new Date(),
                  });

                  progress.totalAttachments++;
                }
              } catch (e) {
                progress.errors.push(`Failed to download attachment ${attachment.filename}: ${String(e)}`);
              }
            }
          } catch (e) {
            progress.errors.push(`Failed to process message: ${String(e)}`);
          }
        }

        progress.processedThreads++;
      } catch (e) {
        progress.errors.push(`Failed to process thread ${thread.id}: ${String(e)}`);
      }
    }

    // Update evidence source
    await db
      .update(evidenceSources)
      .set({
        lastSyncedAt: new Date(),
        itemCount: progress.totalMessages + progress.totalAttachments,
      })
      .where(and(eq(evidenceSources.caseId, caseId), eq(evidenceSources.sourceType, 'gmail')));

    return progress;
  } catch (e) {
    progress.errors.push(`Sync failed: ${String(e)}`);
    return progress;
  }
}

/**
 * Test Gmail connection
 */
export async function testGmailConnection(accessToken: string): Promise<{ ok: boolean; email?: string; error?: string }> {
  try {
    const response = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = await response.json();

    if (data.error) {
      return { ok: false, error: data.error.message };
    }

    return { ok: true, email: data.emailAddress };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
