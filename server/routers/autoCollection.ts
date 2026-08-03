import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import {
  getAutoCollectionSettings,
  upsertAutoCollectionSettings,
  runAutoCollection,
  getAutoCollectionLogs,
  getKeywordMatches,
  pullEvidenceByKeywords,
  setLocalFolderPaths,
  getLocalFolderPaths,
  startKeywordPullJob,
  getKeywordPullJob,
  getActiveKeywordPullJob,
} from "../autoCollectionService";
import { assertCaseOwnership } from "../_core/authz";
import { getDb } from "../db";
import { emailAccounts } from "../schema";
import { and, eq } from "drizzle-orm";

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
});

export const autoCollectionRouter = router({
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
        googleDriveFolderIds: z.array(z.string()).optional(),
        autoDownloadAttachments: z.boolean(),
        autoDownloadGoogleDriveFiles: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.user.id;
      await assertCaseOwnership(input.caseId, userId);
      if (input.googleDriveAccountId) {
        const db = await getDb();
        const [account] = db
          ? await db.select({ id: emailAccounts.id }).from(emailAccounts).where(and(
            eq(emailAccounts.id, input.googleDriveAccountId),
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
        return { success: true, result };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to run collection",
        });
      }
    }),

  getLogs: protectedProcedure
    .input(z.object({ caseId: z.string(), limit: z.number().optional().default(10) }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const logs = await getAutoCollectionLogs(input.caseId, input.limit);
      return { logs };
    }),

  getKeywordMatches: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const matches = await getKeywordMatches(input.caseId);
      return { matches };
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
        });
        return { success: true, result };
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
