import { and, eq } from "drizzle-orm";
import { getDb } from "./db";
import { cases, documentAnalyses, evidence } from "./schema";

const STOP_WORDS = new Set([
  "aan", "als", "bij", "dat", "de", "den", "der", "dit", "door", "een", "en", "het", "hij",
  "hun", "in", "is", "kan", "met", "naar", "niet", "of", "om", "onder", "op", "ook", "over",
  "te", "tot", "uit", "van", "voor", "was", "we", "wel", "werd", "worden", "wordt", "zij", "zijn",
  "and", "are", "case", "for", "from", "has", "have", "into", "its", "law", "legal", "that", "the",
  "their", "this", "to", "was", "were", "with",
]);

export type EvidenceRelevanceCategory = "high" | "medium" | "low";

export interface EvidenceRelevanceResult {
  itemId: string;
  title: string;
  relevanceScore: number;
  reasoning: string;
  keywords: string[];
  caseRelevance: EvidenceRelevanceCategory;
  analysisAvailable: boolean;
}

export interface EvidenceRelevanceStatistics {
  totalEvidence: number;
  totalScored: number;
  highRelevance: number;
  mediumRelevance: number;
  lowRelevance: number;
  averageScore: number;
  analyzedEvidence: number;
  unscoredEvidence: number;
  topKeywords: Array<{ keyword: string; frequency: number }>;
}

function parseObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !STOP_WORDS.has(term) && !/^\d+$/.test(term));
}

function collectStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 6 || output.join(" ").length >= 30_000) return;
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (["contentHash", "id", "lineEnd", "lineStart"].includes(key)) continue;
      collectStrings(item, output, depth + 1);
    }
  }
}

function categoryFor(score: number): EvidenceRelevanceCategory {
  if (score >= 70) return "high";
  if (score >= 40) return "medium";
  return "low";
}

function scoreEvidence(input: {
  id: string;
  title: string;
  description: string | null;
  tags: string | null;
  metadata: string | null;
  caseText: string;
  analysisResult?: string;
}): EvidenceRelevanceResult {
  const caseTerms = new Set(tokenize(input.caseText));
  const analysisStrings: string[] = [];
  if (input.analysisResult) collectStrings(parseObject(input.analysisResult), analysisStrings);
  const evidenceText = [input.title, input.description || "", input.tags || "", ...analysisStrings].join(" ");
  const evidenceTerms = new Set(tokenize(evidenceText));
  const titleTerms = new Set(tokenize(input.title));
  const matches = [...caseTerms].filter((term) => evidenceTerms.has(term));
  const titleMatches = matches.filter((term) => titleTerms.has(term));
  const denominator = Math.max(1, Math.min(caseTerms.size, 12));
  const coverage = matches.length / denominator;
  const analysisAvailable = Boolean(input.analysisResult);

  const score = caseTerms.size === 0
    ? 0
    : Math.min(100, Math.round(
      Math.min(matches.length, 6) * 8
      + coverage * 30
      + Math.min(titleMatches.length, 2) * 5
      + (analysisAvailable ? 10 : 0)
    ));
  const keywords = matches.slice(0, 12);
  const category = categoryFor(score);
  const reasoning = caseTerms.size === 0
    ? "The case has no summary or legal-area context to compare against."
    : matches.length === 0
      ? `No material overlap was found with the persisted case context${analysisAvailable ? " after document analysis" : " from the available metadata"}.`
      : `${matches.length} case term${matches.length === 1 ? "" : "s"} matched${analysisAvailable ? " across the document analysis" : " in the evidence metadata"}: ${keywords.join(", ")}.`;

  return {
    itemId: input.id,
    title: input.title,
    relevanceScore: score,
    reasoning,
    keywords,
    caseRelevance: category,
    analysisAvailable,
  };
}

