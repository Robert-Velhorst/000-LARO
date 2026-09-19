import { eq, or, and } from "drizzle-orm";
import { getDb } from "./db";
import { cases, lawyers, evidence, documents, communications } from "./schema";
import type { SearchResultType } from "../shared/globalSearch";
import {
  LITERAL_SEARCH_CONTRACT_VERSION,
  literalSearchCondition,
  literalTextIncludes,
  normalizeLiteralSearchText,
} from "./literalSearch";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  description: string;
  metadata?: Record<string, any>;
  relevance: number;
}

export type SearchCategoryStatus = "complete" | "partial" | "failed" | "unavailable";

export interface SearchCategoryCompletion {
  type: SearchResultType;
  status: SearchCategoryStatus;
  resultCount: number;
  malformedRows?: number;
  reason?: "query_failed" | "malformed_row_metadata" | "owner_scope_unavailable" | "storage_unavailable";
}

export interface SearchCompleteness {
  contractVersion: typeof LITERAL_SEARCH_CONTRACT_VERSION;
  status: "complete" | "partial" | "failed";
  requested: SearchResultType[];
  completed: SearchResultType[];
  partial: SearchResultType[];
  failed: SearchResultType[];
  unavailable: SearchResultType[];
  categories: SearchCategoryCompletion[];
}

export interface GlobalSearchOutcome {
  normalizedQuery: string;
  results: SearchResult[];
  completeness: SearchCompleteness;
}

function buildCompleteness(
  requested: SearchResultType[],
  categories: SearchCategoryCompletion[],
): SearchCompleteness {
  const completed = categories.filter((item) => item.status === "complete").map((item) => item.type);
  const partial = categories.filter((item) => item.status === "partial").map((item) => item.type);
  const failed = categories.filter((item) => item.status === "failed").map((item) => item.type);
  const unavailable = categories.filter((item) => item.status === "unavailable").map((item) => item.type);
  const status = requested.length === 0
    ? "complete"
    : failed.length + unavailable.length === requested.length
      ? "failed"
      : partial.length > 0 || failed.length > 0 || unavailable.length > 0
        ? "partial"
        : "complete";
  return {
    contractVersion: LITERAL_SEARCH_CONTRACT_VERSION,
    status,
    requested,
    completed,
    partial,
    failed,
    unavailable,
    categories,
  };
}

function parseLawyerAreas(value: string | null): { areas: string[]; malformed: boolean } {
  if (!value?.trim()) return { areas: [], malformed: false };
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return { areas: parsed.map(String).filter(Boolean), malformed: false };
    }
    if (typeof parsed === "string" && parsed.trim()) {
      return { areas: [parsed.trim()], malformed: false };
    }
  } catch {
    // Preserve useful legacy text, but report that category as partial.
  }
  return {
    areas: value.split(",").map((area) => area.trim()).filter(Boolean),
    malformed: true,
  };
}

/**
 * Global search across all entities
 */
