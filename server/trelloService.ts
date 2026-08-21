/**
 * Trello Service
 * Integrates with Trello API for OAuth and board/card data access
 * Supports board listing, card extraction, and comment collection
 */

import { storagePut } from './storage';
import { getDb } from './db';
import { evidenceSources, evidenceItems } from './schema';
import { v4 as uuidv4 } from 'uuid';
import { eq, and, inArray } from 'drizzle-orm';
import { fetchTrustedRemote } from './trustedRemoteFetch';
import {
  assertProviderArrayLimit,
  PROVIDER_LIMITS,
  ProviderBatchBudget,
  ProviderBatchLimitError,
} from './providerLimits';
import { MAX_EVIDENCE_FILE_BYTES } from '../shared/evidenceFiles';

export interface TrelloBoard {
  id: string;
  name: string;
  url: string;
  desc?: string;
}

export interface TrelloList {
  id: string;
  name: string;
  boardId: string;
}

export interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  url: string;
  listId: string;
  boardId: string;
  dateLastActivity?: string;
  attachments?: Array<{
    id: string;
    name: string;
    url: string;
  }>;
}

interface TrelloComment {
  id: string;
  text: string;
  memberCreator?: {
    id: string;
    fullName: string;
  };
  date: string;
}

export interface SyncProgress {
  totalBoards: number;
  processedBoards: number;
  totalCards: number;
  totalComments: number;
  totalAttachments: number;
  errors: string[];
}

export type TrelloRequestBudget = {
  beforeRequest: () => void;
  afterResponse: (bytes: number) => void;
};

export interface TrelloMember {
  id: string;
  fullName: string;
  email?: string;
}

async function fetchTrelloArray<T>(options: {
  operation: string;
  path: string;
  token: string;
  fields: Record<string, string>;
  limit: number;
  limitLabel: string;
  budget?: TrelloRequestBudget;
}): Promise<T[]> {
  const config = getTrelloOAuthConfig();
  const url = new URL(`https://api.trello.com/1/${options.path}`);
  url.search = new URLSearchParams({
    key: config.apiKey,
    token: options.token,
    ...options.fields,
  }).toString();
  options.budget?.beforeRequest();
  try {
    const response = await fetchTrustedRemote(url.toString(), {
      allowedHosts: ['api.trello.com'],
      maxBytes: PROVIDER_LIMITS.trello.maxJsonBytes,
      maxRedirects: 0,
      timeoutMs: 20_000,
      init: { headers: { Accept: 'application/json' } },
    });
    if (!response.ok) throw new Error('provider status');
    const body = await response.text();
    options.budget?.afterResponse(Buffer.byteLength(body, 'utf8'));
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('provider JSON');
    }
    assertProviderArrayLimit<T>(parsed, options.limit, options.limitLabel);
    return parsed;
  } catch (error) {
    console.error('[Trello] Provider request failed', { operation: options.operation });
    if (error instanceof ProviderBatchLimitError) throw error;
    throw new Error(`Trello ${options.operation} request failed`);
  }
}

async function fetchTrelloObject<T>(options: {
  operation: string;
  path: string;
  token: string;
  fields: Record<string, string>;
  maxBytes?: number;
  budget?: TrelloRequestBudget;
}): Promise<T> {
  const config = getTrelloOAuthConfig();
  const url = new URL(`https://api.trello.com/1/${options.path}`);
  url.search = new URLSearchParams({
    key: config.apiKey,
    token: options.token,
    ...options.fields,
  }).toString();
  options.budget?.beforeRequest();
  try {
    const response = await fetchTrustedRemote(url.toString(), {
      allowedHosts: ['api.trello.com'],
      maxBytes: options.maxBytes ?? PROVIDER_LIMITS.trello.maxJsonBytes,
      maxRedirects: 0,
      timeoutMs: 20_000,
      init: { headers: { Accept: 'application/json' } },
    });
    if (!response.ok) throw new Error('provider status');
    const body = await response.text();
    options.budget?.afterResponse(Buffer.byteLength(body, 'utf8'));
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('provider object');
    }
    return parsed as T;
  } catch (error) {
    console.error('[Trello] Provider request failed', { operation: options.operation });
    if (error instanceof ProviderBatchLimitError) throw error;
    throw new Error(`Trello ${options.operation} request failed`);
  }
}

/**
 * Get Trello OAuth configuration
 */
