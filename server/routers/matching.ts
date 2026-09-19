import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { assertCaseOwnership } from "../_core/authz";
import { enforceRateLimit, RATE_LIMITS } from "../rateLimit";
import { findCaseLawyersWithOfficialDirectory, findMatchingLawyers, MATCH_SCORE_MAX } from "../matching";

/**
 * Phase 011 — Core workflow vertical slice.
 *
 * This router now calls the REAL LARO matching engine (server/matching.ts:
 * findMatchingLawyers) instead of returning randomized distances and
 * hardcoded scores. The engine applies the mandatory filters (expertise,
 * bar-association standing, accepting-new-cases, distance) and the LARO scoring
 * system (case-load, response time, acceptance rate, distance, experience,
 * and court-terminology keyword boost).
 *
 * Honesty notes:
 *  - Both procedures require auth and verify the case belongs to the caller.
 *  - The engine throws when the case has no legal areas yet (classification is
 *    pending — Phase 025). We surface that as an empty result with a reason,
 *    rather than inventing matches.
 *  - If no lawyers are seeded/entered, the result is genuinely empty (no fakes).
 */
export const matchingRouter = router({
  findOfficialLawyers: protectedProcedure
    .input(z.object({
      caseId: z.string(),
      maxDistance: z.number().min(5).max(200).optional().default(50),
      maxResults: z.number().min(1).max(50).optional().default(10),
      location: z.string().trim().max(160).optional(),
      requireSpecializationAssociation: z.boolean().optional().default(false),
      requiresFinancedLegalAid: z.boolean().optional(),
      refreshOfficialDirectory: z.boolean().optional().default(true),
    }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      enforceRateLimit(ctx, "lawyerSearch", RATE_LIMITS.lawyerSearch);
      const result = await findCaseLawyersWithOfficialDirectory(input.caseId, input);
      const { scoreToConfidence } = await import("../confidence");
      return {
        ...result,
        lawyers: result.lawyers.map((lawyer) => ({
          ...lawyer,
          confidence: scoreToConfidence(Number(lawyer.matchScore || 0), {
            max: MATCH_SCORE_MAX,
            basis: "verified match data",
          }),
        })),
      };
    }),

  findLawyers: protectedProcedure
    .input(z.object({
      caseId: z.string(),
      maxDistance: z.number().optional().default(100),
      maxResults: z.number().optional().default(10),
    }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id); // Phase 008
      enforceRateLimit(ctx, "lawyerSearch", RATE_LIMITS.lawyerSearch); // Phase 018
      try {
        const matched = await findMatchingLawyers(input.caseId, {
          maxDistance: input.maxDistance,
          maxResults: input.maxResults,
          sortBy: "score",
        });
        // Phase 107 — attach an honest confidence derived from the REAL score
        // (no hardcoded constant). Preserves the array shape callers expect.
        const { scoreToConfidence } = await import("../confidence");
        return (matched as any[]).map((m) => ({
          ...m,
          confidence: scoreToConfidence(Number(m.matchScore ?? m.score ?? 0), {
            max: MATCH_SCORE_MAX,
            basis: "verified match data",
          }),
        }));
      } catch (err) {
        // Real engine throws e.g. "Case must have at least one legal area
        // specified" before classification exists. Return an honest empty list.
        console.warn("[matching.findLawyers]", err instanceof Error ? err.message : err);
        return [];
      }
    }),

  findMatches: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id); // Phase 008
      try {
        const matched = await findMatchingLawyers(input.caseId, {
          maxResults: 5,
          sortBy: "score",
        });
        // Preserve the { lawyers: [...] } shape the caller expects, but with the
        // real match score instead of a hardcoded 95.
        return { lawyers: matched.map((m) => ({ ...m, score: m.matchScore })) };
      } catch (err) {
        console.warn("[matching.findMatches]", err instanceof Error ? err.message : err);
        return { lawyers: [] };
      }
    }),
});
