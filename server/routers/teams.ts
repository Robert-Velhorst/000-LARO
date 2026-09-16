import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  acceptCaseInvitation,
  CASE_SHARE_CAPABILITIES,
  CASE_SHARE_ROLES,
  inviteCaseMember,
  listCaseShares,
  listIncomingInvitations,
  revokeCaseShare,
  updateCaseShare,
} from "../teams";

const roleSchema = z.enum(CASE_SHARE_ROLES);
const capabilitySchema = z.enum(CASE_SHARE_CAPABILITIES);
const sharePolicySchema = z.object({
  role: roleSchema.default("read_only"),
  capabilities: z.array(capabilitySchema).max(CASE_SHARE_CAPABILITIES.length).default([]),
});

/** Per-case invitations and least-privilege collaboration policies. */
export const teamsRouter = router({
  listShares: protectedProcedure
    .input(z.object({ caseId: z.string().min(1) }))
    .query(({ ctx, input }) => listCaseShares(ctx.user.id, input.caseId)),

  listInvitations: protectedProcedure
    .query(({ ctx }) => listIncomingInvitations(ctx.user.id)),

  invite: protectedProcedure
    .input(z.object({
      caseId: z.string().min(1),
      email: z.string().trim().email(),
    }).merge(sharePolicySchema))
    .mutation(({ ctx, input }) => inviteCaseMember({ ownerId: ctx.user.id, ...input })),

  accept: protectedProcedure
    .input(z.object({ shareId: z.string().min(1) }))
    .mutation(({ ctx, input }) => acceptCaseInvitation(ctx.user.id, input.shareId)),

  update: protectedProcedure
    .input(z.object({ shareId: z.string().min(1) }).merge(sharePolicySchema))
    .mutation(({ ctx, input }) => updateCaseShare({ ownerId: ctx.user.id, ...input })),

  revoke: protectedProcedure
    .input(z.object({ shareId: z.string().min(1) }))
    .mutation(({ ctx, input }) => revokeCaseShare(ctx.user.id, input.shareId)),
});
