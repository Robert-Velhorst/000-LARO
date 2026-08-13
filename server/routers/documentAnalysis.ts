import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { assertCaseOwnership } from "../_core/authz";
import { buildCaseReconstruction } from "../caseReconstruction";
import { protectedProcedure, router } from "../_core/trpc";
import { analyzeStoredEvidence, parseDocumentAnalysisResult } from "../documentAnalysisService";
import { DOCUMENT_ANALYSIS_VERSION, supportedDocumentAnalysisMimeTypes } from "../documentIntelligence";
import { getDb } from "../db";
import { documentAnalyses, evidence, timeline as persistedTimeline } from "../schema";
import { getWorkflowPreferences } from "../workflowPreferences";
import { getLLMProviderDescriptors, invokeLLM, isLLMProviderConfigured } from "../llm";
import { createAuditLog } from "../audit";

const timelineCategorySchema = z.enum(["employment", "termination", "communication", "legal", "financial", "other"]);

function timelineEventKey(event: { date: string; title: string; source: { evidenceId: string } }): string {
  return `${event.date}|${event.title.trim().toLowerCase()}|${event.source.evidenceId}`;
}

function llmResponseText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part ? String(part.text) : "").join("\n");
}

function parseTimelineMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function correctionSequence(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sequence = (value as Record<string, unknown>).sequence;
  return typeof sequence === "number" && Number.isFinite(sequence) ? sequence : null;
}

