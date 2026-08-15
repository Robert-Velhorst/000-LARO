/**
 * Trello Router
 * Provides tRPC procedures for Trello integration
 * - OAuth URL generation
 * - Board listing
 * - Sync procedures
 * - Connection management
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { getDb } from '../db';
import { evidenceSources } from '../schema';
import { eq, and } from 'drizzle-orm';
import { assertCaseOwnership } from '../_core/authz';
import {
  getTrelloAuthorizationUrl,
  getTrelloBoards,
  getTrelloLists,
  getTrelloCards,
  testTrelloConnection,
  syncTrelloForCase,
} from '../trelloService';

/**
 * Trello Router
 * Handles Trello OAuth and evidence collection
 * 
 * Features:
 * - OAuth authorization
 * - Board/List/Card listing
 * - Card and comment sync
 * - Attachment extraction
 */
export const trelloEnhancedRouter = router({
  /**
   * Get Trello OAuth authorization URL
   */
  getOAuthUrl: protectedProcedure
    .input(
      z.object({
        caseId: z.string(),
      })
    )
    .mutation(async () => {
      throw new Error('Trello OAuth is not available until secure token storage is implemented.');
    }),

  /**
   * Get Trello connection status for a case
   */
  getStatus: protectedProcedure
    .input(z.object({ caseId: z.string().optional() }).optional())
    .query(async ({ input, ctx }) => {
      try {
        const db = await getDb();
        if (!db) {
          return {
            connected: false,
            itemCount: 0,
            lastSyncedAt: null,
            lastSync: null,
          };
        }

        const conditions = [
          eq(evidenceSources.userId, ctx.user.id),
          eq(evidenceSources.sourceType, 'Trello'),
        ];

        if (input?.caseId) {
          conditions.push(eq(evidenceSources.caseId, input.caseId));
        }

        // Get Trello connection for current user
        const sources = await db
          .select()
          .from(evidenceSources)
          .where(and(...conditions))
          .limit(1);

        if (sources.length === 0) {
          return {
            connected: false,
            itemCount: 0,
            lastSyncedAt: null,
            lastSync: null,
          };
        }

        const source = sources[0];
        const metadata = source.metadata ? JSON.parse(source.metadata) : {};
        const lastSyncedAt = metadata.syncedAt ? new Date(metadata.syncedAt) : null;

        return {
          connected:
            source.status !== 'disconnected' &&
            (source.status === 'connected' ||
              source.status === 'synced' ||
              source.status === 'imported'),
          itemCount: metadata.cardCount || 0,
          lastSyncedAt,
          lastSync: lastSyncedAt,
        };
      } catch (error) {
        console.error('[Trello] Error getting status:', error);
        return {
          connected: false,
          itemCount: 0,
          lastSyncedAt: null,
          lastSync: null,
        };
      }
    }),

  /**
   * List Trello boards for authenticated user
   */
  listBoards: protectedProcedure
    .input(
      z.object({
        caseId: z.string(),
        token: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        const boards = await getTrelloBoards(input.token);
        
        return {
          success: true,
          boards,
          count: boards.length,
        };
      } catch (error) {
        console.error('[Trello] Error listing boards:', error);
        throw new Error(`Failed to list Trello boards: ${error}`);
      }
    }),

  /**
   * List Trello lists for a board
   */
  listLists: protectedProcedure
    .input(
      z.object({
        caseId: z.string(),
        boardId: z.string(),
        token: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        const lists = await getTrelloLists(input.boardId, input.token);
        
        return {
          success: true,
          lists,
          count: lists.length,
        };
      } catch (error) {
        console.error('[Trello] Error listing lists:', error);
        throw new Error(`Failed to list Trello lists: ${error}`);
      }
    }),

  /**
   * List Trello cards for a list
   */
  listCards: protectedProcedure
    .input(
      z.object({
        caseId: z.string(),
        boardId: z.string(),
        listId: z.string(),
        token: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        const cards = await getTrelloCards(input.listId, input.boardId, input.token);
        
        return {
          success: true,
          cards,
          count: cards.length,
        };
      } catch (error) {
        console.error('[Trello] Error listing cards:', error);
        throw new Error(`Failed to list Trello cards: ${error}`);
      }
    }),

  /**
   * Sync Trello boards and cards for a case
   */
  syncBoards: protectedProcedure
    .input(
      z.object({
        caseId: z.string(),
        token: z.string(),
        boardIds: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        const db = await getDb();
        if (!db) {
          throw new Error('Database not available');
        }

        // Verify case ownership
        const progress = await syncTrelloForCase(
          ctx.user.id,
          input.caseId,
          input.token,
          input.boardIds
        );

        return {
          success: true,
          progress,
        };
      } catch (error) {
        console.error('[Trello] Error syncing boards:', error);
        throw new Error(`Failed to sync Trello boards: ${error}`);
      }
    }),

  /**
   * Test Trello connection
   */
  testConnection: protectedProcedure
    .input(
      z.object({
        token: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      try {
        const result = await testTrelloConnection(input.token);
        
        if (!result.ok) {
          throw new Error(result.error || 'Connection test failed');
        }

        return {
          success: true,
          member: result.member,
        };
      } catch (error) {
        console.error('[Trello] Error testing connection:', error);
        throw new Error(`Failed to test Trello connection: ${error}`);
      }
    }),

  /**
   * Disconnect Trello from a case
   */
  disconnect: protectedProcedure
    .input(
      z.object({
        caseId: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        const db = await getDb();
        if (!db) {
          throw new Error('Database not available');
        }

        // Delete Trello connection for this case
        await db
          .delete(evidenceSources)
          .where(
            and(
              eq(evidenceSources.caseId, input.caseId),
              eq(evidenceSources.sourceType, 'Trello')
            )
          );

        return {
          success: true,
        };
      } catch (error) {
        console.error('[Trello] Error disconnecting:', error);
        throw new Error(`Failed to disconnect Trello: ${error}`);
      }
    }),
});