async function loadCaseEvidence(userId: string, caseId: string) {
  const db = await getDb();
  const [caseRow] = await db
    .select({
      caseType: cases.caseType,
      caseSummary: cases.caseSummary,
      legalAreas: cases.legalAreas,
    })
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.userId, userId)))
    .limit(1);
  if (!caseRow) throw new Error("Case not found");

  const [items, analyses] = await Promise.all([
    db.select({
      id: evidence.id,
      title: evidence.title,
      description: evidence.description,
      tags: evidence.tags,
      metadata: evidence.metadata,
    }).from(evidence).where(and(eq(evidence.caseId, caseId), eq(evidence.userId, userId))),
    db.select({
      evidenceId: documentAnalyses.evidenceId,
      result: documentAnalyses.result,
    }).from(documentAnalyses).where(and(
      eq(documentAnalyses.caseId, caseId),
      eq(documentAnalyses.userId, userId)
    )),
  ]);
  const analysisByEvidence = new Map(analyses.map((analysis) => [analysis.evidenceId, analysis.result]));
  const caseText = [caseRow.caseType, caseRow.caseSummary, caseRow.legalAreas].filter(Boolean).join(" ");
  return { db, caseText, items, analysisByEvidence };
}

function statisticsFromRows(rows: Array<{ metadata: string | null }>, analyzedEvidence: number): EvidenceRelevanceStatistics {
  const scored = rows
    .map((row) => parseObject(row.metadata))
    .filter((metadata) => typeof metadata.relevanceScore === "number");
  const scores = scored.map((metadata) => Number(metadata.relevanceScore));
  const keywordFrequency = new Map<string, number>();
  for (const metadata of scored) {
    const keywords = Array.isArray(metadata.scoringKeywords) ? metadata.scoringKeywords : [];
    for (const keyword of keywords) {
      if (typeof keyword === "string") keywordFrequency.set(keyword, (keywordFrequency.get(keyword) || 0) + 1);
    }
  }
  return {
    totalEvidence: rows.length,
    totalScored: scores.length,
    highRelevance: scores.filter((score) => score >= 70).length,
    mediumRelevance: scores.filter((score) => score >= 40 && score < 70).length,
    lowRelevance: scores.filter((score) => score < 40).length,
    averageScore: scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : 0,
    analyzedEvidence,
    unscoredEvidence: rows.length - scores.length,
    topKeywords: [...keywordFrequency.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([keyword, frequency]) => ({ keyword, frequency })),
  };
}

export async function scoreAllEvidenceForCase(options: {
  userId: string;
  caseId: string;
  batchSize?: number;
}): Promise<EvidenceRelevanceResult[]> {
  const { db, caseText, items, analysisByEvidence } = await loadCaseEvidence(options.userId, options.caseId);
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 10, 50));
  const updates = items.map((item) => {
    const result = scoreEvidence({
        id: item.id,
        title: item.title,
        description: item.description,
        tags: item.tags,
        metadata: item.metadata,
        caseText,
        analysisResult: analysisByEvidence.get(item.id),
      });
    const metadata = parseObject(item.metadata);
    return {
      item,
      result,
      metadata: JSON.stringify({
        ...metadata,
        relevanceScore: result.relevanceScore,
        scoringReasoning: result.reasoning,
        scoringKeywords: result.keywords,
        caseRelevance: result.caseRelevance,
        scoringMethod: "case-context-v1",
        lastScoredAt: new Date().toISOString(),
      }),
      updatedAt: new Date(),
    };
  });

  for (let offset = 0; offset < updates.length; offset += batchSize) {
    const batch = updates.slice(offset, offset + batchSize);
    db.transaction((tx) => {
      for (const update of batch) {
        tx.update(evidence)
          .set({
            relevant: update.result.relevanceScore >= 40,
            metadata: update.metadata,
            updatedAt: update.updatedAt,
          })
          .where(and(
            eq(evidence.id, update.item.id),
            eq(evidence.caseId, options.caseId),
            eq(evidence.userId, options.userId)
          ))
          .run();
      }
    });
  }
  return updates.map((update) => update.result);
}

export async function getEvidenceRelevanceStatistics(userId: string, caseId: string) {
  const { items, analysisByEvidence } = await loadCaseEvidence(userId, caseId);
  return statisticsFromRows(items, analysisByEvidence.size);
}
