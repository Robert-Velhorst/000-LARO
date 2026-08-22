/**
 * Trello Router
 * Provides tRPC procedures for Trello integration
 * - Explicit OAuth-unavailable status
 * - Board listing
 * - Sync procedures
 * - Connection management
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../_core/trpc';
import { getDb } from '../db';
import { evidenceSources } from '../schema';
import { eq, and, inArray } from 'drizzle-orm';
import { assertCaseOwnership } from '../_core/authz';
import {
  getTrelloBoards,
  getTrelloLists,
  getTrelloCards,
  testTrelloConnection,
  syncTrelloForCase,
} from '../trelloService';
import { PROVIDER_LIMITS, ProviderBatchLimitError } from '../providerLimits';
import { enforcePersistentRateLimit, RATE_LIMITS } from '../rateLimit';
import { withByteReadAdmission } from '../boundedBytes';

const trelloId = z.string().trim().min(1).max(256);
const trelloToken = z.string().trim().min(1).max(2_048);
const caseId = z.string().trim().min(1).max(128);

function trelloRouterError(error: unknown, operation: string): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof ProviderBatchLimitError) {
    return new TRPCError({ code: 'BAD_REQUEST', message: error.message });
  }
  console.error('[Trello] Operation failed', {
    operation,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `Failed to ${operation}` });
}

/**
 * Trello Router
 * Handles token-scoped Trello evidence collection
 * 
 * Features:
 * - Explicit OAuth-unavailable response
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
        caseId,
      })
    )
    .mutation(async () => {
      throw new Error('Trello OAuth is not available until secure token storage is implemented.');
    }),

  /**
   * Get Trello connection status for a case
   */
  getStatus: protectedProcedure
    .input(z.object({ caseId: caseId.optional() }).optional())
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
          inArray(evidenceSources.sourceType, ['trello', 'Trello', 'Board']),
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
        caseId,
        token: trelloToken,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        await enforcePersistentRateLimit(ctx, 'trello-provider', RATE_LIMITS.providerOperation);
        const boards = await withByteReadAdmission(() => getTrelloBoards(input.token));
        
        return {
          success: true,
          boards,
          count: boards.length,
        };
      } catch (error) {
        throw trelloRouterError(error, 'list Trello boards');
      }
    }),

  /**
   * List Trello lists for a board
   */
  listLists: protectedProcedure
    .input(
      z.object({
        caseId,
        boardId: trelloId,
        token: trelloToken,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        await enforcePersistentRateLimit(ctx, 'trello-provider', RATE_LIMITS.providerOperation);
        const lists = await withByteReadAdmission(() => getTrelloLists(input.boardId, input.token));
        
        return {
          success: true,
          lists,
          count: lists.length,
        };
      } catch (error) {
        throw trelloRouterError(error, 'list Trello lists');
      }
    }),

  /**
   * List Trello cards for a list
   */
  listCards: protectedProcedure
    .input(
      z.object({
        caseId,
        boardId: trelloId,
        listId: trelloId,
        token: trelloToken,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        await enforcePersistentRateLimit(ctx, 'trello-provider', RATE_LIMITS.providerOperation);
        const cards = await withByteReadAdmission(() => getTrelloCards(input.listId, input.boardId, input.token));
        
        return {
          success: true,
          cards,
          count: cards.length,
        };
      } catch (error) {
        throw trelloRouterError(error, 'list Trello cards');
      }
    }),

  /**
   * Sync Trello boards and cards for a case
   */
  syncBoards: protectedProcedure
    .input(
      z.object({
        caseId,
        token: trelloToken,
        boardIds: z.array(trelloId).max(PROVIDER_LIMITS.trello.maxSyncBoards).optional(),
      }).superRefine((value, ctx) => {
        if (value.boardIds && new Set(value.boardIds).size !== value.boardIds.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate Trello board IDs are not allowed.' });
        }
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await assertCaseOwnership(input.caseId, ctx.user.id);
        await enforcePersistentRateLimit(ctx, 'trello-sync', RATE_LIMITS.bulkImport);
        const db = await getDb();
        if (!db) {
          throw new Error('Database not available');
        }

        // Verify case ownership
        const progress = await withByteReadAdmission(() => syncTrelloForCase(
          ctx.user.id,
          input.caseId,
          input.token,
          input.boardIds
        ));

        return {
          success: true,
          progress,
        };
      } catch (error) {
        throw trelloRouterError(error, 'sync Trello boards');
      }
    }),

  /**
   * Test Trello connection
   */
  testConnection: protectedProcedure
    .input(
      z.object({
        token: trelloToken,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await enforcePersistentRateLimit(ctx, 'trello-provider', RATE_LIMITS.providerOperation);
        const result = await withByteReadAdmission(() => testTrelloConnection(input.token));
        
        if (!result.ok) {
          throw new Error(result.error || 'Connection test failed');
        }

        return {
          success: true,
          member: result.member,
        };
      } catch (error) {
        throw trelloRouterError(error, 'test Trello connection');
      }
    }),

  /**
   * Disconnect Trello from a case
   */
  disconnect: protectedProcedure
    .input(
      z.object({
        caseId,
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
              eq(evidenceSources.userId, ctx.user.id),
              inArray(evidenceSources.sourceType, ['trello', 'Trello', 'Board'])
            )
          );

        return {
          success: true,
        };
      } catch (error) {
        throw trelloRouterError(error, 'disconnect Trello');
      }
    }),
});
