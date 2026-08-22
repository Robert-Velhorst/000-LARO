import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';
import { getDb } from '../db';
import { emailAccounts, evidenceSources } from '../schema';
import { eq, and, inArray } from 'drizzle-orm';
import { ENV } from '../_core/env';
import { beginOAuthFlowAsync } from '../oauth2';
import { revokeStoredGoogleTokens } from '../emailOAuth';
import { TRPCError } from '@trpc/server';
import { AUDIT_ACTIONS, createAuditLog, writeAuditLogOrThrow } from '../audit';

/**
 * Phase 012 — external provider reality review.
 *
 * getOAuthUrl no longer returns a blanket dummy auth URL for every provider.
 * It reports the provider's REAL availability:
 *  - Google-backed providers (Gmail, Google Drive) require GOOGLE_CLIENT_ID/SECRET.
 *  - Microsoft-backed providers remain unavailable until their collectors are implemented.
 *  - Slack is not implemented.
 * When a provider is unconfigured or unsupported, the response is
 * `{ success: false, available: false, reason }` so the UI can show an honest
 * "not available / needs configuration" state instead of a broken connect button.
 */
type ProviderConfig = { configured: boolean; connectPath?: string; reason?: string };

function providerAvailability(providerName: string): ProviderConfig {
  const p = providerName.toLowerCase();
  const googleReady = !!(ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET);
  const msReady = !!(ENV.MICROSOFT_CLIENT_ID && ENV.MICROSOFT_CLIENT_SECRET);
  switch (p) {
    case 'gmail':
    case 'googledrive':
      return googleReady
        ? { configured: true, connectPath: 'gmail' }
        : { configured: false, reason: 'Google OAuth is not configured (GOOGLE_CLIENT_ID/SECRET missing).' };
    case 'outlook':
    case 'onedrive':
      return {
        configured: false,
        reason: msReady
          ? 'Microsoft evidence collection is not release-capable yet; no account was connected.'
          : 'Microsoft evidence collection is unavailable and its OAuth credentials are not configured.',
      };
    case 'slack':
    default:
      return { configured: false, reason: `${providerName} integration is not implemented yet.` };
  }
}

