/**
 * Telegram Integration Service
 * 
 * NOTE: Telegram Bot API has limitations:
 * - Cannot access chat history before bot joins
 * - No official bulk export API
 * - Users must export via Telegram Desktop and upload JSON
 * 
 * This service handles:
 * - Bot token management
 * - Message receiving (via webhook or polling)
 * - File download
 * - Chat export import
 */

import axios from 'axios';
import { getDb } from './db';
import { cases, evidenceSources, evidenceItems } from './schema';
import { v4 as uuidv4 } from 'uuid';
import { and, eq } from 'drizzle-orm';
import {
  normalizeTelegramExport,
  type TelegramExportedChat,
} from './importLimits';

export type { TelegramExportedChat } from './importLimits';

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: string;
    title?: string;
  };
  from?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  text?: string;
  caption?: string;
  document?: {
    file_id: string;
    file_unique_id: string;
    file_size: number;
    mime_type: string;
    file_name?: string;
  };
  photo?: Array<{
    file_id: string;
    file_size: number;
    width: number;
    height: number;
  }>;
  video?: {
    file_id: string;
    file_size: number;
    width: number;
    height: number;
    duration: number;
    mime_type: string;
  };
  voice?: {
    file_id: string;
    file_size: number;
    duration: number;
    mime_type: string;
  };
}

export interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size: number;
  file_path: string;
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function telegramFailureMetadata(error: unknown): { status: number | null; providerCode: number | null } {
  if (!axios.isAxiosError(error)) return { status: null, providerCode: null };
  const status = Number.isInteger(error.response?.status) ? error.response!.status : null;
  const data = error.response?.data;
  const rawCode = data && typeof data === 'object' && 'error_code' in data
    ? (data as { error_code?: unknown }).error_code
    : null;
  const providerCode = typeof rawCode === 'number' && Number.isInteger(rawCode) ? rawCode : null;
  return { status, providerCode };
}

function logTelegramFailure(operation: string, error: unknown): void {
  console.error('[Telegram] Operation failed', {
    operation,
    ...telegramFailureMetadata(error),
  });
}

function failTelegramRequest(operation: string, message: string, error: unknown): never {
  logTelegramFailure(operation, error);
  throw new Error(message);
}

/**
 * Get Telegram file info
 */
export async function getTelegramFile(
  botToken: string,
  fileId: string
): Promise<TelegramFile> {
  try {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/getFile`;
    const response = await axios.get(url, {
      params: { file_id: fileId },
    });

    if (!response.data.ok) {
      throw new Error(response.data.description || 'Failed to get file');
    }

    return response.data.result;
  } catch (error) {
    failTelegramRequest('getFile', 'Telegram file information request failed', error);
  }
}

/**
 * Download Telegram file
 */
export async function downloadTelegramFile(
  botToken: string,
  filePath: string
): Promise<Buffer> {
  try {
    const url = `${TELEGRAM_API_BASE}/file/bot${botToken}/${filePath}`;
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
    });

    return Buffer.from(response.data);
  } catch (error) {
    failTelegramRequest('downloadFile', 'Telegram file download request failed', error);
  }
}

/**
 * Get bot info
 */
export async function getTelegramBotInfo(botToken: string) {
  try {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/getMe`;
    const response = await axios.get(url);

    if (!response.data.ok) {
      throw new Error(response.data.description || 'Failed to get bot info');
    }

    return response.data.result;
  } catch (error) {
    failTelegramRequest('getBotInfo', 'Telegram bot information request failed', error);
  }
}

/**
 * Set webhook for receiving messages
 */