export function getTrelloOAuthConfig() {
  return {
    apiKey: process.env.TRELLO_API_KEY || '',
    apiSecret: process.env.TRELLO_API_SECRET || '',
    redirectUri: `${process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3000'}/api/oauth/trello/callback`,
    scopes: ['read', 'write', 'account'],
  };
}

/**
 * Generate Trello OAuth authorization URL
 */
export function getTrelloAuthorizationUrl(userId: string, caseId: string): string {
  const config = getTrelloOAuthConfig();

  // Store userId and caseId in state parameter for callback
  const state = Buffer.from(JSON.stringify({ userId, caseId })).toString('base64');

  // Trello OAuth URL
  const params = new URLSearchParams({
    key: config.apiKey,
    token: '', // Will be obtained after user approves
    response_type: 'token',
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(','),
    expiration: 'never',
    name: 'LARO - Legal Automation Dashboard',
    state,
  });

  return `https://trello.com/app-authorization?${params.toString()}`;
}

/**
 * Get Trello boards for a user
 */
export async function getTrelloBoards(token: string, budget?: TrelloRequestBudget): Promise<TrelloBoard[]> {
  return fetchTrelloArray<TrelloBoard>({
    operation: 'board',
    path: 'members/me/boards',
    token,
    fields: { fields: 'id,name,url,desc' },
    limit: PROVIDER_LIMITS.trello.maxBoards,
    limitLabel: 'Trello board',
    budget,
  });
}

/**
 * Get lists for a Trello board
 */
export async function getTrelloLists(boardId: string, token: string, budget?: TrelloRequestBudget): Promise<TrelloList[]> {
  const lists = await fetchTrelloArray<Omit<TrelloList, 'boardId'>>({
    operation: 'list',
    path: `boards/${encodeURIComponent(boardId)}/lists`,
    token,
    fields: { fields: 'id,name' },
    limit: PROVIDER_LIMITS.trello.maxListsPerBoard,
    limitLabel: 'Trello list',
    budget,
  });
  return lists.map((list) => ({
      ...list,
      boardId,
  }));
}

/**
 * Get cards for a Trello list
 */
export async function getTrelloCards(listId: string, boardId: string, token: string, budget?: TrelloRequestBudget): Promise<TrelloCard[]> {
  const cards = await fetchTrelloArray<Omit<TrelloCard, 'listId' | 'boardId'>>({
    operation: 'card',
    path: `lists/${encodeURIComponent(listId)}/cards`,
    token,
    fields: { fields: 'id,name,desc,url,dateLastActivity', attachments: 'open' },
    limit: PROVIDER_LIMITS.trello.maxCardsPerList,
    limitLabel: 'Trello card',
    budget,
  });
  return cards.map((card) => ({
      ...card,
      listId,
      boardId,
  }));
}

/**
 * Get comments for a Trello card
 */
export async function getTrelloComments(cardId: string, token: string, budget?: TrelloRequestBudget): Promise<TrelloComment[]> {
  const actions = await fetchTrelloArray<any>({
    operation: 'comment',
    path: `cards/${encodeURIComponent(cardId)}/actions`,
    token,
    fields: { filter: 'commentCard', fields: 'id,data,type,date,memberCreator' },
    limit: PROVIDER_LIMITS.trello.maxCommentsPerCard,
    limitLabel: 'Trello comment',
    budget,
  });
  return actions.map((action) => ({
      id: action.id,
      text: action.data?.text || '',
      memberCreator: action.memberCreator,
      date: action.date,
  }));
}

/**
 * Download Trello attachment
 */
