import { z } from "zod";
import { router, protectedProcedure } from "../_core/trpc";
import { TRPCError } from "@trpc/server";
import {
  listGoogleDriveFolders,
  getAllFilesInFolder,
  searchGoogleDriveFiles,
  downloadAndUploadGoogleDriveFile,
} from "../googleDriveService";
import { getDb } from "../db";
import { evidence } from "../schema";
import { eq, and } from "drizzle-orm";
import { startKeywordPullJob } from "../autoCollectionService";
import { assertCaseOwnership } from "../_core/authz";
import { createEvidenceFile } from "../evidence";
import { analyzeStoredEvidence } from "../documentAnalysisService";
import { supportsDocumentAnalysisMime } from "../documentIntelligence";
import { PROVIDER_LIMITS } from "../providerLimits";
import { enforcePersistentRateLimit, RATE_LIMITS } from "../rateLimit";
import { EvidenceIngestionBudget } from "../evidenceIngestionBudget";
import { storageDelete } from "../storage";
import { EVIDENCE_INGESTION_LIMITS } from "../../shared/evidenceIngestion";

const driveId = z.string().trim().min(1).max(256);
const driveName = z.string().trim().min(1).max(500);

async function ingestDriveEvidence(options: {
  userId: string;
  accountId?: string;
  caseId: string;
  fileId: string;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
  budget: EvidenceIngestionBudget;
}) {
  await assertCaseOwnership(options.caseId, options.userId);
  const fileData = await downloadAndUploadGoogleDriveFile(
    options.fileId,
    options.caseId,
    options.userId,
    options.accountId,
    { budget: options.budget, signal: options.budget.signal },
  );
  return options.budget.run(async () => {
    let evidenceId: string;
    try {
      evidenceId = await createEvidenceFile(options.userId, {
      caseId: options.caseId,
      type: determineEvidenceType(fileData.mimeType),
      source: "google_drive",
      title: options.title,
      description: options.description,
      fileUrl: fileData.url,
      fileName: fileData.fileName,
      fileSize: fileData.size,
      mimeType: fileData.mimeType,
      metadata: JSON.stringify({
        ...options.metadata,
        storageKey: fileData.key,
        driveFileId: options.fileId,
        driveAccountId: options.accountId,
        sourceMimeType: fileData.sourceMimeType,
        importedAt: new Date().toISOString(),
        modifiedTime: fileData.modifiedTime,
      }),
      contentHash: fileData.sha256,
      relevant: true,
      });
    } catch (error) {
      options.budget.recordSkip("google_drive", "store_failed");
      await storageDelete(fileData.key).catch(() => undefined);
      throw error;
    }
    let analysisError: string | null = null;
    if (supportsDocumentAnalysisMime(fileData.mimeType)) {
      if (!options.budget.claimAnalysis("google_drive")) {
        analysisError = "Automatic analysis was deferred because the ingestion analysis limit was reached";
      } else {
        try {
          await analyzeStoredEvidence({ userId: options.userId, evidenceId, deepAnalysis: false });
        } catch (error) {
          analysisError = error instanceof Error ? error.message : "Automatic document analysis failed";
        }
      }
    }
    return { evidenceId, analysisError };
  });
}

/**
 * Google Drive Router
 * Handles folder browsing, file discovery, and evidence collection from Google Drive
 */
