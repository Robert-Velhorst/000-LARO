import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { getAllFlags, setFlagWithAudit, FLAG_DEFAULTS, type FlagKey } from "../featureFlags";

/**
 * Phase 058 — feature flags API. Any authenticated user may read the current
 * flags; only admins may change them.
 */
export const featureFlagsRouter = router({
  list: protectedProcedure.query(async () => {
    return getAllFlags();
  }),

  set: adminProcedure
    .input(z.object({ key: z.enum(Object.keys(FLAG_DEFAULTS) as [FlagKey, ...FlagKey[]]), value: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const result = await setFlagWithAudit(input.key, input.value, ctx.user.id);
      return { success: true, ...input, changed: result.changed };
    }),
});
