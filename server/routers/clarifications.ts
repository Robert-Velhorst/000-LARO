import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  answerClarification,
  ClarificationContractError,
  getPendingClarifications,
} from "../clarifications";

function clarificationError(error: unknown): never {
  if (error instanceof ClarificationContractError) {
    throw new TRPCError({ code: error.code, message: error.message });
  }
  throw error;
}

export const clarificationsRouter = router({
  pending: protectedProcedure.query(({ ctx }) => getPendingClarifications(ctx.user.id)),
  answer: protectedProcedure
    .input(z.object({
      questionId: z.string().trim().min(1).max(300),
      answer: z.string().trim().min(1).max(2_000),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await answerClarification({ userId: ctx.user.id, ...input });
      } catch (error) {
        clarificationError(error);
      }
    }),
});
