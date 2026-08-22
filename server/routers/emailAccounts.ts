import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { emailAccounts, emailSyncJobs } from "../schema";
import { eq, and } from "drizzle-orm";
import {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  getAccountInfo,
  refreshAccessToken,
  consumeOAuthState,
  saveEmailAccount,
} from "../oauth2";
import { encryptToken, decryptToken, revokeStoredGoogleTokens } from "../emailOAuth";
import { AUDIT_ACTIONS, createAuditLog, writeAuditLogOrThrow } from "../audit";

export const emailAccountsRouter = router({
  getAuthUrl: protectedProcedure
    .input(z.object({ provider: z.literal("gmail") }))
    .mutation(async ({ input, ctx }) => ({
      authUrl: getAuthorizationUrl(input.provider, ctx.user.id),
    })),

  connectAccount: protectedProcedure
    .input(
      z.object({
        provider: z.literal("gmail"),
        code: z.string(),
        state: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      const state = consumeOAuthState(input.state, input.provider);
      if (state.userId !== ctx.user.id) throw new Error("OAuth state does not match the current user");
      const tokens = await exchangeCodeForTokens(input.provider, input.code, state.codeVerifier);
      const accountInfo = await getAccountInfo(input.provider, tokens.accessToken);

      const id = await saveEmailAccount(ctx.user.id, input.provider, tokens, accountInfo);

      return { success: true as const, accountId: id, email: accountInfo.email };
    }),

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
      await db
        .update(emailAccounts)
        .set({
          accessToken: encryptToken(next.accessToken),
          refreshToken: next.refreshToken ? encryptToken(next.refreshToken) : acc.refreshToken,
          tokenExpiry: new Date(Date.now() + next.expiresIn * 1000),
        })
        .where(eq(emailAccounts.id, acc.id));
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
