import { router, protectedProcedure } from "../_core/trpc";
import { assertCaseAccess, assertCaseOwnership } from "../_core/authz";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { GapAnalysisInputsChangedError, gapDetectionService } from "../gapDetection";
import { kvkIntegrationService } from "../kvkIntegration";
import { rechtspraakIntegrationService } from "../rechtspraakIntegration";
import { searchOfficialLegislation } from "../wettenOverheid";
import {
  classifyPublicResearchError,
  normalizePublicResearchQuery,
  recordPublicResearch,
  researchStateFromOutcome,
} from "../publicResearch";
import { legalDocumentGeneratorService } from "../legalDocumentGenerator";
import { getDb } from "../db";
import {
  communicationGaps,
  expectedDocuments,
  suspiciousPatterns,
  legalInferences,
  evidenceCoverageAnalysis,
  cases,
} from "../schema";
import { desc, eq } from "drizzle-orm";
import {
  buildGapAnalysisInputSnapshot,
  EVIDENCE_COVERAGE_CONTRACT_VERSION,
} from "../evidenceCoverage";

const parseData = (raw: string | null) => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const parseStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const RETIRED_COVERAGE_REASON =
  "This saved row was produced by the retired scoring contract. Re-run coverage review to create a source-revision inventory.";

type NormalizedCoverageRow = Omit<typeof evidenceCoverageAnalysis.$inferSelect, "data"> & {
  contractVersion: string;
  contractStatus: "current" | "retired";
  analysisStatus?: "fresh" | "stale" | "running" | "failed" | "unavailable";
  inputRevision?: string;
  inputs?: unknown[];
  retirementReason?: string;
  [key: string]: unknown;
};

function normalizeCoverageRow(
  row: typeof evidenceCoverageAnalysis.$inferSelect,
): NormalizedCoverageRow {
  const data = parseData(row.data) as Record<string, any>;
  const { data: _rawData, ...record } = row;
  if (
    data.contractVersion === EVIDENCE_COVERAGE_CONTRACT_VERSION
    && data.contractStatus === "current"
    && Array.isArray(data.inputs)
  ) {
    return {
      ...record,
      contractVersion: EVIDENCE_COVERAGE_CONTRACT_VERSION,
      contractStatus: "current",
      analysisStatus: ["fresh", "stale", "running", "failed", "unavailable"].includes(data.analysisStatus)
        ? data.analysisStatus
        : typeof data.inputRevision === "string" ? "fresh" : "stale",
      startedAt: data.startedAt,
      generatedAt: data.generatedAt,
      completedAt: data.completedAt,
      caseRevision: data.caseRevision,
      inputRevision: data.inputRevision,
      sourceRevision: data.sourceRevision,
      snapshotRevision: data.snapshotRevision,
      inputs: data.inputs,
      counts: data.counts,
      missingContext: data.missingContext,
      legalBasis: data.legalBasis,
      unknowns: data.unknowns,
      limitations: data.limitations,
      reviewActions: data.reviewActions,
      summary: data.summary,
      staleReason: data.staleReason,
      failureCode: data.failureCode,
      failureMessage: data.failureMessage,
    };
  }
  return {
    ...record,
    contractVersion: typeof data.contractVersion === "string"
      ? data.contractVersion
      : "legacy-case-strength-v0",
    contractStatus: "retired" as const,
    retirementReason: typeof data.retirementReason === "string"
      ? data.retirementReason
      : RETIRED_COVERAGE_REASON,
  };
}

type GapAnalysisState = {
  status: "none" | "fresh" | "stale" | "running" | "failed" | "unavailable" | "retired";
  coverage: NormalizedCoverageRow | null;
  reason?: string;
};

