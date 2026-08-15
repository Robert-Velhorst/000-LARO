/**
 * Trello Service
 * Integrates with Trello API for OAuth and board/card data access
 * Supports board listing, card extraction, and comment collection
 */

import { storagePut } from './storage';
import { getDb } from './db';
import { evidenceSources, evidenceItems } from './schema';
import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';
import { fetchTrustedRemote } from './trustedRemoteFetch';

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
export async function getTrelloBoards(token: string): Promise<TrelloBoard[]> {
  const config = getTrelloOAuthConfig();

  try {
    const response = await fetch(
      `https://api.trello.com/1/members/me/boards?key=${config.apiKey}&token=${token}&fields=id,name,url,desc`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('[Trello] Failed to fetch boards:', error);
      throw new Error(`Failed to fetch Trello boards: ${error}`);
    }

    const boards = await response.json();
    return boards;
  } catch (error) {
    console.error('[Trello] Error fetching boards:', error);
    throw error;
  }
}

/**
 * Get lists for a Trello board
 */
export async function getTrelloLists(boardId: string, token: string): Promise<TrelloList[]> {
  const config = getTrelloOAuthConfig();

  try {
    const response = await fetch(
      `https://api.trello.com/1/boards/${boardId}/lists?key=${config.apiKey}&token=${token}&fields=id,name`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('[Trello] Failed to fetch lists:', error);
      throw new Error(`Failed to fetch Trello lists: ${error}`);
    }

    const lists = await response.json();
    return lists.map((list: any) => ({
      ...list,
      boardId,
    }));
  } catch (error) {
    console.error('[Trello] Error fetching lists:', error);
    throw error;
  }
}

/**
 * Get cards for a Trello list
 */
export async function getTrelloCards(listId: string, boardId: string, token: string): Promise<TrelloCard[]> {
  const config = getTrelloOAuthConfig();

  try {
    const response = await fetch(
      `https://api.trello.com/1/lists/${listId}/cards?key=${config.apiKey}&token=${token}&fields=id,name,desc,url,dateLastActivity&attachments=open`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('[Trello] Failed to fetch cards:', error);
      throw new Error(`Failed to fetch Trello cards: ${error}`);
    }

    const cards = await response.json();
    return cards.map((card: any) => ({
      ...card,
      listId,
      boardId,
    }));
  } catch (error) {
    console.error('[Trello] Error fetching cards:', error);
    throw error;
  }
}

/**
 * Get comments for a Trello card
 */
export async function getTrelloComments(cardId: string, token: string): Promise<TrelloComment[]> {
  const config = getTrelloOAuthConfig();

  try {
    const response = await fetch(
      `https://api.trello.com/1/cards/${cardId}/actions?key=${config.apiKey}&token=${token}&filter=commentCard&fields=id,data,type,date,memberCreator`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('[Trello] Failed to fetch comments:', error);
      throw new Error(`Failed to fetch Trello comments: ${error}`);
    }

    const actions = await response.json();
    return actions.map((action: any) => ({
      id: action.id,
      text: action.data?.text || '',
      memberCreator: action.memberCreator,
      date: action.date,
    }));
  } catch (error) {
    console.error('[Trello] Error fetching comments:', error);
    throw error;
  }
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
    console.error('[Trello] Error downloading attachment:', error);
    return null;
  }
}

/**
 * Test Trello connection
 */
export async function testTrelloConnection(token: string): Promise<{ ok: boolean; member?: any; error?: string }> {
  const config = getTrelloOAuthConfig();

  try {
    const response = await fetch(
      `https://api.trello.com/1/members/me?key=${config.apiKey}&token=${token}&fields=id,fullName,email`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      return { ok: false, error };
    }

    const member = await response.json();
    return { ok: true, member };
  } catch (error) {
    return { ok: false, error: String(error) };
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

  try {
    // Get all boards
    let boards = await getTrelloBoards(token);

    // Filter by boardIds if provided
    if (boardIds && boardIds.length > 0) {
      boards = boards.filter(b => boardIds.includes(b.id));
    }

    progress.totalBoards = boards.length;

    // Process each board
    for (const board of boards) {
      try {
        // Get lists for this board
        const lists = await getTrelloLists(board.id, token);

        // Process each list
        for (const list of lists) {
          // Get cards for this list
          const cards = await getTrelloCards(list.id, board.id, token);
          progress.totalCards += cards.length;

          // Process each card
          for (const card of cards) {
            try {
              // Get comments for this card
              const comments = await getTrelloComments(card.id, token);
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
                source: "Trello",
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
                    const result = await downloadTrelloAttachment(attachment.url, attachment.name, { token });
                    if (result) {
                      progress.totalAttachments++;

                      // Store attachment metadata
                      await db.insert(evidenceItems).values({
                        id: uuidv4(),
                        caseId,
                        userId,
                        title: `Attachment: ${attachment.name}`,
                        source: "Trello",
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
                    progress.errors.push(`Failed to download attachment ${attachment.name}: ${error}`);
                  }
                }
              }
            } catch (error) {
              progress.errors.push(`Failed to process card ${card.name}: ${error}`);
            }
          }
        }

        progress.processedBoards++;
      } catch (error) {
        progress.errors.push(`Failed to process board ${board.name}: ${error}`);
      }
    }

    // Update evidence source
    await db.insert(evidenceSources).values({
      id: uuidv4(),
      caseId,
      userId,
      provider: 'Trello',
      sourceType: 'Board',
      status: 'connected',
      metadata: JSON.stringify({
        syncedAt: new Date().toISOString(),
        boardCount: progress.processedBoards,
        cardCount: progress.totalCards,
        commentCount: progress.totalComments,
        attachmentCount: progress.totalAttachments,
      }),
    });

    return progress;
  } catch (error) {
    console.error('[Trello] Sync error:', error);
    progress.errors.push(String(error));
    throw error;
  }
}
