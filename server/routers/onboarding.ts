import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  ONBOARDING_STEP_KEYS,
  completeOnboarding,
  getOnboardingState,
  resetOnboarding,
  setOnboardingCurrentStep,
  skipOnboarding,
} from "../onboarding";

/** Owner-scoped onboarding contract shared by the desktop and hosted renderer. */
export const onboardingRouter = router({
  state: protectedProcedure.query(({ ctx }) => getOnboardingState(ctx.user.id)),
  setCurrentStep: protectedProcedure
    .input(z.object({ stepKey: z.enum(ONBOARDING_STEP_KEYS) }))
    .mutation(({ ctx, input }) => setOnboardingCurrentStep(ctx.user.id, input.stepKey)),
  skip: protectedProcedure.mutation(({ ctx }) => skipOnboarding(ctx.user.id)),
  reset: protectedProcedure.mutation(({ ctx }) => resetOnboarding(ctx.user.id)),
  complete: protectedProcedure.mutation(async ({ ctx }) => {
    const state = await completeOnboarding(ctx.user.id);
    if (!state) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Complete the case, evidence, and outreach setup steps before finishing the guide.",
      });
    }
    return state;
  }),
});
