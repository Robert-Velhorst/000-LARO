import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  createHaiToken,
  HAI_FEED_PATH,
  HAI_HEALTH_PATH,
  HAI_INTEGRATION_SCOPE,
  haiPublicBaseUrl,
  listHaiTokens,
  revokeHaiToken,
} from "../haiIntegration";

export const haiIntegrationRouter = router({
  connectionInfo: protectedProcedure.query(() => {
    const baseUrl = haiPublicBaseUrl();
    return {
      baseUrl,
      feedUrl: `${baseUrl}${HAI_FEED_PATH}`,
      healthUrl: `${baseUrl}${HAI_HEALTH_PATH}`,
      scope: HAI_INTEGRATION_SCOPE,
      mode: "read_only" as const,
    };
  }),
  listTokens: protectedProcedure.query(({ ctx }) => listHaiTokens(ctx.user.id)),
  createToken: protectedProcedure
    .input(z.object({
      name: z.string().trim().min(2).max(80),
      expiresInDays: z.number().int().min(1).max(365),
    }))
    .mutation(({ ctx, input }) => createHaiToken(ctx.user.id, input.name, input.expiresInDays)),
  revokeToken: protectedProcedure
    .input(z.object({ tokenId: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await revokeHaiToken(ctx.user.id, input.tokenId);
      } catch (error) {
        if (error instanceof Error && error.message === "Integration token not found") {
          throw new TRPCError({ code: "NOT_FOUND", message: error.message });
        }
        throw error;
      }
    }),
});