export async function globalSearchDetailed(
  query: string,
  options: {
    types?: SearchResultType[];
    limit?: number;
    userId?: string;
  } = {}
): Promise<GlobalSearchOutcome> {
  const { types = ["case", "lawyer", "evidence", "document", "communication"], limit = 50, userId } = options;
  const requested = [...new Set(types)];
  const normalizedQuery = normalizeLiteralSearchText(query);
  const results: SearchResult[] = [];
  const categories: SearchCategoryCompletion[] = [];
  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch (error) {
    console.error("Search storage unavailable:", error);
    categories.push(...requested.map((type) => ({
      type,
      status: "unavailable" as const,
      resultCount: 0,
      reason: "storage_unavailable" as const,
    })));
    return { normalizedQuery, results, completeness: buildCompleteness(requested, categories) };
  }
  if (!db) {
    categories.push(...requested.map((type) => ({
      type,
      status: "unavailable" as const,
      resultCount: 0,
      reason: "storage_unavailable" as const,
    })));
    return { normalizedQuery, results, completeness: buildCompleteness(requested, categories) };
  }

  if (!normalizedQuery) {
    categories.push(...requested.map((type) => ({ type, status: "complete" as const, resultCount: 0 })));
    return { normalizedQuery, results, completeness: buildCompleteness(requested, categories) };
  }

  const recordFailure = (type: SearchResultType, error: unknown) => {
    console.error(`Error searching ${type} records:`, error);
    categories.push({ type, status: "failed", resultCount: 0, reason: "query_failed" });
  };

  // Search cases
  if (requested.includes("case") && !userId) {
    categories.push({
      type: "case",
      status: "unavailable",
      resultCount: 0,
      reason: "owner_scope_unavailable",
    });
  } else if (requested.includes("case") && userId) {
    try {
      const caseResults = await db
        .select()
        .from(cases)
        .where(
          and(
            or(
              literalSearchCondition(cases.clientName, normalizedQuery),
              literalSearchCondition(cases.caseType, normalizedQuery),
              literalSearchCondition(cases.caseSummary, normalizedQuery)
            ),
            eq(cases.userId, userId)
          )
        )
        .limit(Math.min(limit, 20));

      const mapped = caseResults.map((c) => ({
          type: "case" as const,
          id: c.id,
          title: `${c.clientName} - ${c.caseType}`,
          description: c.caseSummary || "No description",
          metadata: {
            status: c.status,
            urgency: c.urgency,
            createdAt: c.createdAt,
          },
          relevance: calculateRelevance(normalizedQuery, [c.clientName || "", c.caseType || "", c.caseSummary || ""]),
        }));
      results.push(...mapped);
      categories.push({ type: "case", status: "complete", resultCount: mapped.length });
    } catch (error) {
      recordFailure("case", error);
    }
  }

  // Search lawyers
  if (requested.includes("lawyer")) {
    try {
      const lawyerResults = await db
        .select()
        .from(lawyers)
        .where(
          or(
            literalSearchCondition(lawyers.name, normalizedQuery),
            literalSearchCondition(lawyers.city, normalizedQuery),
            literalSearchCondition(lawyers.firmName, normalizedQuery),
            literalSearchCondition(lawyers.legalAreas, normalizedQuery)
          )
        )
        .limit(Math.min(limit, 20));

      let malformedRows = 0;
      const mapped = lawyerResults.map((l) => {
        const parsedAreas = parseLawyerAreas(l.legalAreas);
        if (parsedAreas.malformed) malformedRows += 1;
        return {
          type: "lawyer" as const,
          id: l.id,
          title: l.name || "Unknown",
          description: `${l.firmName || "Independent"} - ${l.city || "Location unknown"}`,
          metadata: {
            city: l.city,
            legalAreas: parsedAreas.areas,
            email: l.email,
            phone: l.phone,
          },
          relevance: calculateRelevance(normalizedQuery, [l.name || "", l.city || "", l.firmName || ""]),
        };
      });
      results.push(...mapped);
      categories.push(malformedRows > 0
        ? {
            type: "lawyer",
            status: "partial",
            resultCount: mapped.length,
            malformedRows,
            reason: "malformed_row_metadata",
          }
        : { type: "lawyer", status: "complete", resultCount: mapped.length });
    } catch (error) {
      recordFailure("lawyer", error);
    }
  }

  // Search evidence
  if (requested.includes("evidence") && !userId) {
    categories.push({
      type: "evidence",
      status: "unavailable",
      resultCount: 0,
      reason: "owner_scope_unavailable",
    });
  } else if (requested.includes("evidence") && userId) {
    try {
      const evidenceResults = await db
        .select()
        .from(evidence)
        .where(
          and(
            or(
              literalSearchCondition(evidence.title, normalizedQuery),
              literalSearchCondition(evidence.description, normalizedQuery),
              literalSearchCondition(evidence.fileName, normalizedQuery)
            ),
            eq(evidence.userId, userId)
          )
        )
        .limit(Math.min(limit, 20));

      const mapped = evidenceResults.map((e) => ({
          type: "evidence" as const,
          id: e.id,
          title: e.title,
          description: e.description || `${e.type} file`,
          metadata: {
            type: e.type,
            caseId: e.caseId,
            fileName: e.fileName,
            createdAt: e.createdAt,
          },
          relevance: calculateRelevance(normalizedQuery, [e.title, e.description || "", e.fileName || ""]),
        }));
      results.push(...mapped);
      categories.push({ type: "evidence", status: "complete", resultCount: mapped.length });
    } catch (error) {
      recordFailure("evidence", error);
    }
  }

  // Search documents
  if (requested.includes("document") && !userId) {
    categories.push({
      type: "document",
      status: "unavailable",
      resultCount: 0,
      reason: "owner_scope_unavailable",
    });
  } else if (requested.includes("document") && userId) {
    try {
      const documentResults = await db
        .select()
        .from(documents)
        .where(
          and(
            or(
              literalSearchCondition(documents.name, normalizedQuery),
              literalSearchCondition(documents.type, normalizedQuery),
              literalSearchCondition(documents.folder, normalizedQuery)
            ),
            eq(documents.userId, userId)
          )
        )
        .limit(Math.min(limit, 20));

      const mapped = documentResults.map((d) => ({
          type: "document" as const,
          id: d.id,
          title: d.name || "Untitled",
          description: `${d.type} ${d.folder ? `in ${d.folder}` : ""}`,
          metadata: {
            type: d.type,
            folder: d.folder,
            caseId: d.caseId,
            uploadedAt: d.uploadedAt,
          },
          relevance: calculateRelevance(normalizedQuery, [d.name || "", d.type || "", d.folder || ""]),
        }));
      results.push(...mapped);
      categories.push({ type: "document", status: "complete", resultCount: mapped.length });
    } catch (error) {
      recordFailure("document", error);
    }
  }

  // Search communications
  if (requested.includes("communication") && !userId) {
    categories.push({
      type: "communication",
      status: "unavailable",
      resultCount: 0,
      reason: "owner_scope_unavailable",
    });
  } else if (requested.includes("communication") && userId) {
    try {
      const commResults = await db
        .select()
        .from(communications)
        .where(
          and(
            or(
              literalSearchCondition(communications.subject, normalizedQuery),
              literalSearchCondition(communications.content, normalizedQuery)
            ),
            eq(communications.userId, userId)
          )
        )
        .limit(Math.min(limit, 20));

      const mapped = commResults.map((c) => ({
          type: "communication" as const,
          id: c.id,
          title: c.subject || `${c.type} communication`,
          description: (c.content || "").substring(0, 150) + "...",
          metadata: {
            type: c.type,
            direction: c.direction,
            caseId: c.caseId,
            timestamp: c.timestamp,
          },
          relevance: calculateRelevance(normalizedQuery, [c.subject || "", c.content || ""]),
        }));
      results.push(...mapped);
      categories.push({ type: "communication", status: "complete", resultCount: mapped.length });
    } catch (error) {
      recordFailure("communication", error);
    }
  }

  // Sort by relevance and limit
  return {
    normalizedQuery,
    results: results.sort((a, b) => b.relevance - a.relevance).slice(0, limit),
    completeness: buildCompleteness(requested, categories),
  };
}

