import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { emailAccounts, emailSyncJobs } from "../schema";
import { eq, and } from "drizzle-orm";
import {
  getAuthorizationUrlAsync,
  refreshAccessToken,
} from "../oauth2";
import { encryptToken, decryptToken, revokeStoredGoogleTokens } from "../emailOAuth";
import { AUDIT_ACTIONS, createAuditLog, writeAuditLogOrThrow } from "../audit";
import { SESSION_COOKIE_NAME } from "../sessionCookie";

export const emailAccountsRouter = router({
  getAuthUrl: protectedProcedure
    .input(z.object({ provider: z.literal("gmail") }))
    .mutation(async ({ input, ctx }) => ({
      authUrl: await getAuthorizationUrlAsync(
        input.provider,
        ctx.user.id,
        ctx.req.cookies?.[SESSION_COOKIE_NAME] || '',
      ),
    })),

  list: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select({
        id: emailAccounts.id,
        provider: emailAccounts.provider,
        email: emailAccounts.email,
        displayName: emailAccounts.displayName,
        status: emailAccounts.status,
        connectedAt: emailAccounts.connectedAt,
        tokenExpiry: emailAccounts.tokenExpiry,
        createdAt: emailAccounts.createdAt,
        updatedAt: emailAccounts.updatedAt,
      })
      .from(emailAccounts)
      .where(eq(emailAccounts.userId, ctx.user.id));
  }),

  refreshToken: protectedProcedure
    .input(z.object({ accountId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [acc] = await db
        .select()
        .from(emailAccounts)
        .where(and(eq(emailAccounts.id, input.accountId), eq(emailAccounts.userId, ctx.user.id)))
        .limit(1);
      if (!acc?.refreshToken) throw new Error("No refresh token");
      const refresh = decryptToken(acc.refreshToken);
      const next = await refreshAccessToken(acc.provider as "gmail" | "outlook", refresh);
      const refreshedAt = new Date();
      const tokenExpiry = new Date(refreshedAt.getTime() + next.expiresIn * 1000);
      try {
        db.transaction((tx: any) => {
          const update = tx.update(emailAccounts).set({
            accessToken: encryptToken(next.accessToken),
            refreshToken: next.refreshToken ? encryptToken(next.refreshToken) : acc.refreshToken,
            tokenExpiry,
            updatedAt: refreshedAt,
          }).where(and(eq(emailAccounts.id, acc.id), eq(emailAccounts.userId, ctx.user.id))).run();
          if (Number(update.changes || 0) !== 1) {
            throw new TRPCError({ code: "CONFLICT", message: "The provider connection changed while credentials were refreshing." });
          }
          writeAuditLogOrThrow(tx, {
            userId: ctx.user.id,
            action: AUDIT_ACTIONS.PROVIDER_CREDENTIALS_REFRESHED,
            entityType: "provider_connection",
            entityId: acc.id,
            details: {
              provider: acc.provider === "gmail" ? "google" : acc.provider,
              refreshGrantRotated: Boolean(next.refreshToken && next.refreshToken !== refresh),
              expiresAt: tokenExpiry.toISOString(),
            },
          });
        });
      } catch (error) {
        // The local transaction rolled back, but a provider may have rotated
        // the refresh grant already. Never claim a successful refresh here.
        console.error("[Provider][REFRESH_UNCERTAIN] Credential refresh was not durably saved", {
          accountId: acc.id,
          userId: ctx.user.id,
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Credential refresh could not be saved and audited. The provider may have rotated the grant; reconnect this account before relying on sync.",
          cause: error,
        });
      }
      return { success: true as const };
    }),

  revoke: protectedProcedure
    .input(z.object({ accountId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const [acc] = await db
        .select()
        .from(emailAccounts)
        .where(and(eq(emailAccounts.id, input.accountId), eq(emailAccounts.userId, ctx.user.id)))
        .limit(1);
      if (!acc) throw new Error("Not found");
      let revocationOutcome = "not_applicable";
      if (acc.provider === "gmail") {
        try {
          revocationOutcome = await revokeStoredGoogleTokens(acc);
        } catch (error) {
          await createAuditLog({
            userId: ctx.user.id,
            action: AUDIT_ACTIONS.PROVIDER_DISCONNECT_FAILED,
            entityType: "provider_connection",
            entityId: acc.id,
            details: {
              provider: "google",
              route: "emailAccounts.revoke",
              reason: "upstream_revocation_failed",
              localStateRetained: true,
            },
          });
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Google did not confirm token revocation; the local connection was retained so disconnect can be retried.",
            cause: error,
          });
        }
      }
      const revocationConfirmed = revocationOutcome === "revoked" || revocationOutcome === "already_invalid";
      db.transaction((tx: any) => {
        const deletion = tx.delete(emailAccounts).where(and(
          eq(emailAccounts.id, acc.id),
          eq(emailAccounts.userId, ctx.user.id),
        )).run();
        if (Number(deletion.changes || 0) !== 1) {
          throw new TRPCError({ code: "CONFLICT", message: "The provider connection changed before it could be removed." });
        }
        writeAuditLogOrThrow(tx, {
          userId: ctx.user.id,
          action: revocationConfirmed
            ? AUDIT_ACTIONS.PROVIDER_DISCONNECT_REVOKED
            : AUDIT_ACTIONS.PROVIDER_DISCONNECTED,
          entityType: "provider_connection",
          entityId: acc.id,
          details: {
            provider: acc.provider === "gmail" ? "google" : acc.provider,
            route: "emailAccounts.revoke",
            revocationOutcome,
            localCredentialsRemoved: true,
          },
        });
      });
      return { success: true as const };
    }),

  syncJobs: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];
    return db
      .select({
        id: emailSyncJobs.id,
        accountId: emailSyncJobs.accountId,
        caseId: emailSyncJobs.caseId,
        status: emailSyncJobs.status,
        startDate: emailSyncJobs.startDate,
        endDate: emailSyncJobs.endDate,
        keywords: emailSyncJobs.keywords,
        createdAt: emailSyncJobs.createdAt,
      })
      .from(emailSyncJobs)
      .innerJoin(emailAccounts, eq(emailSyncJobs.accountId, emailAccounts.id))
      .where(eq(emailAccounts.userId, ctx.user.id))
      .limit(50);
  }),
});
