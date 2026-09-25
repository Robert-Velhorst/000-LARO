import { z } from "zod";
import { router, protectedProcedure, adminProcedure } from "../_core/trpc";
import { FEATURE_FLAG_KEYS, getAllFlags, setFlagWithAudit } from "../featureFlags";

/**
 * Only maintained runtime flags are exposed. Any authenticated user may read
 * effective state; only admins may change it with a durable audit event.
 */
export const featureFlagsRouter = router({
  list: protectedProcedure.query(async () => {
    return getAllFlags();
  }),

  set: adminProcedure
    .input(z.object({ key: z.enum(FEATURE_FLAG_KEYS), value: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const result = await setFlagWithAudit(input.key, input.value, ctx.user.id);
      return { success: true, ...input, changed: result.changed };
    }),
});