/** Backward-compatible result-only helper for internal ranking consumers. */
export async function globalSearch(
  query: string,
  options: {
    types?: SearchResultType[];
    limit?: number;
    userId?: string;
  } = {},
): Promise<SearchResult[]> {
  return (await globalSearchDetailed(query, options)).results;
}

export interface ResolvedSearchResult {
  type: SearchResultType;
  id: string;
  caseId: string | null;
  title: string;
  description: string;
  category: string | null;
  occurredAt: Date | null;
}

function excerpt(value: string | null | undefined, fallback: string): string {
  const text = value?.trim() || fallback;
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

/**
 * Resolve a deep-linked result under the current user's authorization scope.
 * A missing and a foreign record intentionally have the same null outcome.
 */
export async function resolveSearchResult(
  type: SearchResultType,
  id: string,
  userId: string,
): Promise<ResolvedSearchResult | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  switch (type) {
    case "case": { // Cases are private to their owner.
      const [row] = await db.select().from(cases)
        .where(and(eq(cases.id, id), eq(cases.userId, userId))).limit(1);
      return row ? {
        type,
        id: row.id,
        caseId: row.id,
        title: row.clientName || row.caseType || "Case",
        description: excerpt(row.caseSummary, "No description recorded"),
        category: row.caseType || null,
        occurredAt: row.updatedAt || row.createdAt || null,
      } : null;
    }
    case "lawyer": { // Lawyer directory profiles are shared reference data.
      const [row] = await db.select().from(lawyers).where(eq(lawyers.id, id)).limit(1);
      return row ? {
        type,
        id: row.id,
        caseId: null,
        title: row.name || "Unnamed lawyer",
        description: excerpt(row.firmName, row.city || "Practice details not recorded"),
        category: row.city || null,
        occurredAt: row.updatedAt || row.createdAt || null,
      } : null;
    }
    case "evidence": {
      const [row] = await db.select().from(evidence)
        .where(and(eq(evidence.id, id), eq(evidence.userId, userId))).limit(1);
      return row ? {
        type,
        id: row.id,
        caseId: row.caseId,
        title: row.title || row.fileName || "Untitled evidence",
        description: excerpt(row.description, row.fileName || `${row.type} evidence`),
        category: row.type || null,
        occurredAt: row.updatedAt || row.createdAt || null,
      } : null;
    }
    case "document": {
      const [row] = await db.select().from(documents)
        .where(and(eq(documents.id, id), eq(documents.userId, userId))).limit(1);
      return row ? {
        type,
        id: row.id,
        caseId: row.caseId || null,
        title: row.name || row.title || "Untitled document",
        description: excerpt(row.content, [row.type, row.folder].filter(Boolean).join(" in ") || "Document details not recorded"),
        category: row.type || null,
        occurredAt: row.uploadedAt || row.createdAt || null,
      } : null;
    }
    case "communication": {
      const [row] = await db.select().from(communications)
        .where(and(eq(communications.id, id), eq(communications.userId, userId))).limit(1);
      return row ? {
        type,
        id: row.id,
        caseId: row.caseId || null,
        title: row.subject || `${row.type || "Recorded"} communication`,
        description: excerpt(row.content || row.body, "Communication content not recorded"),
        category: [row.channel, row.direction].filter(Boolean).join(" / ") || row.type || null,
        occurredAt: row.timestamp || row.createdAt || null,
      } : null;
    }
  }
}

