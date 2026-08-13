import { router, protectedProcedure } from "../_core/trpc";
import { assertCaseOwnership } from "../_core/authz";
import { z } from "zod";
import { gapDetectionService } from "../gapDetection";
import { kvkIntegrationService } from "../kvkIntegration";
import { rechtspraakIntegrationService } from "../rechtspraakIntegration";
import { legalDocumentGeneratorService } from "../legalDocumentGenerator";
import { getDb } from "../db";
import {
  communicationGaps,
  expectedDocuments,
  suspiciousPatterns,
  legalInferences,
  caseStrengthAnalysis,
} from "../schema";
import { eq } from "drizzle-orm";

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

export const gapAnalysisRouter = router({
  /**
   * Run gap analysis for a case
   */
  analyze: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id); // Phase 008
      const result = await gapDetectionService.analyzeCase(input.caseId);
      return result;
    }),

  /**
   * Get communication gaps for a case
   */
  getGaps: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
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
      await assertCaseOwnership(input.caseId, ctx.user.id);
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
      await assertCaseOwnership(input.caseId, ctx.user.id);
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
      await assertCaseOwnership(input.caseId, ctx.user.id);
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
   * Get case strength analysis
   */
  getCaseStrength: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const db = await getDb();
      if (!db) return null;

      const analysis = await db
        .select()
        .from(caseStrengthAnalysis)
        .where(eq(caseStrengthAnalysis.caseId, input.caseId))
        .limit(1);

      if (analysis.length === 0) return null;

      const result = analysis[0];
      const data = parseData(result.data);
      return {
        ...result,
        ...data,
        strengths: Array.isArray(data.strengths) ? data.strengths : [],
        weaknesses: Array.isArray(data.weaknesses) ? data.weaknesses : [],
        recommendations: Array.isArray(data.recommendations) ? data.recommendations : [],
      };
    }),

  /**
   * Get complete gap analysis summary for a case
   */
  getSummary: protectedProcedure
    .input(z.object({ caseId: z.string() }))
    .query(async ({ input, ctx }) => {
      await assertCaseOwnership(input.caseId, ctx.user.id);
      const db = await getDb();
      if (!db) {
        return {
          hasAnalysis: false,
          gapsCount: 0,
          criticalGapsCount: 0,
          missingDocsCount: 0,
          patternsCount: 0,
          inferencesCount: 0,
          caseStrength: null,
        };
      }

      const [gaps, expectedDocs, patterns, inferences, strength] = await Promise.all([
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
        db
          .select()
          .from(caseStrengthAnalysis)
          .where(eq(caseStrengthAnalysis.caseId, input.caseId))
          .limit(1),
      ]);

      const normalizedGaps = gaps.map((g) => ({ ...g, ...parseData(g.data) }));
      const normalizedDocs = expectedDocs.map((d) => ({ ...d, ...parseData(d.data) }));

      return {
        hasAnalysis:
          gaps.length > 0 ||
          expectedDocs.length > 0 ||
          patterns.length > 0 ||
          inferences.length > 0 ||
          strength.length > 0,
        gapsCount: gaps.length,
        criticalGapsCount: normalizedGaps.filter((g: any) => g.significance === "critical").length,
        missingDocsCount: normalizedDocs.filter((d: any) => d.status === "missing").length,
        patternsCount: patterns.length,
        inferencesCount: inferences.length,
        caseStrength: strength.length > 0 ? strength[0] : null,
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
      // Get all user's cases directly from DB rather than allCases filter
      const userCases = await db.select().from(require("../schema").cases).where(eq(require("../schema").cases.userId, userId));

      if (userCases.length === 0) {
        return {
          totalCriticalGaps: 0,
          totalMissingDocs: 0,
          casesAffected: 0,
          topCases: [],
        };
      }

      // Get gap analysis for each case
      const caseAnalyses = await Promise.all(
        userCases.map(async (caseItem) => {
          const [gaps, expectedDocs] = await Promise.all([
            db
              .select()
              .from(communicationGaps)
              .where(eq(communicationGaps.caseId, caseItem.id)),
            db
              .select()
              .from(expectedDocuments)
              .where(eq(expectedDocuments.caseId, caseItem.id)),
          ]);

          const normalizedGaps = gaps.map((g) => ({ ...g, ...parseData(g.data) })) as any[];
          const normalizedDocs = expectedDocs.map((d) => ({ ...d, ...parseData(d.data) })) as any[];

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
        })
      );

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
        kvkNumber: z.string().optional(),
        caseText: z.string().optional(), // Extract KvK numbers from case description
      })
    )
    .mutation(async ({ input }) => {
      // If KvK number provided, look it up directly
      if (input.kvkNumber) {
        return await kvkIntegrationService.lookupByKvKNumber(input.kvkNumber);
      }

      // If case text provided, extract KvK numbers
      if (input.caseText) {
        const kvkNumbers = kvkIntegrationService.extractKvKNumbers(input.caseText);
        
        if (kvkNumbers.length === 0) {
          return {
            success: false,
            error: "No KvK numbers found in case text.",
          };
        }

        // Look up first KvK number found
        return await kvkIntegrationService.lookupByKvKNumber(kvkNumbers[0]);
      }

      return {
        success: false,
        error: "Please provide either a KvK number or case text to search.",
      };
    }),

  /**
   * Search court records for opponent's litigation history
   */
  searchCourtRecords: protectedProcedure
    .input(
      z.object({
        companyName: z.string().trim().min(3).max(200),
        searchType: z.enum(["company_history", "precedents"]).default("company_history"),
        legalIssue: z.string().trim().min(3).max(500).optional(),
      })
    )
    .mutation(async ({ input }) => {
      if (input.searchType === "precedents" && input.legalIssue) {
        return await rechtspraakIntegrationService.searchPrecedents(input.legalIssue);
      }

      return await rechtspraakIntegrationService.searchByCompany(input.companyName);
    }),

  /**
   * Get opponent's complete litigation history
   */
  getOpponentHistory: protectedProcedure
    .input(z.object({ companyName: z.string().trim().min(3).max(200) }))
    .query(async ({ input }) => {
      return await rechtspraakIntegrationService.getOpponentHistory(input.companyName);
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

