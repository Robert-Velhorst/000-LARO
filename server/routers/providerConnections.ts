import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  beginProviderConnection,
  disconnectProviderConnection,
  getGoogleDisconnectImpact,
  listProviderConnections,
  ProviderConnectionError,
  providerConnectionAvailability,
} from "../providerConnections";
import { SESSION_COOKIE_NAME } from "../sessionCookie";

const provider = z.enum(["gmail", "outlook"]);

function asTrpcError(error: unknown): never {
  if (!(error instanceof ProviderConnectionError)) throw error;
  if (error.code === "not_found") {
    throw new TRPCError({ code: "NOT_FOUND", message: error.message, cause: error });
  }
  if (error.code === "provider_unavailable") {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message, cause: error });
  }
  if (error.code === "transient_provider_failure" || error.code === "upstream_revocation_failed") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message, cause: error });
  }
  throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message, cause: error });
}

/** The only renderer-facing lifecycle for OAuth-backed provider connections. */
export const providerConnectionsRouter = router({
  availability: protectedProcedure
    .input(z.object({ provider }))
    .query(({ input }) => providerConnectionAvailability(input.provider)),

  list: protectedProcedure
    .input(z.object({ provider: provider.optional() }).optional())
    .query(({ input, ctx }) => listProviderConnections(ctx.user.id, input?.provider)),

  disconnectImpact: protectedProcedure
    .input(z.object({ accountId: z.string().trim().min(1).max(256) }))
    .query(async ({ input, ctx }) => {
      try {
        return await getGoogleDisconnectImpact({
          userId: ctx.user.id,
          accountId: input.accountId,
        });
      } catch (error) {
        asTrpcError(error);
      }
    }),

  begin: protectedProcedure
    .input(z.object({ provider }))
    .mutation(async ({ input, ctx }) => {
      try {
        return {
          authUrl: await beginProviderConnection(
            input.provider,
            ctx.user.id,
            ctx.req.cookies?.[SESSION_COOKIE_NAME] || "",
          ),
        };
      } catch (error) {
        asTrpcError(error);
      }
    }),

  disconnect: protectedProcedure
    .input(z.object({
      accountId: z.string().trim().min(1).max(256),
      impactRevision: z.string().regex(/^[a-f0-9]{64}$/),
      acknowledgeSharedGoogleGrant: z.literal(true),
      initiatedFrom: z.enum(["shared_google_grant", "gmail", "google_drive"]),
    }))
    .mutation(async ({ input, ctx }) => {
      try {
        return await disconnectProviderConnection({
          userId: ctx.user.id,
          ...input,
        });
      } catch (error) {
        asTrpcError(error);
      }
    }),
});
