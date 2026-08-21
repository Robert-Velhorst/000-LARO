import { z } from "zod";
import { evidenceUploadProcedure, protectedProcedure, router } from "../_core/trpc";
import {
  searchEvidenceFiles,
  getEvidenceFile,
  createEvidenceFile,
  deleteEvidenceFile,
  getEvidenceFilesByCase,
  getEvidenceStats,
} from "../evidence";
import { getDb } from "../db";
import { evidenceFiles } from "../schema";
import { eq, and, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { assertCaseOwnership } from "../_core/authz";
import { sanitizeFilename, storageDelete, storagePut } from "../storage";
import { managedStorageKeyFromMetadata } from "../managedStorage";
import { processQueuedStorageDeletions } from "../storageDeletionQueue";
import {
  isSupportedEvidenceMimeType,
  MAX_EVIDENCE_BASE64_CHARS,
  MAX_EVIDENCE_FILE_BYTES,
} from "../../shared/evidenceFiles";
import { TRPCError } from "@trpc/server";
import { getEvidenceDownloadUrl, recordEvidenceSourceOpened } from "../evidenceAccess";

export const evidenceFilesRouter = router({

  // Search / list evidence files
  search: protectedProcedure
    .input(z.object({
      caseId: z.string().optional(),
      query:  z.string().optional(),
      limit:  z.number().optional(),
      offset: z.number().optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const result = await searchEvidenceFiles({
        userId,
        caseId: input?.caseId,
        query:  input?.query,
        limit:  input?.limit,
        offset: input?.offset,
      });
      // Normalize: map evidence table rows to a consistent shape
      return result.files.map((f: any) => ({
        ...f,
        uploadSource: f.source ?? "manual",
        uploadedAt:   f.createdAt,
      }));
    }),

  // Get single file
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      return getEvidenceFile(userId, input.id);
    }),

  // Create evidence file record
  create: protectedProcedure
    .input(z.object({
      caseId:      z.string(),
      title:       z.string(),
      type:        z.enum(["document", "email", "chat", "photo", "video", "audio", "other"]),
      source:      z.string().optional(),
      description: z.string().optional(),
      fileUrl:     z.string().optional(),
      fileName:    z.string().optional(),
      fileSize:    z.string().optional(),
      mimeType:    z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      await assertCaseOwnership(input.caseId, userId);
      const id = await createEvidenceFile(userId, input);
      return { id };
    }),

  upload: evidenceUploadProcedure
    .input(z.object({
      caseId: z.string().min(1),
      title: z.string().min(1).max(500),
      type: z.enum(["document", "email", "chat", "photo", "video", "audio", "other"]),
      fileName: z.string().min(1).max(255),
      mimeType: z.string().min(1).max(255),
      source: z.enum(["manual", "desktop_scanner"]).optional().default("manual"),
      base64: z.string().min(1).max(MAX_EVIDENCE_BASE64_CHARS).regex(
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        "Invalid base64 evidence payload"
      ),
    }))
    .mutation(async ({ ctx, input }) => {
      const scannerCredential = ctx.authScope === "session" && ctx.desktopScanner;
      if (scannerCredential !== (input.source === "desktop_scanner")) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: scannerCredential
            ? "Scanner uploads must identify the desktop scanner source"
            : "Desktop scanner provenance requires a scanner credential",
        });
      }
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const bytes = Buffer.from(input.base64, "base64");
      if (!bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES) {
        throw new Error("Evidence uploads must be between 1 byte and 7 MB");
      }
      if (!isSupportedEvidenceMimeType(input.mimeType)) {
        throw new Error("Evidence file type is not supported");
      }

      const fileName = sanitizeFilename(input.fileName);
      const storageKey = `evidence/${input.caseId}/manual/${randomUUID()}-${fileName}`;
      const stored = await storagePut(storageKey, bytes, input.mimeType);
      try {
        const id = await createEvidenceFile(ctx.user.id, {
          caseId: input.caseId,
          title: input.title,
          type: input.type,
          source: input.source,
          fileName,
          fileSize: String(bytes.length),
          mimeType: input.mimeType,
          fileUrl: stored.url,
          contentHash: stored.sha256,
          metadata: JSON.stringify({ storageKey: stored.key }),
        });
        return { id, sha256: stored.sha256 };
      } catch (error) {
        await storageDelete(stored.key).catch(() => undefined);
        throw error;
      }
    }),

  // Delete
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      const file = await getEvidenceFile(userId, input.id);
      if (!file) return { success: false };
      const result = await deleteEvidenceFile(userId, input.id);
      const cleanup = await processQueuedStorageDeletions({ storageKeys: result.storageKeys });
      return {
        success: result.deleted && cleanup.requestedPending === 0,
        deletionStatus: cleanup.requestedPending > 0 ? "storage_cleanup_pending" as const : "completed" as const,
        storageCleanupPending: cleanup.requestedPending,
      };
    }),

  // By case
  byCase: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.user.id;
      return getEvidenceFilesByCase(userId, input.caseId);
    }),

  // Stats
  stats: protectedProcedure.query(async ({ ctx }) => {
      const userId = ctx.user.id;
      return getEvidenceStats(userId);
  }),

  // Get download URL (for file preview)
  getDownloadUrl: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw new Error("Not authenticated");
      const userId = ctx.user.id;
      const host = ctx.req.get?.("host") || ctx.req.headers.host;
      const requestBase = host ? `${ctx.req.protocol || "http"}://${host}` : undefined;
      const url = await getEvidenceDownloadUrl(userId, input.id, new Date(), requestBase);
      return url ? { url } : { url: null, message: "File not available for download" };
    }),

  // Record only after the renderer successfully dispatches the source URL.
  recordSourceOpened: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const file = await getEvidenceFile(ctx.user.id, input.id);
      if (!file) throw new Error("File not found");
      await recordEvidenceSourceOpened({
        userId: ctx.user.id,
        evidenceId: file.id,
        accessMethod: managedStorageKeyFromMetadata(file.metadata) ? "managed_storage" : "source_url",
      });
      return { success: true as const };
    }),

  // Also search evidence_files table (desktop scanner uploads go here)
  searchScanned: protectedProcedure
    .input(z.object({
      caseId: z.string().optional(),
      limit:  z.number().optional().default(50),
    }).optional())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];

      const userId = ctx.user.id;
      const conditions: any[] = [eq(evidenceFiles.userId, userId)];
      if (input?.caseId) conditions.push(eq(evidenceFiles.caseId, input.caseId));

      return await db
        .select()
        .from(evidenceFiles)
        .where(and(...conditions))
        .orderBy(desc(evidenceFiles.uploadedAt))
        .limit(input?.limit ?? 50);
    }),
});