export const googleDriveRouter = router({
  /**
   * Kick off a Drive sync for a case. Without keywords we don't know what to
   * pull, so this is a thin wrapper that returns a no-op result if no
   * auto-collection settings exist yet.
   */
  startSync: protectedProcedure
    .input(z.object({ caseId: z.string(), sourceId: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      // Best effort: if the case has saved auto-collection keywords, use them.
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      const { autoCollectionSettings } = await import("../schema");
      const settings = await db
        .select()
        .from(autoCollectionSettings)
        .where(eq(autoCollectionSettings.caseId, input.caseId))
        .limit(1);
      const keywords = settings[0]?.keywords ? (() => {
        try { return JSON.parse(settings[0].keywords as string); } catch { return []; }
      })() : [];

      if (!keywords.length) {
        return {
          success: true,
          progress: {
            totalFiles: 0,
            processedFiles: 0,
            extractedContent: 0,
            errors: ["No keywords configured. Set keywords in Auto-Collection first."],
          },
        };
      }

      const job = await startKeywordPullJob({
        caseId: input.caseId,
        userId: ctx.user.id,
        keywords,
        driveAccountId: input.sourceId,
        includeGmail: false,
        includeDrive: true,
        includeLocal: false,
      });

      return {
        success: true,
        job,
        progress: {
          totalFiles: 0,
          processedFiles: 0,
          extractedContent: 0,
          errors: [],
        },
      };
    }),

  /**
   * List folders in Google Drive (for folder picker)
   */
  listFolders: protectedProcedure
    .input(
      z.object({
        parentId: z.string().optional(),
        accountId: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const folders = await listGoogleDriveFolders(ctx.user.id, input.parentId, input.accountId);
        return { folders };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to list folders",
        });
      }
    }),

  /**
   * Get all files in a folder (with preview)
   */
  getFilesInFolder: protectedProcedure
    .input(
      z.object({
        folderId: driveId,
        recursive: z.boolean().default(false),
        accountId: driveId.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const files = await getAllFilesInFolder(ctx.user.id, input.folderId, input.recursive, input.accountId);
        return { files, count: files.length };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to get files",
        });
      }
    }),

  /**
   * Search files in Google Drive
   */
  searchFiles: protectedProcedure
    .input(
      z.object({
        query: z.string().trim().min(1).max(200),
        folderId: driveId.optional(),
        accountId: driveId.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        const files = await searchGoogleDriveFiles(ctx.user.id, input.query, input.folderId, input.accountId);
        return { files };
      } catch (error) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to search files",
        });
      }
    }),

  /**
   * Import specific files as evidence
   */
  importFiles: protectedProcedure
    .input(
      z.object({
        caseId: z.string().min(1).max(128),
        accountId: driveId.optional(),
        fileIds: z.array(driveId).min(1).max(EVIDENCE_INGESTION_LIMITS.maxJobItems),
        fileNames: z.array(driveName).min(1).max(EVIDENCE_INGESTION_LIMITS.maxJobItems),
      }).superRefine((value, ctx) => {
        if (value.fileIds.length !== value.fileNames.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Every Drive file ID needs one filename." });
        }
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      await enforcePersistentRateLimit(ctx, "google-drive-import", RATE_LIMITS.bulkImport);

      const imported: string[] = [];
      const errors: string[] = [];
      const budget = new EvidenceIngestionBudget();

      for (let i = 0; i < input.fileIds.length; i++) {
        const fileId = input.fileIds[i];
        const fileName = input.fileNames[i];

        if (i >= PROVIDER_LIMITS.googleDrive.maxImportFiles) {
          budget.recordSkip("google_drive", "job_item_limit");
          continue;
        }

        try {
          const result = await ingestDriveEvidence({
            userId: ctx.user.id,
            accountId: input.accountId,
            caseId: input.caseId,
            fileId,
            title: fileName,
            description: "Imported from Google Drive",
            budget,
          });

          imported.push(fileName);
          if (result.analysisError) errors.push(`${fileName} analysis: ${result.analysisError}`);
        } catch (error) {
          errors.push(`${fileName}: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
      }

      const ingestion = budget.summary();

      return {
        success: errors.length === 0 && ingestion.outcome === "completed",
        outcome: ingestion.outcome,
        imported: imported.length,
        errors,
        ingestion,
      };
    }),

  /**
   * Bulk import all files from a folder
   */
  importFolder: protectedProcedure
    .input(
      z.object({
        caseId: z.string().min(1).max(128),
        folderId: driveId,
        folderName: driveName,
        recursive: z.boolean().default(false),
        keywords: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
        accountId: driveId.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      await enforcePersistentRateLimit(ctx, "google-drive-folder-import", RATE_LIMITS.bulkImport);
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      try {
        const budget = new EvidenceIngestionBudget();
        // Get all files in folder
        const files = await getAllFilesInFolder(ctx.user.id, input.folderId, input.recursive, input.accountId);

        let filesToImport = files;

        // Filter by keywords if provided
        if (input.keywords && input.keywords.length > 0) {
          filesToImport = files.filter(file => {
            const fileName = file.name?.toLowerCase() || "";
            return input.keywords!.some(kw => fileName.includes(kw.toLowerCase()));
          });
        }
        const imported: string[] = [];
        const skipped: string[] = [];
        const errors: string[] = [];

        const existing = await db
          .select({ metadata: evidence.metadata })
          .from(evidence)
          .where(and(
            eq(evidence.caseId, input.caseId),
            eq(evidence.userId, ctx.user.id),
            eq(evidence.source, "google_drive"),
          ));
        const importedDriveIds = new Set(existing.flatMap((row) => {
          try {
            const metadata = row.metadata ? JSON.parse(row.metadata) as { driveFileId?: unknown } : {};
            return typeof metadata.driveFileId === "string" ? [metadata.driveFileId] : [];
          } catch {
            return [];
          }
        }));
        const newFiles = filesToImport.filter((file) => !file.id || !importedDriveIds.has(file.id));
        const admittedNewIds = new Set(newFiles.slice(0, PROVIDER_LIMITS.googleDrive.maxImportFiles)
          .map((file) => file.id).filter((id): id is string => Boolean(id)));

        for (const file of filesToImport) {
          try {
            if (file.id && importedDriveIds.has(file.id)) {
              skipped.push(file.name || "Unknown");
              budget.recordSkip("google_drive", "duplicate");
              continue;
            }
            if (!file.id || !admittedNewIds.has(file.id)) {
              skipped.push(file.name || "Unknown");
              budget.recordSkip("google_drive", "job_item_limit");
              continue;
            }

            const result = await ingestDriveEvidence({
              userId: ctx.user.id,
              accountId: input.accountId,
              caseId: input.caseId,
              fileId: file.id!,
              title: file.name || "Untitled",
              description: `Imported from Google Drive folder: ${input.folderName}`,
              budget,
              metadata: {
                folderId: input.folderId,
                folderName: input.folderName,
                driveAccountId: input.accountId,
              },
            });

            imported.push(file.name || "Unknown");
            if (file.id) importedDriveIds.add(file.id);
            if (result.analysisError) errors.push(`${file.name} analysis: ${result.analysisError}`);
          } catch (error) {
            errors.push(`${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`);
          }
        }

        const ingestion = budget.summary();

        return {
          success: errors.length === 0 && ingestion.outcome === "completed",
          outcome: ingestion.outcome,
          totalFiles: files.length,
          imported: imported.length,
          skipped: skipped.length,
          errors,
          importedFiles: imported,
          ingestion,
        };
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: error instanceof Error ? error.message : "Failed to import folder",
        });
      }
    }),
});

/**
 * Determine evidence type from MIME type
 */
function determineEvidenceType(mimeType?: string): "document" | "email" | "photo" | "video" | "audio" | "other" {
  if (!mimeType) return "document";

  if (mimeType === "message/rfc822") return "email";
  if (mimeType.startsWith("image/")) return "photo";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.includes("pdf")) return "document";
  if (mimeType.includes("word") || mimeType.includes("document")) return "document";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return "document";
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "document";
  if (mimeType.includes("text")) return "document";

  return "other";
}
