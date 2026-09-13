import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { actionEvidencePassages, actionEvidenceSources, linkActionEvidence, listActionEvidence, setActionEvidenceState } from "../actionEvidence";
const id = z.string().min(1).max(200);
const page = z.object({ actionId: id, offset: z.number().int().min(0).default(0) });
export const actionEvidenceRouter = router({
  sources: protectedProcedure.input(page).query(({ ctx, input }) => actionEvidenceSources(ctx.user.id, input.actionId, input.offset)),
  passages: protectedProcedure.input(page.extend({ evidenceId: id })).query(({ ctx, input }) => actionEvidencePassages(ctx.user.id, input)),
  list: protectedProcedure.input(page).query(({ ctx, input }) => listActionEvidence(ctx.user.id, input.actionId, input.offset)),
  link: protectedProcedure.input(z.object({ actionId: id, evidenceId: id, analysisId: id, contentHash: id,
    analysisFingerprint: z.string().length(64), citationIds: z.array(id).min(1).max(10),
    relation: z.enum(["supports", "contradicts"]), note: z.string().trim().min(1).max(2000) }))
    .mutation(({ ctx, input }) => linkActionEvidence(ctx.user.id, input)),
  setState: protectedProcedure.input(z.object({ id, state: z.enum(["active", "withdrawn"]) }))
    .mutation(({ ctx, input }) => setActionEvidenceState(ctx.user.id, input)),
});
