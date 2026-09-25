import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getSearchSuggestionsDetailed,
  globalSearchDetailed,
  resolveSearchResult,
} from "../globalSearch";
import { checkRateLimit, getRateLimitIdentifier, RATE_LIMITS } from "../rateLimit";
import { hybridCaseSearch } from "../casesHybridSearch";
import { SEARCH_RESULT_TYPES } from "../../shared/globalSearch";

export const searchRouter = router({
  /** Natural-language expanded tokens + keyword global search → case IDs */
  hybridCases: protectedProcedure
    .input(z.object({ query: z.string().min(1).max(500) }))
    .query(async ({ input, ctx }) => {
      const identifier = getRateLimitIdentifier(ctx);
      checkRateLimit(identifier, RATE_LIMITS.general);
      return hybridCaseSearch(input.query, ctx.user.id);
    }),

  global: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(200),
        types: z.array(z.enum(["case", "lawyer", "evidence", "document", "communication"])).optional(),
        limit: z.number().min(1).max(100).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const identifier = getRateLimitIdentifier(ctx);
      checkRateLimit(identifier, RATE_LIMITS.general);

      const outcome = await globalSearchDetailed(input.query, {
        types: input.types,
        limit: input.limit,
        userId: ctx.user.id,
      });

      return {
        query: input.query,
        normalizedQuery: outcome.normalizedQuery,
        results: outcome.results,
        total: outcome.results.length,
        completeness: outcome.completeness,
      };
    }),

  resolve: protectedProcedure
    .input(z.object({
      type: z.enum(SEARCH_RESULT_TYPES),
      id: z.string().trim().min(1).max(256),
    }))
    .query(async ({ input, ctx }) => {
      const identifier = getRateLimitIdentifier(ctx);
      checkRateLimit(identifier, RATE_LIMITS.general);

      // Missing, deleted, and foreign records deliberately share one neutral
      // response. The destination renders the canonical inaccessible state
      // without leaking stale metadata or logging an expected client error.
      return resolveSearchResult(input.type, input.id, ctx.user.id);
    }),

  suggestions: protectedProcedure
    .input(
      z.object({
        query: z.string().min(1).max(100),
        limit: z.number().min(1).max(10).optional().default(5),
      })
    )
    .query(async ({ input, ctx }) => {
      const identifier = getRateLimitIdentifier(ctx);
      checkRateLimit(identifier, RATE_LIMITS.general);

      const outcome = await getSearchSuggestionsDetailed(input.query, input.limit, ctx.user.id);

      return {
        query: input.query,
        normalizedQuery: outcome.normalizedQuery,
        suggestions: outcome.suggestions,
        completeness: outcome.completeness,
      };
    }),
});