async function resolveGapAnalysisState(caseId: string): Promise<GapAnalysisState> {
  const db = await getDb();
  if (!db) return {
    status: "unavailable",
    coverage: null,
    reason: "The analysis store is unavailable.",
  };
  const rows = await db.select().from(evidenceCoverageAnalysis)
    .where(eq(evidenceCoverageAnalysis.caseId, caseId))
    .orderBy(desc(evidenceCoverageAnalysis.createdAt), desc(evidenceCoverageAnalysis.id))
    .limit(1);
  if (rows.length === 0) return { status: "none", coverage: null };

  const coverage = normalizeCoverageRow(rows[0]);
  if (coverage.contractStatus === "retired") return {
    status: "retired",
    coverage,
    reason: coverage.retirementReason,
  };
  if (coverage.analysisStatus === "running") return { status: "running", coverage };
  if (coverage.analysisStatus === "failed") return {
    status: "failed",
    coverage,
    reason: typeof coverage.failureMessage === "string"
      ? coverage.failureMessage
      : "The latest coverage review failed.",
  };
  if (coverage.analysisStatus === "unavailable") return {
    status: "unavailable",
    coverage,
    reason: "LARO could not verify whether the saved review matches the current inputs.",
  };
  if (coverage.analysisStatus === "stale" || !coverage.inputRevision) return {
    status: "stale",
    coverage: { ...coverage, analysisStatus: "stale" },
    reason: "The saved review is not bound to the current case inputs.",
  };
  try {
    const current = await buildGapAnalysisInputSnapshot(caseId);
    if (current.inputRevision !== coverage.inputRevision) return {
      status: "stale",
      coverage: { ...coverage, analysisStatus: "stale" },
      reason: "Case, evidence, source-analysis, or timeline inputs changed after this review.",
    };
    return { status: "fresh", coverage: { ...coverage, analysisStatus: "fresh" } };
  } catch {
    return {
      status: "unavailable",
      coverage,
      reason: "LARO could not verify whether the saved review matches the current inputs.",
    };
  }
}

