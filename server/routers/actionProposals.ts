import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { decideActionProposal, getActionSource, listActionProposals } from "../actionProposals";

export const actionProposalsRouter = router({
  list: protectedProcedure.input(z.object({ caseId: z.string().min(1), offset: z.number().int().min(0).default(0) }))
    .query(({ ctx, input }) => listActionProposals(ctx.user.id, input.caseId, input.offset)),
  decide: protectedProcedure.input(z.object({ caseId: z.string().min(1), evidenceId: z.string().min(1), proposalId: z.string().min(1),
    decision: z.enum(["accept", "dismiss", "restore"]), dueDate: z.string().date().nullable().optional() }))
    .mutation(({ ctx, input }) => decideActionProposal(ctx.user.id, input)),
  forAction: protectedProcedure.input(z.object({ actionId: z.string().min(1) }))
    .query(({ ctx, input }) => getActionSource(ctx.user.id, input.actionId)),
});
