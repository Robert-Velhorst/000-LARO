import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { assertCaseOwnership } from "../_core/authz";
import { createAuditLog } from "../audit";
import { enforceRateLimit, RATE_LIMITS } from "../rateLimit";
import {
  createManualOutreachTarget,
  discoverOutreachTargetsForCase,
  getCaseTargetMatches,
  getOutreachDirectorySummary,
  listOutreachTargets,
  matchApprovedTargetsForCase,
  reviewOutreachTarget,
  reviewOutreachTargetsForDiscovery,
  reviewOutreachTargetsBatch,
  updateCaseTargetMatchStatus,
} from "../outreachDirectory";
import { getWorkflowPreferences } from "../workflowPreferences";

const targetTypeSchema = z.enum(["media", "organization"]);
const reviewStatusSchema = z.enum(["pending", "approved", "rejected"]);
const matchStatusSchema = z.enum(["suggested", "shortlisted", "contacted", "dismissed"]);

export const outreachDirectoryRouter = router({
  summary: protectedProcedure.query(({ ctx }) => getOutreachDirectorySummary(ctx.user.id)),

  list: protectedProcedure
    .input(z.object({
      targetType: targetTypeSchema,
      status: reviewStatusSchema.optional(),
      limit: z.number().int().min(1).max(200).optional().default(100),
    }))
    .query(({ input, ctx }) => listOutreachTargets({ userId: ctx.user.id, ...input })),

  discoverForCase: protectedProcedure
    .input(z.object({
      caseId: z.string().min(1),
      targetType: targetTypeSchema,
      maxQueries: z.number().int().min(1).max(6).optional().default(4),
      maxResults: z.number().int().min(1).max(60).optional().default(30),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      enforceRateLimit(ctx, "outreachDiscovery", {
        ...RATE_LIMITS.lawyerSearch,
        maxRequests: 10,
        message: "Too many public discovery requests. Please wait a moment.",
      });
      const report = await discoverOutreachTargetsForCase({ userId: ctx.user.id, ...input });
      const preferences = await getWorkflowPreferences(ctx.user.id);
      let autoReviewedTargetIds: string[] = [];
      let automaticMatchedTargetIds: string[] = [];
      let skippedTargets = [...report.skippedTargets];
      let leftPendingTargetIds = [...report.leftPendingTargetIds];
      if (preferences.outreachReviewMode === "automatic") {
        const review = await reviewOutreachTargetsForDiscovery({
          userId: ctx.user.id,
          caseId: input.caseId,
          runId: report.runId,
          targetType: input.targetType,
          ids: [...report.createdTargetIds, ...report.refreshedTargetIds],
        });
        autoReviewedTargetIds = review.reviewedTargetIds;
        skippedTargets = [...skippedTargets, ...review.skippedTargets];
        const reviewedIds = new Set(review.reviewedTargetIds);
        leftPendingTargetIds = leftPendingTargetIds.filter((id) => !reviewedIds.has(id));
        if (review.approvedTargetIds.length > 0) {
          const matches = await matchApprovedTargetsForCase({
            userId: ctx.user.id,
            caseId: input.caseId,
            targetType: input.targetType,
            targetIds: review.approvedTargetIds,
          });
          automaticMatchedTargetIds = matches.map((match) => match.targetId);
        }
      }
      const autoReviewed = autoReviewedTargetIds.length;
      const automaticMatches = automaticMatchedTargetIds.length;
      await createAuditLog({
        userId: ctx.user.id,
        action: "outreach.directory_discovered",
        entityType: "case",
        entityId: input.caseId,
        details: {
          targetType: input.targetType,
          status: report.status,
          newCandidates: report.newCandidates,
          rawCaseTextShared: report.rawCaseTextShared,
          reviewMode: preferences.outreachReviewMode,
          discoveryRunId: report.runId,
          candidateTargetIds: report.candidateTargetIds,
          createdTargetIds: report.createdTargetIds,
          refreshedTargetIds: report.refreshedTargetIds,
          autoReviewedTargetIds,
          automaticMatchedTargetIds,
          skippedTargets,
          leftPendingTargetIds,
          partialReasons: report.partialReasons,
          autoReviewed,
          automaticMatches,
        },
      });
      return {
        ...report,
        reviewMode: preferences.outreachReviewMode,
        skippedTargets,
        leftPendingTargetIds,
        autoReviewed,
        autoReviewedTargetIds,
        automaticMatches,
        automaticMatchedTargetIds,
      };
    }),

  createManual: protectedProcedure
    .input(z.object({
      targetType: targetTypeSchema,
      name: z.string().trim().min(2).max(255),
      url: z.string().trim().url().max(2_048),
      contactUrl: z.string().trim().url().max(2_048).optional(),
      description: z.string().trim().max(2_000).optional(),
      subtype: z.string().trim().max(120).optional(),
      legalAreas: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const id = await createManualOutreachTarget({ userId: ctx.user.id, ...input });
      await createAuditLog({
        userId: ctx.user.id,
        action: "outreach.directory_imported",
        entityType: "outreach_target",
        entityId: id,
        details: { targetType: input.targetType, source: "manual" },
      });
      return { id };
    }),

  review: protectedProcedure
    .input(z.object({
      id: z.string().min(1),
      status: reviewStatusSchema,
      reviewNotes: z.string().trim().max(1_000).optional(),
      caseId: z.string().min(1).optional(),
      targetType: targetTypeSchema,
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.caseId) await assertCaseOwnership(input.caseId, ctx.user.id);
      const reviewed = await reviewOutreachTarget({
        userId: ctx.user.id,
        id: input.id,
        targetType: input.targetType,
        status: input.status,
        reviewNotes: input.reviewNotes,
        caseId: input.caseId,
      });
      const matches = input.status === "approved" && input.caseId
        ? await matchApprovedTargetsForCase({
          userId: ctx.user.id,
          caseId: input.caseId,
          targetType: reviewed.targetType,
        })
        : null;
      return { success: true as const, matches };
    }),

  reviewBatch: protectedProcedure
    .input(z.object({
      ids: z.array(z.string().min(1)).min(1).max(50)
        .refine((ids) => new Set(ids).size === ids.length, "Duplicate outreach target IDs are not allowed"),
      status: z.enum(["approved", "rejected"]),
      targetType: targetTypeSchema,
      caseId: z.string().min(1).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (input.caseId) await assertCaseOwnership(input.caseId, ctx.user.id);
      const reviewed = await reviewOutreachTargetsBatch({
        userId: ctx.user.id,
        ids: input.ids,
        targetType: input.targetType,
        status: input.status,
        reviewNotes: `Reviewed in an owner-approved batch of ${input.ids.length}.`,
        caseId: input.caseId,
      });
      const matches = input.status === "approved" && input.caseId
        ? await matchApprovedTargetsForCase({ userId: ctx.user.id, caseId: input.caseId, targetType: input.targetType })
        : null;
      return { success: true as const, reviewed: reviewed.reviewed, matches };
    }),

  matchCase: protectedProcedure
    .input(z.object({
      caseId: z.string().min(1),
      targetType: targetTypeSchema,
      limit: z.number().int().min(1).max(100).optional().default(30),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const matches = await matchApprovedTargetsForCase({ userId: ctx.user.id, ...input });
      return matches;
    }),

  matches: protectedProcedure
    .input(z.object({ caseId: z.string().min(1), targetType: targetTypeSchema }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      return getCaseTargetMatches({ userId: ctx.user.id, ...input });
    }),

  updateMatchStatus: protectedProcedure
    .input(z.object({ id: z.string().min(1), status: matchStatusSchema }))
    .mutation(async ({ input, ctx }) => {
      return updateCaseTargetMatchStatus({ userId: ctx.user.id, ...input });
    }),
});