export const gapAnalysisRouter = router({
  /**
   * Run gap analysis for a case
   */
  analyze: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id); // Phase 008
      try {
        return await gapDetectionService.analyzeCase(input.caseId);
      } catch (error) {
        if (error instanceof GapAnalysisInputsChangedError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw error;
      }
    }),

  /**
   * Get communication gaps for a case
   */
  getGaps: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseAccess(input.caseId, ctx.user.id);
      if ((await resolveGapAnalysisState(input.caseId)).status !== "fresh") return [];
      const db = await getDb();
      if (!db) return [];

      const gaps = await db
        .select()
        .from(communicationGaps)
        .where(eq(communicationGaps.caseId, input.caseId));

      return gaps.map((gap) => ({
        ...gap,
        ...parseData(gap.data),
        precedingEvents: (() => {
          const data = parseData(gap.data);
          if (Array.isArray(data.precedingEvents)) return data.precedingEvents;
          if (typeof data.precedingEvents === "string") {
            try {
              const parsed = JSON.parse(data.precedingEvents);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          }
          return [];
        })(),
        legalImplications: (() => {
          const data = parseData(gap.data);
          if (Array.isArray(data.legalImplications)) return data.legalImplications;
          if (typeof data.legalImplications === "string") {
            try {
              const parsed = JSON.parse(data.legalImplications);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          }
          return [];
        })(),
      }));
    }),

  /**
   * Get expected documents for a case
   */
  getExpectedDocuments: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseAccess(input.caseId, ctx.user.id);
      if ((await resolveGapAnalysisState(input.caseId)).status !== "fresh") return [];
      const db = await getDb();
      if (!db) return [];

      const docs = await db
        .select()
        .from(expectedDocuments)
        .where(eq(expectedDocuments.caseId, input.caseId));

      return docs.map((doc) => ({
        ...doc,
        ...parseData(doc.data),
      }));
    }),

  /**
   * Get suspicious patterns for a case
   */
  getPatterns: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseAccess(input.caseId, ctx.user.id);
      if ((await resolveGapAnalysisState(input.caseId)).status !== "fresh") return [];
      const db = await getDb();
      if (!db) return [];

      const patterns = await db
        .select()
        .from(suspiciousPatterns)
        .where(eq(suspiciousPatterns.caseId, input.caseId));

      return patterns.map((pattern) => ({
        ...pattern,
        ...parseData(pattern.data),
        evidenceIds: (() => {
          const data = parseData(pattern.data);
          if (Array.isArray(data.evidenceIds)) return data.evidenceIds;
          if (typeof data.evidenceIds === "string") {
            try {
              const parsed = JSON.parse(data.evidenceIds);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          }
          return [];
        })(),
      }));
    }),

  /**
   * Get legal inferences for a case
   */
  getInferences: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseAccess(input.caseId, ctx.user.id);
      if ((await resolveGapAnalysisState(input.caseId)).status !== "fresh") return [];
      const db = await getDb();
      if (!db) return [];

      const inferences = await db
        .select()
        .from(legalInferences)
        .where(eq(legalInferences.caseId, input.caseId));

      return inferences.map((inference) => ({
        ...inference,
        ...parseData(inference.data),
        supportingEvidence: (() => {
          const data = parseData(inference.data);
          if (Array.isArray(data.supportingEvidence)) return data.supportingEvidence;
          if (typeof data.supportingEvidence === "string") {
            try {
              const parsed = JSON.parse(data.supportingEvidence);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          }
          return [];
        })(),
        caselaw: (() => {
          const data = parseData(inference.data);
          if (Array.isArray(data.caselaw)) return data.caselaw;
          if (typeof data.caselaw === "string") {
            try {
              const parsed = JSON.parse(data.caselaw);
              return Array.isArray(parsed) ? parsed : [];
            } catch {
              return [];
            }
          }
          return [];
        })(),
      }));
    }),

  /**
   * Get the versioned source-coverage and availability inventory.
   */
  getCoverage: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseAccess(input.caseId, ctx.user.id);
      const state = await resolveGapAnalysisState(input.caseId);
      return state.coverage ? {
        ...state.coverage,
        analysisStatus: state.status,
        statusReason: state.reason,
      } : null;
    }),

  /**
   * Get complete gap analysis summary for a case
   */
  getSummary: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseAccess(input.caseId, ctx.user.id);
      const db = await getDb();
      if (!db) {
        return {
          hasAnalysis: false,
          gapsCount: 0,
          criticalGapsCount: 0,
          missingDocsCount: 0,
          patternsCount: 0,
          inferencesCount: 0,
          analysisStatus: "unavailable" as const,
          statusReason: "The analysis store is unavailable.",
          coverage: null,
        };
      }

      const [state, gaps, expectedDocs, patterns, inferences] = await Promise.all([
        resolveGapAnalysisState(input.caseId),
        db.select().from(communicationGaps).where(eq(communicationGaps.caseId, input.caseId)),
        db
          .select()
          .from(expectedDocuments)
          .where(eq(expectedDocuments.caseId, input.caseId)),
        db
          .select()
          .from(suspiciousPatterns)
          .where(eq(suspiciousPatterns.caseId, input.caseId)),
        db.select().from(legalInferences).where(eq(legalInferences.caseId, input.caseId)),
      ]);

      const normalizedGaps = gaps.map((g) => ({ ...g, ...parseData(g.data) }));
      const normalizedDocs = expectedDocs.map((d) => ({ ...d, ...parseData(d.data) }));

      const hasDerivedRows = gaps.length > 0 || expectedDocs.length > 0 || patterns.length > 0 || inferences.length > 0;
      const analysisStatus = state.status === "none" && hasDerivedRows ? "retired" as const : state.status;
      const exposeDerived = analysisStatus === "fresh";
      const coverage = state.coverage || (hasDerivedRows ? {
        contractVersion: "legacy-case-strength-v0",
        contractStatus: "retired" as const,
        retirementReason: RETIRED_COVERAGE_REASON,
      } : null);

      return {
        hasAnalysis: hasDerivedRows || state.coverage !== null,
        analysisStatus,
        statusReason: state.reason,
        gapsCount: exposeDerived ? gaps.length : 0,
        criticalGapsCount: exposeDerived
          ? normalizedGaps.filter((g: any) => g.significance === "critical").length
          : 0,
        missingDocsCount: exposeDerived
          ? normalizedDocs.filter((d: any) => d.status === "missing").length
          : 0,
        patternsCount: exposeDerived ? patterns.length : 0,
        inferencesCount: exposeDerived ? inferences.length : 0,
        coverage: coverage ? { ...coverage, analysisStatus } : null,
      };
    }),

  /**
   * Get critical gaps summary for all user's cases (for dashboard alert)
   */
  getUserCriticalGaps: protectedProcedure
    .query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) {
        return {
          totalCriticalGaps: 0,
          totalMissingDocs: 0,
          casesAffected: 0,
          topCases: [],
        };
      }

      const userId = ctx.user.id;
      const [userCases, gapRows, expectedDocRows] = await Promise.all([
        db
          .select({ id: cases.id, clientName: cases.clientName })
          .from(cases)
          .where(eq(cases.userId, userId)),
        db
          .select({ caseId: communicationGaps.caseId, data: communicationGaps.data })
          .from(communicationGaps)
          .innerJoin(cases, eq(communicationGaps.caseId, cases.id))
          .where(eq(cases.userId, userId)),
        db
          .select({ caseId: expectedDocuments.caseId, data: expectedDocuments.data })
          .from(expectedDocuments)
          .innerJoin(cases, eq(expectedDocuments.caseId, cases.id))
          .where(eq(cases.userId, userId)),
      ]);

      if (userCases.length === 0) {
        return {
          totalCriticalGaps: 0,
          totalMissingDocs: 0,
          casesAffected: 0,
          topCases: [],
        };
      }

      const gapsByCase = new Map<string, Array<{ data: string | null }>>();
      for (const row of gapRows) {
        if (!row.caseId) continue;
        const rows = gapsByCase.get(row.caseId) || [];
        rows.push(row);
        gapsByCase.set(row.caseId, rows);
      }
      const expectedDocsByCase = new Map<string, Array<{ data: string | null }>>();
      for (const row of expectedDocRows) {
        if (!row.caseId) continue;
        const rows = expectedDocsByCase.get(row.caseId) || [];
        rows.push(row);
        expectedDocsByCase.set(row.caseId, rows);
      }

      const caseAnalyses = userCases.map((caseItem) => {
          const normalizedGaps = (gapsByCase.get(caseItem.id) || []).map((gap) => parseData(gap.data)) as any[];
          const normalizedDocs = (expectedDocsByCase.get(caseItem.id) || []).map((document) => parseData(document.data)) as any[];

          const criticalGaps = normalizedGaps.filter((g) => g.significance === "critical");
          const missingDocs = normalizedDocs.filter((d) => d.status === "missing");

          // Find oldest gap (longest time since last contact)
          let oldestGapDays: number | null = null;
          if (criticalGaps.length > 0) {
            const oldestGap = criticalGaps.reduce((oldest, gap) => {
              const gapDays = gap.durationDays ? parseInt(gap.durationDays) : 0;
              const oldestDays = oldest.durationDays ? parseInt(oldest.durationDays) : 0;
              return gapDays > oldestDays ? gap : oldest;
            });
            oldestGapDays = oldestGap.durationDays ? parseInt(oldestGap.durationDays) : null;
          }

          return {
            caseId: caseItem.id,
            caseName: caseItem.clientName || "Unnamed Case",
            criticalGaps: criticalGaps.length,
            missingDocs: missingDocs.length,
            oldestGapDays,
            totalSeverity: criticalGaps.length * 10 + missingDocs.length * 5,
          };
      });

      // Filter cases with critical issues
      const casesWithIssues = caseAnalyses.filter(
        (c) => c.criticalGaps > 0 || c.missingDocs > 0
      );

      // Sort by severity (most critical first)
      const sortedCases = casesWithIssues.sort((a, b) => b.totalSeverity - a.totalSeverity);

      return {
        totalCriticalGaps: casesWithIssues.reduce((sum, c) => sum + c.criticalGaps, 0),
        totalMissingDocs: casesWithIssues.reduce((sum, c) => sum + c.missingDocs, 0),
        casesAffected: casesWithIssues.length,
        topCases: sortedCases.slice(0, 5), // Top 5 most critical cases
      };
    }),

  /**
   * Look up company information via KvK (Dutch business registry)
   */
  lookupCompany: protectedProcedure
    .input(
      z.object({
        caseId: z.string().trim().min(1).max(128),
        kvkNumber: z.string().regex(/^\d{8}$/, "KvK number must contain exactly 8 digits"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const normalizedQuery = input.kvkNumber;
      const result = await kvkIntegrationService.lookupByKvKNumber(normalizedQuery);
      const state = researchStateFromOutcome(result.outcome);
      const research = await recordPublicResearch({
        userId: ctx.user.id,
        caseId: input.caseId,
        source: "kvk_open_dataset",
        normalizedQuery,
        retrievedAt: result.source?.retrievedAt ?? new Date().toISOString(),
        resultCount: result.success ? 1 : state.empty ? 0 : null,
        completeness: state.completeness,
        empty: state.empty,
      });
      return { ...result, research };
    }),

  /**
   * Search court records for opponent's litigation history
   */
  searchCourtRecords: protectedProcedure
    .input(
      z.object({
        caseId: z.string().trim().min(1).max(128),
        companyName: z.string().trim().min(3).max(200),
        searchType: z.enum(["company_history", "precedents"]).default("company_history"),
        legalIssue: z.string().trim().min(3).max(500).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const researchQuery = input.searchType === "precedents" && input.legalIssue
        ? input.legalIssue
        : input.companyName;
      const normalizedQuery = normalizePublicResearchQuery(researchQuery);
      const result = input.searchType === "precedents" && input.legalIssue
        ? await rechtspraakIntegrationService.searchPrecedents(input.legalIssue)
        : await rechtspraakIntegrationService.searchByCompany(input.companyName, 50);
      const state = researchStateFromOutcome(result.outcome);
      const research = await recordPublicResearch({
        userId: ctx.user.id,
        caseId: input.caseId,
        source: "rechtspraak_rss",
        normalizedQuery,
        retrievedAt: result.retrievedAt,
        resultCount: result.success ? result.totalResults : null,
        completeness: state.completeness,
        context: { searchType: input.searchType },
      });
      return {
        ...result,
        opponentHistory: input.searchType === "company_history"
          ? rechtspraakIntegrationService.summarizeOpponentHistory(result)
          : null,
        research,
      };
    }),

  searchLegislation: protectedProcedure
    .input(z.object({
      caseId: z.string().trim().min(1).max(128),
      query: z.string().trim().min(3).max(200),
      asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(25).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const normalizedQuery = normalizePublicResearchQuery(input.query);
      try {
        const result = await searchOfficialLegislation(input);
        const research = await recordPublicResearch({
          userId: ctx.user.id,
          caseId: input.caseId,
          source: "koop_bwb_sru",
          normalizedQuery,
          retrievedAt: result.retrievedAt,
          resultCount: result.results.length,
          completeness: result.completeness,
          empty: result.completeness === "complete" && result.results.length === 0,
          context: { asOfDate: result.asOfDate },
        });
        return { ...result, research };
      } catch (error) {
        const failure = classifyPublicResearchError(error, "KOOP legislation search");
        const retrievedAt = new Date().toISOString();
        const asOfDate = input.asOfDate || retrievedAt.slice(0, 10);
        const research = await recordPublicResearch({
          userId: ctx.user.id,
          caseId: input.caseId,
          source: "koop_bwb_sru",
          normalizedQuery,
          retrievedAt,
          resultCount: null,
          completeness: failure.outcome,
          context: { asOfDate },
        });
        return {
          success: false as const,
          query: normalizedQuery,
          asOfDate,
          retrievedAt,
          results: [],
          totalAvailable: null,
          completeness: failure.outcome,
          source: "KOOP Basiswettenbestand SRU 2.0" as const,
          coverageNotice: "No legal-source conclusion is available from this failed provider attempt.",
          error: failure.message,
          failureCode: failure.code,
          research,
        };
      }
    }),

  /**
   * Get opponent's complete litigation history
   */
  getOpponentHistory: protectedProcedure
    .input(z.object({
      caseId: z.string().trim().min(1).max(128),
      companyName: z.string().trim().min(3).max(200),
    }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const result = await rechtspraakIntegrationService.getOpponentHistory(input.companyName);
      const state = researchStateFromOutcome(result.outcome);
      const research = await recordPublicResearch({
        userId: ctx.user.id,
        caseId: input.caseId,
        source: "rechtspraak_rss",
        normalizedQuery: normalizePublicResearchQuery(input.companyName),
        retrievedAt: result.retrievedAt,
        resultCount: result.success ? result.totalCases : null,
        completeness: state.completeness,
        context: { searchType: "company_history" },
      });
      return { ...result, research };
    }),

  /**
   * Generate legal document based on gap analysis
   */
  generateDocument: protectedProcedure
    .input(
      z.object({
        caseId: z.string().trim().min(1).max(128),
        documentType: z.enum([
          "discovery_request",
          "preservation_notice",
          "spoliation_warning",
          "demand_letter",
        ]),
        demandAmount: z.number().finite().positive().max(1_000_000_000).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id); // Phase 008
      const analysisState = await resolveGapAnalysisState(input.caseId);
      if (analysisState.status !== "fresh") {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Run a current coverage review before generating a document from gap-analysis results.",
        });
      }
      const db = await getDb();
      if (!db) {
        return {
          success: false,
          error: "Database not available",
        };
      }

      // Get case data
      const { getCaseById } = await import("../db");
      const caseData = await getCaseById(input.caseId);
      if (!caseData) {
        return {
          success: false,
          error: "Case not found",
        };
      }

      // Get gap analysis data
      const [gaps, expectedDocs, patterns] = await Promise.all([
        db
          .select()
          .from(communicationGaps)
          .where(eq(communicationGaps.caseId, input.caseId)),
        db
          .select()
          .from(expectedDocuments)
          .where(eq(expectedDocuments.caseId, input.caseId)),
        db
          .select()
          .from(suspiciousPatterns)
          .where(eq(suspiciousPatterns.caseId, input.caseId)),
      ]);

      const normalizedGaps = gaps.map((g) => ({ ...g, ...parseData(g.data) })) as any[];
      const normalizedDocs = expectedDocs.map((d) => ({ ...d, ...parseData(d.data) })) as any[];
      const normalizedPatterns = patterns.map((p) => ({ ...p, ...parseData(p.data) })) as any[];

      // Prepare gap analysis data
      const gapAnalysisData = {
        caseId: input.caseId,
        clientName: caseData.clientName || "Client",
        opponentName: (caseData as any).opponentName || "Opponent",
        opponentAddress: (caseData as any).opponentAddress,
        gaps: normalizedGaps.map((g) => ({
          type: g.gapType || g.type || "gap",
          description: g.context || g.description || "",
          durationDays: g.durationDays ? parseInt(String(g.durationDays), 10) : undefined,
        })),
        missingDocuments: normalizedDocs
          .filter((d) => d.status === "missing")
          .map((d) => ({
            type: d.documentType,
            legalRequirement: d.legalRequirement || undefined,
            deadline: d.deadline || undefined,
          })),
        suspiciousPatterns: normalizedPatterns.map((p) => ({
          pattern: p.patternType,
          evidence: parseStringArray(p.evidenceIds).join(", "),
        })),
      };

      // Generate document
      let document;
      switch (input.documentType) {
        case "discovery_request":
          document = legalDocumentGeneratorService.generateDiscoveryRequest(gapAnalysisData);
          break;
        case "preservation_notice":
          document = legalDocumentGeneratorService.generatePreservationNotice(gapAnalysisData);
          break;
        case "spoliation_warning":
          document = legalDocumentGeneratorService.generateSpoliationWarning(gapAnalysisData);
          break;
        case "demand_letter":
          document = legalDocumentGeneratorService.generateDemandLetter(
            gapAnalysisData,
            input.demandAmount
          );
          break;
      }

      // Track usage (if user is authenticated)
      if (ctx.user) {
        const { trackUsage } = await import('../usageTracking');
        await trackUsage({
          userId: ctx.user.id,
          resourceType: 'document_generation',
          quantity: 1,
          metadata: {
            documentType: input.documentType,
            caseId: input.caseId,
          },
          caseId: input.caseId,
        });
      }

      // Phase 013: append the legal-advice disclaimer to every generated
      // document so no output can be mistaken for definitive legal advice.
      if (document) {
        const { LEGAL_DISCLAIMER } = await import("../../shared/const");
        document = {
          ...document,
          content: `${document.content}\n\n---\n${LEGAL_DISCLAIMER}`,
        };
      }

      return {
        success: true,
        document,
        disclaimer: (await import("../../shared/const")).LEGAL_DISCLAIMER,
      };
    }),
});
