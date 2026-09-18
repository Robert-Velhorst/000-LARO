import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../_core/trpc";
import { getDb } from "../db";
import { cases, documentInbox, evidence } from "../schema";
import { getOwnedInboxItem, organizeInboxDocument, processInboxDocument, readInboxOriginal, stageInboxDocument } from "../documentInbox";
import { suggestDocumentCases } from "../documentCaseMatching";
import { MAX_EVIDENCE_BASE64_CHARS, MAX_EVIDENCE_FILE_BYTES, isSupportedDocumentAnalysisMimeType } from "../../shared/evidenceFiles";
import type { DocumentAnalysisResult } from "../documentIntelligence";
import { writeAuditLogOrThrow } from "../audit";
import { parseStoredDiscovery } from "../dossierDiscovery";
import { getInboxAssignment, inboxAssignmentHistory, reassignInboxDocument } from "../inboxAssignments";
import { randomUUID } from "node:crypto";
import {
  admitEvidenceIngestionRequest,
  EvidenceIngestionLimitError,
  withEvidenceIngestionRequestOperation,
} from "../evidenceIngestionBudget";
import { decodedBase64ByteLength, EVIDENCE_INGESTION_LIMITS } from "../../shared/evidenceIngestion";

const idInput = z.object({ id: z.string().min(1).max(100) });