const createEnhancedConnectionRouter = (providerName: string) => {
  return router({
    getStatus: protectedProcedure
      .input(z.object({ caseId: z.string().optional() }).optional())
      .query(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });
        }

        const oauthProvider = providerName === 'Gmail' || providerName === 'GoogleDrive'
          ? 'gmail'
          : providerName === 'Outlook' || providerName === 'OneDrive'
            ? 'outlook'
            : null;
        if (oauthProvider) {
          const accounts = await db.select().from(emailAccounts).where(and(
            eq(emailAccounts.userId, ctx.user.id),
            eq(emailAccounts.provider, oauthProvider),
            eq(emailAccounts.status, 'connected'),
          ));
          const account = accounts[0];
          return {
            connected: accounts.length > 0,
            accountCount: accounts.length,
            email: account?.email ?? undefined,
            displayName: account?.displayName ?? undefined,
            lastSync: account?.connectedAt ?? undefined,
          };
        }

        const conditions = [
          eq(evidenceSources.userId, ctx.user.id),
          eq(evidenceSources.sourceType, providerName)
        ];
        if (input?.caseId) conditions.push(eq(evidenceSources.caseId, input.caseId));

        const sources = await db.select().from(evidenceSources).where(and(...conditions)).limit(1);
        if (sources.length === 0) return { connected: false };

        const source = sources[0];
        return {
          connected: source.status === 'connected',
          itemCount: source.itemCount || 0,
          lastSync: source.lastSyncedAt,
        };
      }),

    getOAuthUrl: protectedProcedure
      .mutation(async ({ ctx }) => {
        const avail = providerAvailability(providerName);
        if (!avail.configured || !avail.connectPath) {
          // Honest unavailability — no fake auth URL.
          return {
            success: false as const,
            available: false as const,
            reason: avail.reason ?? `${providerName} is not available.`,
          };
        }
        return {
          success: true as const,
          available: true as const,
          authUrl: await beginOAuthFlowAsync(avail.connectPath as 'gmail' | 'outlook', ctx.user.id),
        };
      }),

    disconnect: protectedProcedure
      .mutation(async ({ ctx }) => {
        try {
          const db = await getDb();
          if (db) {
            const oauthProvider = providerName === 'Gmail' || providerName === 'GoogleDrive'
              ? 'gmail'
              : providerName === 'Outlook' || providerName === 'OneDrive'
                ? 'outlook'
                : null;
            if (oauthProvider) {
              const accounts = await db.select().from(emailAccounts).where(
                and(eq(emailAccounts.userId, ctx.user.id), eq(emailAccounts.provider, oauthProvider))
              );
              const revocationOutcomes: string[] = [];
              if (oauthProvider === 'gmail') {
                try {
                  for (const account of accounts) {
                    revocationOutcomes.push(await revokeStoredGoogleTokens(account));
                  }
                } catch (error) {
                  await createAuditLog({
                    userId: ctx.user.id,
                    action: AUDIT_ACTIONS.PROVIDER_DISCONNECT_FAILED,
                    entityType: 'provider_connection',
                    entityId: 'google',
                    details: {
                      provider: 'google',
                      route: `${providerName}.disconnect`,
                      accountCount: accounts.length,
                      reason: 'upstream_revocation_failed',
                      localStateRetained: true,
                    },
                  });
                  throw new TRPCError({
                    code: 'PRECONDITION_FAILED',
                    message: 'Google did not confirm token revocation; the local connection was retained so disconnect can be retried.',
                    cause: error,
                  });
                }
              }
              const sharedSources = oauthProvider === 'gmail'
                ? ['Gmail', 'GoogleDrive']
                : ['Outlook', 'OneDrive'];
              const revocationConfirmed = revocationOutcomes.some(
                (outcome) => outcome === 'revoked' || outcome === 'already_invalid'
              );
              db.transaction((tx: any) => {
                tx.delete(emailAccounts).where(
                  and(eq(emailAccounts.userId, ctx.user.id), eq(emailAccounts.provider, oauthProvider))
                ).run();
                tx.delete(evidenceSources).where(
                  and(
                    eq(evidenceSources.userId, ctx.user.id),
                    inArray(evidenceSources.sourceType, sharedSources),
                  )
                ).run();
                writeAuditLogOrThrow(tx, {
                  userId: ctx.user.id,
                  action: revocationConfirmed
                    ? AUDIT_ACTIONS.PROVIDER_DISCONNECT_REVOKED
                    : AUDIT_ACTIONS.PROVIDER_DISCONNECTED,
                  entityType: 'provider_connection',
                  entityId: oauthProvider === 'gmail' ? 'google' : oauthProvider,
                  details: {
                    provider: oauthProvider === 'gmail' ? 'google' : oauthProvider,
                    route: `${providerName}.disconnect`,
                    accountCount: accounts.length,
                    revocationOutcomes: oauthProvider === 'gmail' ? revocationOutcomes : ['not_applicable'],
                    localCredentialsRemoved: true,
                    localSourcesRemoved: true,
                  },
                });
              });
              return { success: true };
            }
            await db.delete(evidenceSources).where(
              and(
                eq(evidenceSources.userId, ctx.user.id),
                eq(evidenceSources.sourceType, providerName)
              )
            );
          }
          return { success: true };
        } catch (error) {
          if (error instanceof TRPCError) throw error;
          throw new Error(`Failed to disconnect ${providerName}`);
        }
      }),
  });
};

export const gmailEnhancedRouter = createEnhancedConnectionRouter('Gmail');
export const outlookEnhancedRouter = createEnhancedConnectionRouter('Outlook');
export const googleDriveEnhancedRouter = createEnhancedConnectionRouter('GoogleDrive');
export const oneDriveEnhancedRouter = createEnhancedConnectionRouter('OneDrive');
export const slackEnhancedRouter = createEnhancedConnectionRouter('Slack');
