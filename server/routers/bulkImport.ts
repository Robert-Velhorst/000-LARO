import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { getDb } from "../db";
import { bulkImportJobs, cases } from "../schema";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { IMPORT_LIMITS, ImportValidationError, normalizeCaseCsvImport } from "../importLimits";
import { enforcePersistentRateLimit, RATE_LIMITS } from "../rateLimit";

function jobRowToListItem(job: typeof bulkImportJobs.$inferSelect) {
  return {
    id: job.id,
    filename: job.filename ?? "",
    status: job.status ?? "unknown",
    totalRows: Number(job.totalRows ?? 0),
    processedRows: Number(job.processedRows ?? 0),
    failedRows: Number(job.failedRows ?? 0),
    createdAt: job.createdAt ?? new Date(),
    completedAt: job.completedAt ?? null,
  };
}

export const bulkImportRouter = router({
  listJobs: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) return [];

    const rows = await db
      .select()
      .from(bulkImportJobs)
      .where(eq(bulkImportJobs.userId, ctx.user.id))
      .orderBy(desc(bulkImportJobs.createdAt))
      .limit(50);

    return rows.map(jobRowToListItem);
  }),

  getJobStatus: protectedProcedure
    .input(z.object({ jobId: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return null;

      const [job] = await db
        .select()
        .from(bulkImportJobs)
        .where(and(eq(bulkImportJobs.id, input.jobId), eq(bulkImportJobs.userId, ctx.user.id)))
        .limit(1);

      if (!job) return null;

      let meta: { aggregation?: Record<string, number> } = {};
      try {
        meta = job.metadata ? JSON.parse(job.metadata) : {};
      } catch {
        meta = {};
      }

      return {
        status: job.status ?? "unknown",
        filename: job.filename ?? "",
        processedRows: Number(job.processedRows ?? 0),
        totalRows: Number(job.totalRows ?? 0),
        failedRows: Number(job.failedRows ?? 0),
        aggregation: meta.aggregation,
      };
    }),

  uploadCSV: protectedProcedure
    .input(
      z.object({
        csvContent: z.string().max(IMPORT_LIMITS.csv.maxBytes),
        filename: z.string().max(IMPORT_LIMITS.csv.maxFilenameChars),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await enforcePersistentRateLimit(ctx, "bulk-case-import", RATE_LIMITS.bulkImport);
      const db = await getDb();
      if (!db) {
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
      }

      let normalized: ReturnType<typeof normalizeCaseCsvImport>;
      try {
        normalized = normalizeCaseCsvImport(input.csvContent, input.filename);
      } catch (error) {
        if (error instanceof ImportValidationError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
        }
        throw error;
      }

      const jobId = nanoid();
      try {
        db.transaction((tx) => {
          const now = new Date();
          tx.insert(bulkImportJobs).values({
            id: jobId,
            userId: ctx.user.id,
            filename: normalized.filename,
            status: "completed",
            totalRows: String(normalized.rows.length),
            processedRows: String(normalized.rows.length),
            failedRows: "0",
            completedAt: now,
            metadata: JSON.stringify({
              aggregation: {
                duplicatesRemoved: 0,
                originalCount: normalized.rows.length,
                consolidatedCount: normalized.rows.length,
              },
            }),
            createdAt: now,
          }).run();

          normalized.rows.forEach((row, index) => {
            const clientName =
              row.caseTitle || `Imported case ${index + 1}`;
            const caseSummary = row.description || "Imported via bulk CSV";
            const caseType = row.category || "General";
            const slug = clientName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")
              .slice(0, 32);
            const clientEmail = `${slug || "case"}-${index}-${jobId.slice(0, 8)}@bulk-import.invalid`;

            const caseId = `CASE${nanoid(12)}`;

            tx.insert(cases).values({
              id: caseId,
              userId: ctx.user.id,
              clientName,
              clientEmail,
              clientPhone: "",
              clientAddress: "",
              caseType,
              caseSummary,
              urgency: row.urgency,
              status: "Matching",
              metadata: row.tags
                ? JSON.stringify({ tags: row.tags, evidenceUrls: row.evidenceUrls })
                : row.evidenceUrls
                  ? JSON.stringify({ evidenceUrls: row.evidenceUrls })
                  : null,
              createdAt: now,
              updatedAt: now,
            } as any).run();
          });
        });
      } catch (error) {
        console.error("[BulkImport] Atomic case import failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "The import could not be completed; no cases were added.",
        });
      }

      return {
        success: true as const,
        jobId,
        totalRows: normalized.rows.length,
        errors: [] as string[],
      };
    }),
});