export const documentInboxRouter = router({
  upload: protectedProcedure.input(z.object({
    fileName: z.string().trim().min(1).max(255), sourcePath: z.string().trim().min(1).max(2000).optional(),
    mimeType: z.string().min(1).max(255),
    ingestionJobId: z.string().min(1).max(200).optional(),
    ingestionItemId: z.string().min(1).max(200).optional(),
    base64: z.string().min(1).max(MAX_EVIDENCE_BASE64_CHARS).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })).mutation(async ({ ctx, input }) => {
    if (!isSupportedDocumentAnalysisMimeType(input.mimeType)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a supported document between 1 byte and 7 MB" });
    }
    const declaredBytes = decodedBase64ByteLength(input.base64);
    const ingestionJobId = input.ingestionJobId ?? randomUUID();
    const ingestionItemId = input.ingestionItemId ?? randomUUID();
    let ingestion: Awaited<ReturnType<typeof admitEvidenceIngestionRequest>>;
    try {
      ingestion = await admitEvidenceIngestionRequest({
        ownerId: ctx.user.id,
        jobId: ingestionJobId,
        itemId: ingestionItemId,
        source: "document_inbox",
        bytes: declaredBytes,
      });
    } catch (error) {
      if (error instanceof EvidenceIngestionLimitError) {
        throw new TRPCError({
          code: error.code === "file_empty" || error.code === "file_too_large"
            ? "PAYLOAD_TOO_LARGE"
            : error.code === "source_changed" ? "CONFLICT" : "TOO_MANY_REQUESTS",
          message: error.message,
        });
      }
      throw error;
    }
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.length !== declaredBytes || bytes.length > MAX_EVIDENCE_FILE_BYTES) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a supported document between 1 byte and 7 MB" });
    }
    try {
      return await withEvidenceIngestionRequestOperation({
        ownerId: ctx.user.id,
        jobId: ingestionJobId,
        source: "document_inbox",
      }, async () => {
        const item = await stageInboxDocument(ctx.user.id, { ...input, bytes });
        const analysisEligible = ingestion.items <= EVIDENCE_INGESTION_LIMITS.maxAnalysisItems;
        return {
          ...item,
          analysisEligible,
          ingestion: {
            outcome: analysisEligible ? "completed" as const : "partial" as const,
            processedItems: ingestion.items,
            processedBytes: ingestion.bytes,
            reasons: analysisEligible
              ? []
              : [{ source: "document_inbox" as const, code: "analysis_limit" as const, count: 1 }],
          },
        };
      });
    } catch (error) {
      if (error instanceof EvidenceIngestionLimitError) {
        throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: error.message });
      }
      throw error;
    }
  }),
  list: protectedProcedure.input(z.object({
    view: z.enum(["unassigned", "assigned", "all"]).default("unassigned"),
    limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).default(0),
  }).optional()).query(async ({ ctx, input }) => {
    const db = await getDb();
    const view = input?.view || "unassigned";
    const where = and(eq(documentInbox.userId, ctx.user.id), view === "unassigned" ? isNull(documentInbox.evidenceId)
      : view === "assigned" ? isNotNull(documentInbox.evidenceId) : undefined);
    const [total] = await db.select({ count: sql<number>`count(*)` }).from(documentInbox).where(where);
    const items = await db.select({ id: documentInbox.id, fileName: documentInbox.fileName, fileSize: documentInbox.fileSize,
      decision: documentInbox.decision, reason: documentInbox.reason, error: documentInbox.error,
      analyzed: sql<boolean>`${documentInbox.analysis} IS NOT NULL`.mapWith(Boolean), evidenceId: documentInbox.evidenceId,
      caseId: evidence.caseId, caseTitle: cases.clientName, createdAt: documentInbox.createdAt,
    }).from(documentInbox).leftJoin(evidence, and(eq(evidence.id, documentInbox.evidenceId), eq(evidence.userId, ctx.user.id)))
      .leftJoin(cases, and(eq(cases.id, evidence.caseId), eq(cases.userId, ctx.user.id)))
      .where(where).orderBy(desc(documentInbox.createdAt), desc(documentInbox.id)).limit(input?.limit || 20).offset(input?.offset || 0);
    return { items, total: Number(total.count) };
  }),
  get: protectedProcedure.input(idInput).query(async ({ ctx, input }) => {
    const item = await getOwnedInboxItem(ctx.user.id, input.id);
    const db = await getDb();
    const ownedCases = await db.select().from(cases).where(eq(cases.userId, ctx.user.id));
    return { id: item.id, fileName: item.fileName, sourcePath: item.sourcePath, evidenceId: item.evidenceId,
      decision: item.decision, reason: item.reason, error: item.error, contentHash: item.contentHash,
      discovery: parseStoredDiscovery(item.discovery),
      assignment: await getInboxAssignment(ctx.user.id, input.id),
      analysis: item.analysis ? JSON.parse(item.analysis) as DocumentAnalysisResult : null,
      suggestions: item.sourceText ? suggestDocumentCases(item.sourceText, ownedCases) : [],
    };
  }),
  process: protectedProcedure.input(idInput.extend({ force: z.boolean().optional() }))
    .mutation(({ ctx, input }) => processInboxDocument(ctx.user.id, input.id, input.force)),
  assign: protectedProcedure.input(idInput.extend({ caseId: z.string().min(1).max(100) }))
    .mutation(({ ctx, input }) => organizeInboxDocument(ctx.user.id, input.id, input.caseId)),
  reassign: protectedProcedure.input(idInput.extend({ caseId: z.string().min(1).max(100), expectedVersion: z.string().min(1).max(100), reason: z.string().trim().min(1).max(1500) }))
    .mutation(({ ctx, input }) => reassignInboxDocument(ctx.user.id, input)),
  assignmentHistory: protectedProcedure.input(idInput.extend({ offset: z.number().int().min(0).default(0) }))
    .query(({ ctx, input }) => inboxAssignmentHistory(ctx.user.id, input.id, input.offset)),
  download: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const { row, bytes } = await readInboxOriginal(ctx.user.id, input.id);
    const db = await getDb();
    writeAuditLogOrThrow(db, { userId: ctx.user.id, action: "inbox.source_requested", entityType: "document_inbox", entityId: row.id,
      details: { contentHash: row.contentHash } });
    return { fileName: row.fileName, base64: bytes.toString("base64") };
  }),
});