export async function setTelegramWebhook(
  botToken: string,
  webhookUrl: string
): Promise<{ success: boolean }> {
  try {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/setWebhook`;
    const response = await axios.post(url, {
      url: webhookUrl,
      allowed_updates: ['message'],
    });

    if (!response.data.ok) {
      throw new Error(response.data.description || 'Failed to set webhook');
    }

    return { success: true };
  } catch (error) {
    failTelegramRequest('setWebhook', 'Telegram webhook setup request failed', error);
  }
}

/**
 * Remove webhook
 */
export async function removeTelegramWebhook(
  botToken: string
): Promise<{ success: boolean }> {
  try {
    const url = `${TELEGRAM_API_BASE}/bot${botToken}/deleteWebhook`;
    const response = await axios.post(url);

    if (!response.data.ok) {
      throw new Error(response.data.description || 'Failed to delete webhook');
    }

    return { success: true };
  } catch (error) {
    failTelegramRequest('removeWebhook', 'Telegram webhook removal request failed', error);
  }
}

/**
 * Import Telegram chat export (JSON from Telegram Desktop)
 * 
 * Users must export via Telegram Desktop:
 * 1. Right-click chat
 * 2. Select "Export chat history"
 * 3. Choose JSON format
 * 4. Upload the file to LARO
 */
export async function importTelegramExport(
  userId: string,
  caseId: string,
  exportData: TelegramExportedChat,
  fileName: string
): Promise<{ success: boolean; messagesImported: number; filesFound: number }> {
  try {
    const db = await getDb();
    if (!db) {
      throw new Error('Database not available');
    }

    // Revalidate callers outside the router before opening a transaction.
    const normalized = normalizeTelegramExport(JSON.stringify(exportData), fileName);
    const chat = normalized.chat;
    const sourceId = uuidv4();
    let filesFound = 0;
    const now = new Date();

    db.transaction((tx) => {
      const ownedCase = tx.select({ id: cases.id })
        .from(cases)
        .where(and(eq(cases.id, caseId), eq(cases.userId, userId)))
        .get();
      if (!ownedCase) throw new Error('Case not found or access denied');

      tx.insert(evidenceSources).values({
        id: sourceId,
        caseId,
        userId,
        provider: 'telegram',
        sourceType: 'telegram',
        externalId: `${chat.name} (${chat.id})`,
        sourceIdentifier: normalized.filename,
        connectionStatus: 'imported',
        status: 'imported',
        itemsCollected: chat.messages.length,
        itemCount: chat.messages.length,
        lastSyncedAt: now,
        createdAt: now,
      }).run();

      for (const message of chat.messages) {
        const hasFile = Boolean(message.file || message.media_type);
        if (hasFile) filesFound++;
        const mediaLabel = message.media_type
          ? `[${message.media_type.toUpperCase()}] ${message.file || 'Media file'}`
          : message.file
            ? `[FILE] ${message.file}`
            : '';
        const content = message.text || mediaLabel;
        const timestamp = new Date(Number(message.date_unixtime) * 1000);

        tx.insert(evidenceItems).values({
          id: uuidv4(),
          caseId,
          userId,
          sourceId,
          source: 'telegram',
          sourceType: 'telegram',
          fileName: message.file,
          title: `Telegram message from ${message.from || 'Unknown'}`,
          type: message.media_type || 'message',
          content,
          relevanceScore: 50,
          timestamp,
          metadata: JSON.stringify({
            sourceId,
            messageId: message.id,
            date: message.date_unixtime,
            from: message.from,
            fromId: message.from_id,
            mediaType: message.media_type,
            fileName: message.file,
            mimeType: message.mime_type,
            relevanceScore: 50,
          }),
          createdAt: timestamp,
          updatedAt: now,
        }).run();
      }
    });

    return {
      success: true,
      messagesImported: chat.messages.length,
      filesFound,
    };
  } catch (error) {
    failTelegramRequest(
      'importExport',
      'The Telegram import could not be completed; no messages were added.',
      error,
    );
  }
}

/**
 * Parse Telegram Desktop export JSON
 */
export function parseTelegramExport(jsonContent: string): TelegramExportedChat {
  return normalizeTelegramExport(jsonContent, 'telegram-export.json').chat;
}

/**
 * Get Telegram connection status
 * 
 * Note: This is limited because Telegram Bot API doesn't provide
 * a way to check if bot has access to a chat
 */
export async function getTelegramStatus(
  botToken: string
): Promise<{
  connected: boolean;
  botName?: string;
  botUsername?: string;
  error?: string;
}> {
  try {
    const botInfo = await getTelegramBotInfo(botToken);

    return {
      connected: true,
      botName: botInfo.first_name,
      botUsername: botInfo.username,
    };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : 'Telegram connection could not be verified',
    };
  }
}

/**
 * Validate Telegram bot token format
 */
export function isValidTelegramToken(token: string): boolean {
  // Telegram bot tokens format: 123456789:ABCdefGHIjklmnoPQRstuvWXYZ
  const tokenRegex = /^\d+:[A-Za-z0-9_-]+$/;
  return tokenRegex.test(token);
}
