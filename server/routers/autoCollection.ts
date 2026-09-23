import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import {
  getAutoCollectionSettings,
  upsertAutoCollectionSettings,
  runAutoCollection,
  getKeywordPullMonitoring,
  pullEvidenceByKeywords,
  setLocalFolderPaths,
  getLocalFolderPaths,
  startKeywordPullJob,
  getKeywordPullJob,
  getActiveKeywordPullJob,
  cancelKeywordPullJob,
} from "../autoCollectionService";
import { assertCaseOwnership } from "../_core/authz";
import { getDb } from "../db";
import { emailAccounts } from "../schema";
import { and, eq } from "drizzle-orm";
import { googleDriveSourcesSchema } from "../../shared/googleDriveSources";
import { listGoogleDriveFolders } from "../googleDriveService";

const driveId = z.string().trim().min(1).max(256);

const keywordPullInput = z.object({
  caseId: z.string(),
  keywords: z.array(z.string().min(1)).min(1),
  matchMode: z.enum(["all", "any"]).optional().default("any"),
  gmailAccountIds: z.array(z.string()).optional(),
  driveAccountId: z.string().optional(),
  driveFolderIds: z.array(z.string()).optional(),
  localFolderPaths: z.array(z.string()).optional(),
  dateStart: z.coerce.date().optional(),
  dateEnd: z.coerce.date().optional(),
  includeGmail: z.boolean().optional(),
  includeGmailAttachments: z.boolean().optional(),
  includeDrive: z.boolean().optional(),
  includeLocal: z.boolean().optional(),
});

export const autoCollectionRouter = router({
  listDriveFolders: protectedProcedure
    .input(z.object({
      parentId: driveId.optional(),
      accountId: driveId,
    }))
    .query(async ({ input, ctx }) => {
      try {
        return {
          folders: await listGoogleDriveFolders(ctx.user.id, input.parentId, input.accountId),
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Google Drive folders could not be loaded.",
        });
      }
    }),

  getSettings: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const settings = await getAutoCollectionSettings(input.caseId);
      return { settings };
    }),

  upsertSettings: protectedProcedure
    .input(
      z.object({
        caseId: z.string(),
        keywords: z.array(z.string()),
        keywordMatchMode: z.enum(["all", "any"]),
        dateRangeStart: z.date().optional(),
        dateRangeEnd: z.date().optional(),
        emailAccountIds: z.array(z.string()),
        googleDriveAccountId: z.string().optional(),
        googleDriveSources: googleDriveSourcesSchema.optional(),
        googleDriveFolderIds: z.array(z.string()).optional(),
        autoDownloadAttachments: z.boolean(),
        autoDownloadGoogleDriveFiles: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user.id;
      await assertCaseOwnership(input.caseId, userId);
      const selectedIds = new Set([
        ...input.emailAccountIds,
        ...(input.googleDriveSources?.map((source) => source.accountId)
          ?? (input.googleDriveAccountId ? [input.googleDriveAccountId] : [])),
      ]);
      for (const accountId of selectedIds) {
        const db = await getDb();
        const [account] = db
          ? await db.select({ id: emailAccounts.id }).from(emailAccounts).where(and(
            eq(emailAccounts.id, accountId),
            eq(emailAccounts.userId, userId),
            eq(emailAccounts.provider, "gmail"),
          )).limit(1)
          : [];
        if (!account) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Selected Google Drive account is unavailable." });
        }
      }
      await upsertAutoCollectionSettings({
        ...input,
        userId,
      });
      
      // Feature request: run immediately upon saving
      try {
        const result = await runAutoCollection(input.caseId);
        return { success: true, runResult: result };
      } catch (err) {
        console.error("Failed to run initial auto-collection:", err);
        return { success: true, runResult: null, error: "Saved, but initial run failed" };
      }
    }),

  runCollection: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      try {
        const result = await runAutoCollection(input.caseId);
        return { success: result.errors.length === 0, result };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to run collection",
        });
      }
    }),

  monitoring: protectedProcedure
    .input(z.object({
      caseId: z.string(),
      limit: z.number().int().min(1).max(50).optional().default(20),
    }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      return getKeywordPullMonitoring(input.caseId, ctx.user.id, input.limit);
    }),

  /**
   * One-shot keyword pull: pull evidence from every connected source
   * (Gmail, Google Drive, configured local folders) in a single call.
   * This is the entry point for the case-view "Pull evidence by keyword" UI.
  */
  pullByKeywords: protectedProcedure
    .input(keywordPullInput)
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      try {
        const result = await pullEvidenceByKeywords({
          caseId: input.caseId,
          userId: ctx.user.id,
          keywords: input.keywords,
          matchMode: input.matchMode,
          gmailAccountIds: input.gmailAccountIds,
          driveAccountId: input.driveAccountId,
          driveFolderIds: input.driveFolderIds,
          localFolderPaths: input.localFolderPaths,
          dateStart: input.dateStart,
          dateEnd: input.dateEnd,
          includeGmail: input.includeGmail,
          includeGmailAttachments: input.includeGmailAttachments,
          includeDrive: input.includeDrive,
          includeLocal: input.includeLocal,
        });
        return {
          success: result.errors.length === 0 && result.outcome === "completed",
          outcome: result.outcome,
          result,
        };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Pull failed",
        });
      }
    }),

  startPullByKeywords: protectedProcedure
    .input(keywordPullInput)
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const job = await startKeywordPullJob({ ...input, userId: ctx.user.id });
      return { success: true, job };
    }),

  pullJobStatus: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .query(async ({ input, ctx }) => getKeywordPullJob(input.jobId, ctx.user.id)),

  activePullJob: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      return getActiveKeywordPullJob(input.caseId, ctx.user.id);
    }),

  cancelPullJob: protectedProcedure
    .input(z.object({ jobId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => ({
      success: Boolean(await cancelKeywordPullJob(input.jobId, ctx.user.id)),
    })),

  /**
   * Persist local-folder paths to auto-scan during keyword pulls.
   */
  setLocalFolders: protectedProcedure
    .input(z.object({ caseId: z.string(), paths: z.array(z.string()) }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      await setLocalFolderPaths(input.caseId, ctx.user.id, input.paths);
      return { success: true };
    }),

  getLocalFolders: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const paths = await getLocalFolderPaths(input.caseId);
      return { paths };
    }),
});
