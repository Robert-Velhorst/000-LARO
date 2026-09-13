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
import { emailAccounts, evidence } from "../schema";
import { eq, and } from "drizzle-orm";
import { beginOAuthFlowAsync } from "../oauth2";
import { pullEvidenceByKeywords } from "../autoCollectionService";
import { assertCaseOwnership } from "../_core/authz";
import { createEvidenceFile } from "../evidence";
import { analyzeStoredEvidence } from "../documentAnalysisService";
import { supportsDocumentAnalysisMime } from "../documentIntelligence";
import { revokeStoredGoogleTokens } from "../emailOAuth";
import { AUDIT_ACTIONS, createAuditLog, writeAuditLogOrThrow } from "../audit";
import { PROVIDER_LIMITS } from "../providerLimits";
import { enforcePersistentRateLimit, RATE_LIMITS } from "../rateLimit";

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
}) {
  await assertCaseOwnership(options.caseId, options.userId);
  const fileData = await downloadAndUploadGoogleDriveFile(
    options.fileId,
    options.caseId,
    options.userId,
    options.accountId,
  );
  const evidenceId = await createEvidenceFile(options.userId, {
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
  let analysisError: string | null = null;
  if (supportsDocumentAnalysisMime(fileData.mimeType)) {
    try {
      await analyzeStoredEvidence({ userId: options.userId, evidenceId, deepAnalysis: false });
    } catch (error) {
      analysisError = error instanceof Error ? error.message : "Automatic document analysis failed";
    }
  }
  return { evidenceId, analysisError };
}

/**
 * Google Drive Router
 * Handles folder browsing, file discovery, and evidence collection from Google Drive
 */
export const googleDriveRouter = router({
  /**
   * Status endpoint used by GoogleDriveIntegration.tsx. Reports both whether
   * the user has Drive access (via Gmail OAuth — same connection) and a
   * rough per-case summary so the legacy UI keeps working.
   */
  getStatus: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      }

      const accounts = await db
        .select()
        .from(emailAccounts)
        .where(and(
          eq(emailAccounts.userId, ctx.user.id),
          eq(emailAccounts.provider, "gmail"),
          eq(emailAccounts.status, "connected"),
        ));

      const connected = accounts.length > 0;

      // Count Drive-sourced evidence for the case.
      const rows = await db
        .select()
        .from(evidence)
        .where(and(
          eq(evidence.caseId, input.caseId),
          eq(evidence.userId, ctx.user.id),
          eq(evidence.source, "google_drive")
        ));
      const itemsCollected = rows.length;

      return {
        connected,
        status: connected
          ? {
              id: accounts[0].id,
              status: "connected",
              itemsCollected: String(itemsCollected),
              lastSyncedAt: accounts[0].connectedAt,
            }
          : null,
      };
    }),

  /**
   * Return the OAuth URL the renderer should open to connect Google Drive.
   * Drive access piggy-backs on the Gmail OAuth scopes, so this just kicks
   * off the Gmail flow.
   */
  connect: protectedProcedure.mutation(async ({ ctx }) => {
    const url = await beginOAuthFlowAsync("gmail", ctx.user.id);
    return { authUrl: url };
  }),

  /**
   * Disconnect: removes the Gmail/Drive credentials for the user. Note this
   * removes Gmail access too because they share one OAuth token.
   */
  disconnect: protectedProcedure
    .input(z.object({ caseId: z.string().optional(), sourceId: z.string().optional() }))
    .mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

      const accounts = await db.select().from(emailAccounts).where(
        and(eq(emailAccounts.userId, ctx.user.id), eq(emailAccounts.provider, "gmail"))
      );
      const revocationOutcomes: string[] = [];
      try {
        for (const account of accounts) {
          revocationOutcomes.push(await revokeStoredGoogleTokens(account));
        }
      } catch (error) {
        await createAuditLog({
          userId: ctx.user.id,
          action: AUDIT_ACTIONS.PROVIDER_DISCONNECT_FAILED,
          entityType: "provider_connection",
          entityId: "google",
          details: {
            provider: "google",
            route: "googleDrive.disconnect",
            accountCount: accounts.length,
            reason: "upstream_revocation_failed",
            localStateRetained: true,
          },
        });
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Google did not confirm token revocation; the local connection was retained so disconnect can be retried.",
          cause: error,
        });
      }

      const revocationConfirmed = revocationOutcomes.some(
        (outcome) => outcome === "revoked" || outcome === "already_invalid"
      );
      db.transaction((tx: any) => {
        tx.delete(emailAccounts)
          .where(and(eq(emailAccounts.userId, ctx.user.id), eq(emailAccounts.provider, "gmail")))
          .run();
        writeAuditLogOrThrow(tx, {
          userId: ctx.user.id,
          action: revocationConfirmed
            ? AUDIT_ACTIONS.PROVIDER_DISCONNECT_REVOKED
            : AUDIT_ACTIONS.PROVIDER_DISCONNECTED,
          entityType: "provider_connection",
          entityId: "google",
          details: {
            provider: "google",
            route: "googleDrive.disconnect",
            accountCount: accounts.length,
            revocationOutcomes,
            localCredentialsRemoved: true,
          },
        });
      });
      return { success: true };
    }),

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

      const result = await pullEvidenceByKeywords({
        caseId: input.caseId,
        userId: ctx.user.id,
        keywords,
        includeGmail: false,
        includeDrive: true,
        includeLocal: false,
      });

      return {
        success: true,
        progress: {
          totalFiles: result.driveFiles + result.gmailAttachments,
          processedFiles: result.driveFiles + result.gmailAttachments,
          extractedContent: result.gmailMessages,
          errors: result.errors,
        },
      };
    }),

  /**
   * Check if user has Google Drive connected
   */
  checkConnection: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

    const accounts = await db
      .select()
      .from(emailAccounts)
      .where(and(
        eq(emailAccounts.userId, ctx.user.id),
        eq(emailAccounts.provider, "gmail"),
        eq(emailAccounts.status, "connected"),
      ));

    return {
      connected: accounts.length > 0,
      accounts: accounts.map(a => ({
        id: a.id,
        email: a.email,
        displayName: a.displayName,
      })),
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
        fileIds: z.array(driveId).min(1).max(PROVIDER_LIMITS.googleDrive.maxImportFiles),
        fileNames: z.array(driveName).min(1).max(PROVIDER_LIMITS.googleDrive.maxImportFiles),
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

      for (let i = 0; i < input.fileIds.length; i++) {
        const fileId = input.fileIds[i];
        const fileName = input.fileNames[i];

        try {
          const result = await ingestDriveEvidence({
            userId: ctx.user.id,
            accountId: input.accountId,
            caseId: input.caseId,
            fileId,
            title: fileName,
            description: "Imported from Google Drive",
          });

          imported.push(fileName);
          if (result.analysisError) errors.push(`${fileName} analysis: ${result.analysisError}`);
        } catch (error) {
          errors.push(`${fileName}: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
      }

      return {
        success: true,
        imported: imported.length,
        errors,
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
        if (newFiles.length > PROVIDER_LIMITS.googleDrive.maxImportFiles) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Drive folder imports are limited to ${PROVIDER_LIMITS.googleDrive.maxImportFiles} new files at a time. Narrow the folder or add keywords.`,
          });
        }

        for (const file of filesToImport) {
          try {
            if (file.id && importedDriveIds.has(file.id)) {
              skipped.push(file.name || "Unknown");
              continue;
            }

            const result = await ingestDriveEvidence({
              userId: ctx.user.id,
              accountId: input.accountId,
              caseId: input.caseId,
              fileId: file.id!,
              title: file.name || "Untitled",
              description: `Imported from Google Drive folder: ${input.folderName}`,
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

        return {
          success: true,
          totalFiles: files.length,
          imported: imported.length,
          skipped: skipped.length,
          errors,
          importedFiles: imported,
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
