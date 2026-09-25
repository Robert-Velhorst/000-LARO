import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { AUDIT_ACTIONS, createAuditLog } from "../audit";
import { buildCaseCsv, inspectCaseZipCompleteness, issueCaseZipDownloadTicket } from "../evidenceExport";
import { assertCaseAccess } from "../_core/authz";
import { enforceRateLimit, RATE_LIMITS } from "../rateLimit";
import { getCaseAuthorization } from "../teams";

function encodedDownload(filename: string, mimeType: string, buffer: Buffer) {
  return {
    filename,
    mimeType,
    base64: buffer.toString("base64"),
    bytes: buffer.length,
  };
}

export const evidenceExportRouter = router({
  getFormats: protectedProcedure.query(() => [
    { id: "csv" as const, label: "CSV spreadsheet", description: "Evidence index with scores and provenance hashes.", available: true },
    { id: "zip" as const, label: "ZIP evidence package", description: "Index, metadata, analyses, and available source documents.", available: true },
    { id: "pdf" as const, label: "PDF report", description: "Not available yet.", available: false },
  ]),

  exportCSV: protectedProcedure
    .input(z.object({ caseId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseAccess(input.caseId, ctx.user.id);
      const authorization = await getCaseAuthorization(input.caseId, ctx.user.id);
      const buffer = await buildCaseCsv(authorization!.ownerId, input.caseId);
      await createAuditLog({
        userId: ctx.user.id,
        action: AUDIT_ACTIONS.EVIDENCE_EXPORTED,
        entityType: "case",
        entityId: input.caseId,
        details: { format: "csv", bytes: buffer.length },
      });
      return encodedDownload(`case-${input.caseId}-evidence.csv`, "text/csv;charset=utf-8", buffer);
    }),

  exportZIP: protectedProcedure
    .input(z.object({ caseId: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      enforceRateLimit(ctx, "evidence-export", RATE_LIMITS.evidenceExport);
      await assertCaseAccess(input.caseId, ctx.user.id);
      const authorization = await getCaseAuthorization(input.caseId, ctx.user.id);
      const readiness = await inspectCaseZipCompleteness(authorization!.ownerId, input.caseId);
      if (readiness.completeness === "failed") {
        await createAuditLog({
          userId: ctx.user.id,
          action: AUDIT_ACTIONS.EVIDENCE_EXPORTED,
          entityType: "case",
          entityId: input.caseId,
          details: {
            format: "zip",
            completeness: "failed",
            omissionCount: readiness.omissions.length,
            omissions: readiness.omissions,
          },
        });
        return {
          filename: `case-${input.caseId}-evidence.zip`,
          mimeType: "application/zip" as const,
          url: null,
          ...readiness,
        };
      }
      const ticket = issueCaseZipDownloadTicket(ctx.user.id, input.caseId, authorization!.ownerId);
      return {
        filename: `case-${input.caseId}-evidence.zip`,
        mimeType: "application/zip" as const,
        url: `/api/case-export/${ticket}.zip`,
        ...readiness,
      };
    }),

  exportPDF: protectedProcedure
    .input(z.object({ caseId: z.string().min(1) }))
    .mutation(() => {
      throw new TRPCError({
        code: "NOT_IMPLEMENTED",
        message: "PDF export is not implemented. Use the ZIP evidence package or CSV index.",
      });
    }),
});