export async function downloadTrelloAttachment(
  attachmentUrl: string,
  fileName: string,
  options: { maxBytes?: number; timeoutMs?: number; token?: string } = {},
): Promise<{ key: string; url: string } | null> {
  try {
    const config = getTrelloOAuthConfig();
    const initialHost = new URL(attachmentUrl).hostname.toLowerCase();
    const authorization = options.token && config.apiKey && ['trello.com', 'api.trello.com'].includes(initialHost)
      ? `OAuth oauth_consumer_key="${config.apiKey}", oauth_token="${options.token}"`
      : null;
    const response = await fetchTrustedRemote(attachmentUrl, {
      allowedHosts: ['trello.com', 'api.trello.com', 'trello-attachments.s3.amazonaws.com'],
      maxBytes: options.maxBytes ?? 25 * 1024 * 1024,
      timeoutMs: options.timeoutMs,
      init: authorization ? { headers: { Authorization: authorization } } : undefined,
    });

    if (!response.ok) {
      console.warn('[Trello] Failed to download attachment:', response.status);
      return null;
    }

    const buffer = await response.arrayBuffer();
    const mimeType = response.headers.get('content-type') || 'application/octet-stream';

    // Upload to S3
    const { key, url } = await storagePut(
      `uploads/evidence/trello/${uuidv4()}-${fileName}`,
      Buffer.from(buffer),
      mimeType
    );

    return { key, url };
  } catch (error) {
    console.error('[Trello] Attachment download failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
}

/**
 * Test Trello connection
 */
export async function testTrelloConnection(token: string): Promise<{ ok: boolean; member?: TrelloMember; error?: string }> {
  try {
    const member = await fetchTrelloObject<TrelloMember>({
      operation: 'connection test',
      path: 'members/me',
      token,
      fields: { fields: 'id,fullName,email' },
      maxBytes: PROVIDER_LIMITS.trello.maxMemberJsonBytes,
    });
    return { ok: true, member };
  } catch {
    return { ok: false, error: 'Trello connection test failed' };
  }
}

/**
 * Sync Trello boards and cards for a case
 */
export async function syncTrelloForCase(
  userId: string,
  caseId: string,
  token: string,
  boardIds?: string[]
): Promise<SyncProgress> {
  const db = await getDb();
  if (!db) {
    throw new Error('Database not available');
  }

  const progress: SyncProgress = {
    totalBoards: 0,
    processedBoards: 0,
    totalCards: 0,
    totalComments: 0,
    totalAttachments: 0,
    errors: [],
  };
  const existingSource = await db
    .select({ id: evidenceSources.id })
    .from(evidenceSources)
    .where(and(
      eq(evidenceSources.caseId, caseId),
      eq(evidenceSources.userId, userId),
      inArray(evidenceSources.sourceType, ['trello', 'Trello', 'Board']),
    ))
    .limit(1);
  const sourceId = existingSource[0]?.id || uuidv4();
  if (existingSource.length > 0) {
    await db.update(evidenceSources).set({
      provider: 'trello',
      sourceType: 'trello',
      sourceIdentifier: 'trello',
      connectionStatus: 'syncing',
      status: 'syncing',
      errorMessage: null,
    }).where(and(
      eq(evidenceSources.id, sourceId),
      eq(evidenceSources.userId, userId),
    ));
  } else {
    await db.insert(evidenceSources).values({
      id: sourceId,
      caseId,
      userId,
      provider: 'trello',
      sourceType: 'trello',
      sourceIdentifier: 'trello',
      connectionStatus: 'syncing',
      status: 'syncing',
    });
  }
  const batchBudget = new ProviderBatchBudget({
    boards: PROVIDER_LIMITS.trello.maxSyncBoards,
    lists: PROVIDER_LIMITS.trello.maxSyncLists,
    cards: PROVIDER_LIMITS.trello.maxSyncCards,
    comments: PROVIDER_LIMITS.trello.maxSyncComments,
    attachments: PROVIDER_LIMITS.trello.maxSyncAttachments,
    requests: PROVIDER_LIMITS.trello.maxSyncRequests,
    bytes: PROVIDER_LIMITS.trello.maxSyncJsonBytes,
  });
  const requestBudget: TrelloRequestBudget = {
    beforeRequest: () => {
      batchBudget.consume('requests', 1, 'Trello sync request limit exceeded');
    },
    afterResponse: (bytes) => {
      batchBudget.consume('bytes', bytes, 'Trello sync response-byte limit exceeded');
    },
  };

  try {
    // Get all boards
    let boards = await getTrelloBoards(token, requestBudget);

    // Filter by boardIds if provided
    if (boardIds && boardIds.length > 0) {
      const selectedIds = new Set(boardIds);
      boards = boards.filter(b => selectedIds.has(b.id));
    }
    batchBudget.consume('boards', boards.length, 'Trello sync board limit exceeded');

    progress.totalBoards = boards.length;

    // Process each board
    for (const board of boards) {
      try {
        // Get lists for this board
        const lists = await getTrelloLists(board.id, token, requestBudget);
        batchBudget.consume('lists', lists.length, 'Trello sync list limit exceeded');

        // Process each list
        for (const list of lists) {
          // Get cards for this list
          const cards = await getTrelloCards(list.id, board.id, token, requestBudget);
          batchBudget.consume('cards', cards.length, 'Trello sync card limit exceeded');
          progress.totalCards += cards.length;

          // Process each card
          for (const card of cards) {
            try {
              const attachmentCount = card.attachments?.length || 0;
              if (attachmentCount > PROVIDER_LIMITS.trello.maxAttachmentsPerCard) {
                throw new ProviderBatchLimitError('Trello card attachment limit exceeded');
              }
              batchBudget.consume('attachments', attachmentCount, 'Trello sync attachment limit exceeded');
              // Get comments for this card
              const comments = await getTrelloComments(card.id, token, requestBudget);
              batchBudget.consume('comments', comments.length, 'Trello sync comment limit exceeded');
              progress.totalComments += comments.length;

              // Create evidence item for the card
              const cardContent = `
Board: ${board.name}
List: ${list.name}
Card: ${card.name}
URL: ${card.url}
Description: ${card.desc || 'N/A'}
Last Activity: ${card.dateLastActivity || 'N/A'}

Comments:
${comments.map(c => `- ${c.memberCreator?.fullName || 'Unknown'} (${c.date}): ${c.text}`).join('\n')}
              `.trim();

              const evidenceId = uuidv4();

              // Store card as evidence item
              await db.insert(evidenceItems).values({
                id: evidenceId,
                caseId,
                userId,
                title: card.name,
                source: 'trello',
                sourceId,
                sourceType: 'card',
                metadata: JSON.stringify({
                  boardId: board.id,
                  boardName: board.name,
                  listId: list.id,
                  listName: list.name,
                  cardId: card.id,
                  commentCount: comments.length,
                  attachmentCount: card.attachments?.length || 0,
                  cardContent,
                  url: card.url,
                }),
                createdAt: new Date(),
              });

              // Download and store attachments
              if (card.attachments && card.attachments.length > 0) {
                for (const attachment of card.attachments) {
                  try {
                    const result = await downloadTrelloAttachment(attachment.url, attachment.name, {
                      token,
                      maxBytes: MAX_EVIDENCE_FILE_BYTES,
                    });
                    if (result) {
                      progress.totalAttachments++;

                      // Store attachment metadata
                      await db.insert(evidenceItems).values({
                        id: uuidv4(),
                        caseId,
                        userId,
                        title: `Attachment: ${attachment.name}`,
                        source: 'trello',
                        sourceId,
                        sourceType: 'attachment',
                        metadata: JSON.stringify({
                          attachmentId: attachment.id,
                          fileName: attachment.name,
                          s3Key: result.key,
                          cardId: card.id,
                          url: result.url,
                        }),
                        createdAt: new Date(),
                      });
                    } else {
                      progress.errors.push(`Failed to download attachment ${attachment.name}`);
                    }
                  } catch (error) {
                    if (error instanceof ProviderBatchLimitError) throw error;
                    progress.errors.push(`Failed to download attachment ${attachment.name}`);
                  }
                }
              }
            } catch (error) {
              if (error instanceof ProviderBatchLimitError) throw error;
              progress.errors.push(`Failed to process card ${card.name}`);
            }
          }
        }

        progress.processedBoards++;
      } catch (error) {
        if (error instanceof ProviderBatchLimitError) throw error;
        progress.errors.push(`Failed to process board ${board.name}`);
      }
    }

    // Update evidence source
    const sourceValues = {
      provider: 'trello',
      sourceType: 'trello',
      sourceIdentifier: 'trello',
      connectionStatus: 'synced',
      status: 'synced',
      itemsCollected: progress.totalCards + progress.totalAttachments,
      itemCount: progress.totalCards + progress.totalAttachments,
      lastSyncedAt: new Date(),
      metadata: JSON.stringify({
        syncedAt: new Date().toISOString(),
        boardCount: progress.processedBoards,
        cardCount: progress.totalCards,
        commentCount: progress.totalComments,
        attachmentCount: progress.totalAttachments,
      }),
    };
    await db.update(evidenceSources).set(sourceValues).where(and(
      eq(evidenceSources.id, sourceId),
      eq(evidenceSources.userId, userId),
    ));

    return progress;
  } catch (error) {
    console.error('[Trello] Sync failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    try {
      await db.update(evidenceSources).set({
        connectionStatus: 'error',
        status: 'error',
        errorMessage: error instanceof ProviderBatchLimitError ? error.message : 'Trello sync failed',
      }).where(and(
        eq(evidenceSources.id, sourceId),
        eq(evidenceSources.userId, userId),
      ));
    } catch {
      console.error('[Trello] Failed to persist sync failure status');
    }
    progress.errors.push(error instanceof ProviderBatchLimitError ? error.message : 'Trello sync failed');
    throw error;
  }
}