export const documentAnalysisRouter = router({
  capabilities: protectedProcedure.query(async ({ ctx }) => {
    const preferences = await getWorkflowPreferences(ctx.user.id);
    return {
      version: DOCUMENT_ANALYSIS_VERSION,
      localAnalysis: true,
      deepAnalysisConfigured: getLLMProviderDescriptors().some((provider) => provider.configured),
      providers: getLLMProviderDescriptors(),
      selectedAnalysisMode: preferences.analysisMode,
      selectedAnalysisProvider: preferences.analysisProvider,
      autoAnalyzeImports: preferences.autoAnalyzeImports,
      shareRawDocumentContent: preferences.shareRawDocumentContent,
      supportedMimeTypes: supportedDocumentAnalysisMimeTypes(),
      ocrAvailable: true,
      ocrLanguages: ["nld", "eng"],
      ocrProcessing: "local" as const,
    };
  }),

  analyzeEvidence: protectedProcedure
    .input(z.object({
      evidenceId: z.string().min(1),
      deepAnalysis: z.boolean().optional(),
      force: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await analyzeStoredEvidence({ userId: ctx.user.id, ...input });
      } catch (error) {
        if (error instanceof TRPCError) throw error;
        const message = error instanceof Error ? error.message : "Document analysis failed";
        throw new TRPCError({
          code: message === "Evidence file not found" ? "NOT_FOUND" : "PRECONDITION_FAILED",
          message,
        });
      }
    }),

  byEvidence: protectedProcedure
    .input(z.object({ evidenceId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      const [row] = await db
        .select()
        .from(documentAnalyses)
        .where(and(eq(documentAnalyses.evidenceId, input.evidenceId), eq(documentAnalyses.userId, ctx.user.id)))
        .orderBy(desc(documentAnalyses.updatedAt))
        .limit(1);
      return row ? { id: row.id, result: parseDocumentAnalysisResult(row.result), updatedAt: row.updatedAt } : null;
    }),

  byCase: protectedProcedure
    .input(z.object({ caseId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const db = await getDb();
      const rows = await db
        .select()
        .from(documentAnalyses)
        .where(and(eq(documentAnalyses.caseId, input.caseId), eq(documentAnalyses.userId, ctx.user.id)))
        .orderBy(desc(documentAnalyses.updatedAt));
      return rows.map((row) => {
        const result = parseDocumentAnalysisResult(row.result);
        return {
          id: row.id,
          evidenceId: row.evidenceId,
          documentType: result.documentType,
          summary: result.summary,
          confidence: result.confidence,
          providerStatus: result.providerStatus,
          updatedAt: row.updatedAt,
        };
      });
    }),

  correctCaseTimeline: protectedProcedure
    .input(z.object({
      caseId: z.string().min(1),
      instruction: z.string().trim().min(5).max(2_000),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const preferences = await getWorkflowPreferences(ctx.user.id);
      const provider = preferences.analysisProvider === "local" ? null : preferences.analysisProvider;
      if (!provider || !preferences.shareRawDocumentContent || !isLLMProviderConfigured(provider)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Natural-language timeline editing needs full-source cloud analysis and a configured external provider selected in Settings.",
        });
      }
      const db = await getDb();
      const [analysisRows, evidenceRows, correctionRows] = await Promise.all([
        db.select({ analysis: documentAnalyses, evidenceTitle: evidence.title })
          .from(documentAnalyses)
          .innerJoin(evidence, eq(documentAnalyses.evidenceId, evidence.id))
          .where(and(eq(documentAnalyses.caseId, input.caseId), eq(documentAnalyses.userId, ctx.user.id))),
        db.select({ id: evidence.id, title: evidence.title })
          .from(evidence)
          .where(and(eq(evidence.caseId, input.caseId), eq(evidence.userId, ctx.user.id))),
        db.select()
          .from(persistedTimeline)
          .where(and(eq(persistedTimeline.caseId, input.caseId), eq(persistedTimeline.userId, ctx.user.id)))
          .orderBy(asc(persistedTimeline.createdAt), asc(persistedTimeline.id)),
      ]);
      const analyzedEvents = analysisRows.flatMap(({ analysis, evidenceTitle }) => {
        const result = parseDocumentAnalysisResult(analysis.result);
        return result.timelineEvents.map((event) => ({
          date: event.date,
          title: event.title,
          description: event.text,
          actor: event.actor,
          category: event.category,
          evidenceId: analysis.evidenceId,
          evidenceTitle,
        }));
      });
      if (!analyzedEvents.length) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Analyze evidence before requesting a timeline correction." });
      }
      const evidenceTitles = new Map(evidenceRows.map((item) => [item.id, item.title]));
      const currentEvents = new Map(analyzedEvents.map((event) => [
        `${event.date}|${event.title.trim().toLowerCase()}|${event.evidenceId}`,
        event,
      ]));
      const orderedCorrectionRows = [...correctionRows].sort((left, right) => {
        const leftMetadata = parseTimelineMetadata(left.metadata).timelineCorrection;
        const rightMetadata = parseTimelineMetadata(right.metadata).timelineCorrection;
        const leftSequence = correctionSequence(leftMetadata);
        const rightSequence = correctionSequence(rightMetadata);
        if (leftSequence !== null || rightSequence !== null) return (leftSequence ?? 0) - (rightSequence ?? 0);
        return (left.createdAt?.getTime() || 0) - (right.createdAt?.getTime() || 0) || left.id.localeCompare(right.id);
      });
      for (const row of orderedCorrectionRows) {
        if (row.eventType !== "ai_timeline_correction") continue;
        const metadata = parseTimelineMetadata(row.metadata);
        const value = metadata.timelineCorrection;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const correction = value as Record<string, unknown>;
        const operation = correction.operation;
        const targetKey = typeof correction.targetKey === "string" ? correction.targetKey : null;
        if ((operation === "remove" || operation === "update") && targetKey) currentEvents.delete(targetKey);
        if (operation !== "add" && operation !== "update") continue;
        const after = correction.after;
        if (!after || typeof after !== "object" || Array.isArray(after)) continue;
        const next = after as Record<string, unknown>;
        const evidenceId = typeof next.evidenceId === "string" ? next.evidenceId : "";
        const evidenceTitle = evidenceTitles.get(evidenceId);
        if (!evidenceTitle || typeof next.date !== "string" || typeof next.title !== "string") continue;
        const correctedEvent = {
          date: next.date,
          title: next.title,
          description: typeof next.description === "string" ? next.description : "",
          actor: typeof next.actor === "string" ? next.actor : null,
          category: timelineCategorySchema.safeParse(next.category).success
            ? next.category as z.infer<typeof timelineCategorySchema>
            : "other" as const,
          evidenceId,
          evidenceTitle,
        };
        currentEvents.set(`${correctedEvent.date}|${correctedEvent.title.trim().toLowerCase()}|${evidenceId}`, correctedEvent);
      }
      const eventMap = new Map([...currentEvents.values()].map((event, index) => [`E${index + 1}`, event]));
      const sourceMap = new Map(evidenceRows.map((item, index) => [`D${index + 1}`, item]));
      const response = await invokeLLM({
        provider,
        messages: [
          {
            role: "system",
            content: [
              "Translate the owner's timeline correction instruction into exactly one constrained operation.",
              "Never invent a document, date, actor, or event. For update/remove choose a supplied event ID.",
              "For add choose a supplied document ID and only use details explicit in the instruction.",
              "Return JSON only.",
            ].join(" "),
          },
          {
            role: "user",
            content: `Instruction: ${input.instruction}\n\nEvents:\n${[...eventMap.entries()].map(([id, event]) => `${id}: ${event.date} | ${event.title} | ${event.description} | source ${event.evidenceTitle}`).join("\n")}\n\nDocuments:\n${[...sourceMap.entries()].map(([id, item]) => `${id}: ${item.title}`).join("\n")}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "timeline_correction",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                operation: { type: "string", enum: ["add", "update", "remove"] },
                targetEventId: { type: ["string", "null"] },
                sourceDocumentId: { type: ["string", "null"] },
                date: { type: ["string", "null"] },
                title: { type: ["string", "null"] },
                description: { type: ["string", "null"] },
                actor: { type: ["string", "null"] },
                category: { type: ["string", "null"], enum: ["employment", "termination", "communication", "legal", "financial", "other", null] },
                reason: { type: "string" },
              },
              required: ["operation", "targetEventId", "sourceDocumentId", "date", "title", "description", "actor", "category", "reason"],
            },
          },
        },
        max_tokens: 800,
      });
      const parsed = z.object({
        operation: z.enum(["add", "update", "remove"]),
        targetEventId: z.string().nullable(),
        sourceDocumentId: z.string().nullable(),
        date: z.string().nullable(),
        title: z.string().nullable(),
        description: z.string().nullable(),
        actor: z.string().nullable(),
        category: timelineCategorySchema.nullable(),
        reason: z.string().min(1),
      }).parse(JSON.parse(llmResponseText(response.choices[0]?.message.content) || "{}"));
      const target = parsed.targetEventId ? eventMap.get(parsed.targetEventId) : null;
      if (parsed.operation !== "add" && !target) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The requested timeline event could not be identified safely." });
      }
      const sourceDocument = parsed.sourceDocumentId ? sourceMap.get(parsed.sourceDocumentId) : null;
      if (parsed.operation === "add" && !sourceDocument) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A source document is required for a new timeline event." });
      }
      const evidenceId = target?.evidenceId || sourceDocument!.id;
      const nextEvent = parsed.operation === "remove" ? null : {
        date: parsed.date || target?.date,
        title: parsed.title || target?.title,
        description: parsed.description || target?.description || "",
        actor: parsed.actor ?? target?.actor ?? null,
        category: parsed.category || target?.category || "other",
        evidenceId,
      };
      if (nextEvent && (!/^\d{4}-\d{2}-\d{2}$/.test(nextEvent.date || "") || !nextEvent.title)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The correction needs an exact YYYY-MM-DD date and title." });
      }
      const targetKey = target ? `${target.date}|${target.title.trim().toLowerCase()}|${target.evidenceId}` : null;
      const sequence = correctionRows.reduce((latest, row) => {
        if (row.eventType !== "ai_timeline_correction") return latest;
        const value = parseTimelineMetadata(row.metadata).timelineCorrection;
        const valueSequence = correctionSequence(value);
        return valueSequence === null ? latest : Math.max(latest, valueSequence);
      }, 0) + 1;
      const correction = {
        sequence,
        operation: parsed.operation,
        targetKey,
        before: target,
        after: nextEvent,
        instruction: input.instruction,
        reason: parsed.reason,
        provider,
      };
      const id = `TIMECORR-${nanoid(16)}`;
      await db.insert(persistedTimeline).values({
        id,
        caseId: input.caseId,
        userId: ctx.user.id,
        eventType: "ai_timeline_correction",
        title: nextEvent?.title || target?.title || "Timeline correction",
        description: parsed.reason,
        eventAt: nextEvent?.date ? new Date(`${nextEvent.date}T12:00:00Z`) : new Date(),
        metadata: JSON.stringify({ evidenceId, timelineCorrection: correction }),
        createdAt: new Date(),
      });
      await createAuditLog({
        userId: ctx.user.id,
        action: "timeline.ai_correction_applied",
        entityType: "timeline",
        entityId: id,
        details: correction,
      });
      return { id, operation: parsed.operation, before: target, after: nextEvent, reason: parsed.reason };
    }),

  generateCaseTimeline: protectedProcedure
    .input(z.object({ caseId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const db = await getDb();
      const [rows, persistedRows, evidenceRows] = await Promise.all([
        db
          .select({ analysis: documentAnalyses, evidenceTitle: evidence.title })
          .from(documentAnalyses)
          .innerJoin(evidence, eq(documentAnalyses.evidenceId, evidence.id))
          .where(and(eq(documentAnalyses.caseId, input.caseId), eq(documentAnalyses.userId, ctx.user.id)))
          .orderBy(asc(documentAnalyses.createdAt)),
        db
          .select()
          .from(persistedTimeline)
          .where(and(eq(persistedTimeline.caseId, input.caseId), eq(persistedTimeline.userId, ctx.user.id)))
          .orderBy(asc(persistedTimeline.createdAt), asc(persistedTimeline.id)),
        db
          .select({
            id: evidence.id,
            title: evidence.title,
            description: evidence.description,
            source: evidence.source,
            type: evidence.type,
            metadata: evidence.metadata,
            createdAt: evidence.createdAt,
          })
          .from(evidence)
          .where(and(eq(evidence.caseId, input.caseId), eq(evidence.userId, ctx.user.id))),
      ]);

      const analyzedEvents = rows.flatMap(({ analysis, evidenceTitle }) => {
        const result = parseDocumentAnalysisResult(analysis.result);
        const citations = new Map(result.citations.map((citation) => [citation.id, citation]));
        return result.timelineEvents.map((event) => ({
          ...event,
          description: event.text,
          source: {
            evidenceId: analysis.evidenceId,
            title: evidenceTitle,
            citation: citations.get(event.citations[0]) ?? null,
          },
        }));
      });
      const evidenceTitles = new Map(evidenceRows.map((item) => [item.id, item.title]));
      const storedEvents = persistedRows.flatMap((event) => {
        if (event.eventType === "ai_timeline_correction") return [];
        const metadata = parseTimelineMetadata(event.metadata);
        const evidenceId = typeof metadata.evidenceId === "string" ? metadata.evidenceId : null;
        const evidenceTitle = evidenceId ? evidenceTitles.get(evidenceId) : null;
        if (!event.eventAt || !evidenceId || !evidenceTitle) return [];
        const legacySource = metadata.legacySource && typeof metadata.legacySource === "object"
          ? metadata.legacySource as Record<string, unknown>
          : {};
        return [{
          date: event.eventAt.toISOString().slice(0, 10),
          title: event.title || "Imported legal event",
          text: event.description || "",
          description: event.description || "",
          actor: typeof legacySource.actor === "string" ? legacySource.actor : null,
          importance: "medium" as const,
          category: "legal" as const,
          citations: [] as string[],
          source: { evidenceId, title: evidenceTitle, citation: null },
        }];
      });
      const uniqueEvents = new Map<string, (typeof analyzedEvents)[number] | (typeof storedEvents)[number]>();
      for (const event of [...analyzedEvents, ...storedEvents]) {
        const key = timelineEventKey(event);
        if (!uniqueEvents.has(key)) uniqueEvents.set(key, event);
      }
      const corrections = persistedRows.flatMap((row) => {
        if (row.eventType !== "ai_timeline_correction") return [];
        const metadata = parseTimelineMetadata(row.metadata);
        const value = metadata.timelineCorrection;
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        return [{ id: row.id, createdAt: row.createdAt, ...(value as Record<string, unknown>) }];
      }) as Array<Record<string, unknown> & { id: string; createdAt: Date | null }>;
      corrections.sort((left, right) => {
        const leftSequence = typeof left.sequence === "number" ? left.sequence : null;
        const rightSequence = typeof right.sequence === "number" ? right.sequence : null;
        if (leftSequence !== null || rightSequence !== null) return (leftSequence ?? 0) - (rightSequence ?? 0);
        return (left.createdAt?.getTime() || 0) - (right.createdAt?.getTime() || 0) || left.id.localeCompare(right.id);
      });
      for (const correction of corrections) {
        const operation = correction.operation;
        const targetKey = typeof correction.targetKey === "string" ? correction.targetKey : null;
        if ((operation === "remove" || operation === "update") && targetKey) uniqueEvents.delete(targetKey);
        if (operation !== "add" && operation !== "update") continue;
        const after = correction.after;
        if (!after || typeof after !== "object" || Array.isArray(after)) continue;
        const value = after as Record<string, unknown>;
        const evidenceId = typeof value.evidenceId === "string" ? value.evidenceId : "";
        const evidenceTitle = evidenceTitles.get(evidenceId);
        if (!evidenceTitle || typeof value.date !== "string" || typeof value.title !== "string") continue;
        const correctedEvent = {
          date: value.date,
          title: value.title,
          text: typeof value.description === "string" ? value.description : "",
          description: typeof value.description === "string" ? value.description : "",
          actor: typeof value.actor === "string" ? value.actor : null,
          importance: "medium" as const,
          category: timelineCategorySchema.safeParse(value.category).success
            ? value.category as z.infer<typeof timelineCategorySchema>
            : "other" as const,
          citations: [] as string[],
          source: { evidenceId, title: evidenceTitle, citation: null },
        };
        uniqueEvents.set(timelineEventKey(correctedEvent), correctedEvent);
      }
      const events = [...uniqueEvents.values()].sort((left, right) => left.date.localeCompare(right.date));
      const analysesByEvidence = new Map(
        rows.map(({ analysis }) => [analysis.evidenceId, parseDocumentAnalysisResult(analysis.result)])
      );
      const reconstruction = buildCaseReconstruction({
        documents: evidenceRows.map((item) => ({
          evidenceId: item.id,
          title: item.title,
          description: item.description,
          source: item.source,
          type: item.type,
          metadata: item.metadata,
          createdAt: item.createdAt,
          analysis: analysesByEvidence.get(item.id) ?? null,
        })),
        events,
      });

      const parseTime = (value: string) => {
        const match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (match) return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        const time = Date.parse(value);
        return Number.isFinite(time) ? time : null;
      };
      const times = events.map((event) => parseTime(event.date)).filter((value): value is number => value !== null);
      const durationDays = times.length > 1 ? Math.ceil((Math.max(...times) - Math.min(...times)) / 86_400_000) : 0;
      return {
        events: events.map((event) => ({ ...event, eventKey: timelineEventKey(event) })),
        corrections,
        duration_days: durationDays,
        key_dates: [...new Set(events.map((event) => event.date))],
        summary: events.length
          ? `${events.length} source-linked event${events.length === 1 ? "" : "s"} from ${new Set(events.map((event) => event.source.evidenceId)).size} document${new Set(events.map((event) => event.source.evidenceId)).size === 1 ? "" : "s"}.`
          : "No dated events are available. Analyze case documents first.",
        gaps: events.length === 0 ? ["No analyzed or imported source-linked events are available for this case."] : [],
        reconstruction,
      };
    }),
});