/**
 * Calculate relevance score based on query match
 */
function calculateRelevance(query: string, fields: string[]): number {
  const normalizedQuery = normalizeLiteralSearchText(query);
  let score = 0;

  for (const field of fields) {
    const normalizedField = normalizeLiteralSearchText(field);

    // Exact match
    if (normalizedField === normalizedQuery) {
      score += 100;
    }
    // Starts with query
    else if (normalizedField.startsWith(normalizedQuery)) {
      score += 50;
    }
    // Contains query
    else if (literalTextIncludes(normalizedField, normalizedQuery)) {
      score += 25;
    }
  }

  return score;
}

/**
 * Get search suggestions based on partial query
 */
export type SuggestionScope = "case_types" | "lawyer_names" | "lawyer_cities";

export interface SearchSuggestionOutcome {
  normalizedQuery: string;
  suggestions: string[];
  completeness: {
    contractVersion: typeof LITERAL_SEARCH_CONTRACT_VERSION;
    status: "complete" | "partial" | "failed";
    requested: SuggestionScope[];
    completed: SuggestionScope[];
    failed: SuggestionScope[];
  };
}

export async function getSearchSuggestionsDetailed(
  partialQuery: string,
  limit: number = 5,
  userId?: string
): Promise<SearchSuggestionOutcome> {
  const normalizedQuery = normalizeLiteralSearchText(partialQuery);
  const requested: SuggestionScope[] = userId
    ? ["case_types", "lawyer_names", "lawyer_cities"]
    : ["lawyer_names", "lawyer_cities"];
  const completed: SuggestionScope[] = [];
  const failed: SuggestionScope[] = [];
  const finish = (suggestions: Set<string>): SearchSuggestionOutcome => ({
    normalizedQuery,
    suggestions: Array.from(suggestions).slice(0, limit),
    completeness: {
      contractVersion: LITERAL_SEARCH_CONTRACT_VERSION,
      status: failed.length === requested.length ? "failed" : failed.length > 0 ? "partial" : "complete",
      requested,
      completed,
      failed,
    },
  });

  const suggestions = new Set<string>();
  if (normalizedQuery.length < 2) {
    completed.push(...requested);
    return finish(suggestions);
  }

  let db: Awaited<ReturnType<typeof getDb>>;
  try {
    db = await getDb();
  } catch (error) {
    console.error("Search suggestion storage unavailable:", error);
    failed.push(...requested);
    return finish(suggestions);
  }
  if (!db) {
    failed.push(...requested);
    return finish(suggestions);
  }

  // Get case type suggestions
  if (userId) {
    try {
      const caseResults = await db
        .select({ caseType: cases.caseType })
        .from(cases)
        .where(and(literalSearchCondition(cases.caseType, normalizedQuery, "prefix"), eq(cases.userId, userId)))
        .limit(limit);

      caseResults.forEach(c => c.caseType && suggestions.add(c.caseType));
      completed.push("case_types");
    } catch (error) {
      console.error("Error searching case-type suggestions:", error);
      failed.push("case_types");
    }
  }

  // Get lawyer name suggestions
  try {
    const lawyerResults = await db
      .select({ name: lawyers.name })
      .from(lawyers)
      .where(literalSearchCondition(lawyers.name, normalizedQuery, "prefix"))
      .limit(limit);

    lawyerResults.forEach(l => l.name && suggestions.add(l.name));
    completed.push("lawyer_names");
  } catch (error) {
    console.error("Error searching lawyer-name suggestions:", error);
    failed.push("lawyer_names");
  }

  // Get city suggestions
  try {
    const cityResults = await db
      .select({ city: lawyers.city })
      .from(lawyers)
      .where(literalSearchCondition(lawyers.city, normalizedQuery, "prefix"))
      .limit(limit);

    cityResults.forEach(l => l.city && suggestions.add(l.city));
    completed.push("lawyer_cities");
  } catch (error) {
    console.error("Error searching lawyer-city suggestions:", error);
    failed.push("lawyer_cities");
  }

  return finish(suggestions);
}

export async function getSearchSuggestions(
  partialQuery: string,
  limit: number = 5,
  userId?: string,
): Promise<string[]> {
  return (await getSearchSuggestionsDetailed(partialQuery, limit, userId)).suggestions;
}
