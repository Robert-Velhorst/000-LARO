/**
 * Telegram Enhanced Router
 * 
 * NOTE: Telegram Bot API limitations:
 * - Cannot access historical messages before bot joins
 * - No official bulk export API
 * - Users must export via Telegram Desktop and upload JSON
 * 
 * Procedures:
 * - Import chat exports from Telegram Desktop
 * - Manage bot tokens
 * - Download files
 * - Webhook management
 */

import { protectedProcedure, router } from '../_core/trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  getTelegramFile,
  downloadTelegramFile,
  getTelegramBotInfo,
  setTelegramWebhook,
  removeTelegramWebhook,
  importTelegramExport,
  isValidTelegramToken,
} from '../telegramService';
import { getDb } from '../db';
import { cases, evidenceItems, evidenceSources } from '../schema';
import { eq, and, sql } from 'drizzle-orm';
import { IMPORT_LIMITS, ImportValidationError, normalizeTelegramExport } from '../importLimits';
import { enforcePersistentRateLimit, RATE_LIMITS } from '../rateLimit';
import { withByteReadAdmission } from '../boundedBytes';

const telegramToken = z.string().trim().min(1).max(256);

/**
 * Telegram Enhanced Router
 */
export const telegramEnhancedRouter = router({
  /**
   * Validate bot token
   */
  validateToken: protectedProcedure
    .input(
      z.object({
        token: telegramToken,
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!isValidTelegramToken(input.token)) {
        return {
          valid: false,
          error: 'Invalid token format. Expected: 123456789:ABCdefGHIjklmnoPQRstuvWXYZ',
        };
      }
      await enforcePersistentRateLimit(ctx, 'telegram-provider', RATE_LIMITS.providerOperation);
      try {

        const botInfo = await withByteReadAdmission(() => getTelegramBotInfo(input.token));

        return {
          valid: true,
          botName: botInfo.first_name,
          botUsername: botInfo.username,
          botId: botInfo.id,
        };
      } catch (error) {
        return {
          valid: false,
          error: error instanceof Error ? error.message : 'Telegram token validation failed',
        };
      }
    }),

  /**
   * Get bot status
   */
  getStatus: protectedProcedure
    .query(async ({ ctx }) => {
      try {
        const db = await getDb();
        if (!db) {
          return {
            connected: false,
            lastSync: null,
            lastSyncedAt: null,
            itemCount: 0,
          };
        }

        const sources = await db
          .select()
          .from(evidenceSources)
          .where(
            and(
              eq(evidenceSources.userId, ctx.user.id),
              eq(evidenceSources.sourceType, 'telegram'),
            )
          )
          .limit(1);

        if (sources.length === 0) {
          return {
            connected: false,
            lastSync: null,
            lastSyncedAt: null,
            itemCount: 0,
          };
        }

        const source = sources[0];
        const lastSyncedAt =
          source.lastSyncedAt ? new Date(source.lastSyncedAt) : null;

        const itemCountResult = await db
          .select({ count: sql<number>`count(*)` })
          .from(evidenceItems)
          .where(and(eq(evidenceItems.userId, ctx.user.id), eq(evidenceItems.sourceId, source.id)));

        const itemCount = itemCountResult[0]?.count ?? 0;

        const connected =
          source.connectionStatus !== 'disconnected' &&
          (source.connectionStatus === 'connected' ||
            source.connectionStatus === 'imported' ||
            source.connectionStatus === 'synced');

        return {
          connected,
          lastSync: lastSyncedAt,
          lastSyncedAt,
          itemCount,
        };
      } catch (error) {
        throw error;
      }
    }),

  /**
   * Set webhook for receiving messages
   */
  setWebhook: protectedProcedure
    .input(
      z.object({
        token: telegramToken,
        webhookUrl: z.string().trim().url().max(2_048),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await enforcePersistentRateLimit(ctx, 'telegram-provider', RATE_LIMITS.providerOperation);
        const result = await withByteReadAdmission(() => setTelegramWebhook(input.token, input.webhookUrl));
        return result;
      } catch (error) {
        throw error;
      }
    }),

  /**
   * Remove webhook
   */
  removeWebhook: protectedProcedure
    .input(
      z.object({
        token: telegramToken,
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await enforcePersistentRateLimit(ctx, 'telegram-provider', RATE_LIMITS.providerOperation);
        const result = await withByteReadAdmission(() => removeTelegramWebhook(input.token));
        return result;
      } catch (error) {
        throw error;
      }
    }),

  /**
   * Import Telegram chat export
   * 
   * Users must export via Telegram Desktop:
   * 1. Right-click chat
   * 2. Select "Export chat history"
   * 3. Choose JSON format
   * 4. Upload the file to LARO
   */
  importExport: protectedProcedure
    .input(
      z.object({
        caseId: z.string().min(1).max(128),
        fileName: z.string().max(IMPORT_LIMITS.telegram.maxFilenameChars),
        exportJson: z.string().max(IMPORT_LIMITS.telegram.maxBytes),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await enforcePersistentRateLimit(ctx, 'telegram-import', RATE_LIMITS.bulkImport);
        const db = await getDb();
        if (!db) {
          throw new Error('Database not available');
        }

        // Verify user owns the case
        const caseRecord = await db
          .select()
          .from(cases)
          .where(and(eq(cases.id, input.caseId), eq(cases.userId, ctx.user.id)))
          .limit(1);

        if (caseRecord.length === 0) {
          throw new Error('Case not found or you do not have access');
        }

        let normalized: ReturnType<typeof normalizeTelegramExport>;
        try {
          normalized = normalizeTelegramExport(input.exportJson, input.fileName);
        } catch (error) {
          if (error instanceof ImportValidationError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
          }
          throw error;
        }

        // Import to evidence system
        const result = await importTelegramExport(
          ctx.user.id,
          input.caseId,
          normalized.chat,
          normalized.filename
        );

        return result;
      } catch (error) {
        throw error;
      }
    }),

  /**
   * Download file from Telegram
   */
  downloadFile: protectedProcedure
    .input(
      z.object({
        token: telegramToken,
        fileId: z.string().trim().min(1).max(512),
      })
    )
    .mutation(async ({ input, ctx }) => {
      try {
        await enforcePersistentRateLimit(ctx, 'telegram-provider', RATE_LIMITS.providerOperation);
        const { fileInfo, buffer } = await withByteReadAdmission(async () => {
          const fileInfo = await getTelegramFile(input.token, input.fileId);
          const buffer = await downloadTelegramFile(input.token, fileInfo.file_path);
          return { fileInfo, buffer };
        });

        return {
          success: true,
          fileName: fileInfo.file_path.split('/').pop(),
          size: buffer.length,
          mimeType: 'application/octet-stream',
        };
      } catch (error) {
        throw error;
      }
    }),

  /**
   * Get export instructions
   */
  getExportInstructions: protectedProcedure.query(() => {
    return {
      title: 'How to Export Telegram Chat History',
      instructions: [
        {
          step: 1,
          title: 'Open Telegram Desktop',
          description: 'Make sure you have Telegram Desktop installed (not the web version)',
        },
        {
          step: 2,
          title: 'Select Chat',
          description: 'Right-click on the chat you want to export',
        },
        {
          step: 3,
          title: 'Export Chat History',
          description: 'Click "Export chat history" from the context menu',
        },
        {
          step: 4,
          title: 'Choose JSON Format',
          description: 'In the export dialog, select "JSON" as the export format',
        },
        {
          step: 5,
          title: 'Select Date Range',
          description: 'Choose the date range for the export (optional)',
        },
        {
          step: 6,
          title: 'Export',
          description: 'Click "Export" and wait for the file to be generated',
        },
        {
          step: 7,
          title: 'Upload to LARO',
          description: 'Upload the JSON file to LARO using the import function',
        },
      ],
      limitations: [
        'Telegram Bot API cannot access messages before the bot joins',
        'This is a Telegram API limitation, not a LARO limitation',
        'For full chat history, use Telegram Desktop export (JSON)',
        'Media files are referenced in the export but must be downloaded separately',
      ],
      supportedMediaTypes: [
        'Text messages',
        'Photos',
        'Videos',
        'Audio files',
        'Documents',
        'Voice messages',
        'Stickers',
        'Reactions',
      ],
    };
  }),

  /**
   * Get limitations info
   */
  getLimitations: protectedProcedure.query(() => {
    return {
      title: 'Telegram Integration Limitations',
      limitations: [
        {
          title: 'No Historical Access',
          description:
            'Telegram Bot API cannot access messages sent before the bot joins the chat',
          workaround: 'Export chat history via Telegram Desktop (JSON format)',
        },
        {
          title: 'No Bulk Export API',
          description: 'Telegram does not provide an official API for bulk message export',
          workaround: 'Use Telegram Desktop built-in export feature',
        },
        {
          title: 'Rate Limits',
          description: '30 messages/second to different chats, 1 message/second to same chat',
          workaround: 'LARO queues concurrent reads and limits provider requests per user',
        },
        {
          title: 'File Size Limit',
          description: 'Maximum 7 MB per file for downloads into LARO evidence',
          workaround: 'Split large files before sending to Telegram',
        },
      ],
      recommendedApproach:
        'Use Telegram Desktop export for historical data, and Bot API for real-time monitoring',
    };
  }),
});
