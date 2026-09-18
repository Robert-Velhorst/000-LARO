import { eq, like, or, and } from "drizzle-orm";
import { getDb } from "./db";
import { cases, lawyers, evidence, documents, communications } from "./schema";
import type { SearchResultType } from "../shared/globalSearch";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  description: string;
  metadata?: Record<string, any>;
  relevance: number;
}

/**
 * Global search across all entities
 */
export async function globalSearch(
  query: string,
  options: {
    types?: SearchResultType[];
    limit?: number;
    userId?: string;
  } = {}
): Promise<SearchResult[]> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available");
  }

  const { types = ["case", "lawyer", "evidence", "document", "communication"], limit = 50, userId } = options;
  const results: SearchResult[] = [];
  const searchPattern = `%${query}%`;

  // Search cases
  if (types.includes("case")) {
    try {
      const caseResults = await db
        .select()
        .from(cases)
        .where(
          and(
            or(
              like(cases.clientName, searchPattern),
              like(cases.caseType, searchPattern),
              like(cases.caseSummary, searchPattern)
            ),
            userId ? eq(cases.userId, userId) : undefined
          )
        )
        .limit(Math.min(limit, 20));

      results.push(
        ...caseResults.map((c) => ({
          type: "case" as const,
          id: c.id,
          title: `${c.clientName} - ${c.caseType}`,
          description: c.caseSummary || "No description",
          metadata: {
            status: c.status,
            urgency: c.urgency,
            createdAt: c.createdAt,
          },
          relevance: calculateRelevance(query, [c.clientName || "", c.caseType || "", c.caseSummary || ""]),
        }))
      );
    } catch (error) {
      console.error("Error searching cases:", error);
    }
  }

  // Search lawyers
  if (types.includes("lawyer")) {
    try {
      const lawyerResults = await db
        .select()
        .from(lawyers)
        .where(
          or(
            like(lawyers.name, searchPattern),
            like(lawyers.city, searchPattern),
            like(lawyers.firmName, searchPattern),
            like(lawyers.legalAreas, searchPattern)
          )
        )
        .limit(Math.min(limit, 20));

      results.push(
        ...lawyerResults.map((l) => ({
          type: "lawyer" as const,
          id: l.id,
          title: l.name || "Unknown",
          description: `${l.firmName || "Independent"} - ${l.city || "Location unknown"}`,
          metadata: {
            city: l.city,
            legalAreas: l.legalAreas ? JSON.parse(l.legalAreas) : [],
            email: l.email,
            phone: l.phone,
          },
          relevance: calculateRelevance(query, [l.name || "", l.city || "", l.firmName || ""]),
        }))
      );
    } catch (error) {
      console.error("Error searching lawyers:", error);
    }
  }

  // Search evidence
  if (types.includes("evidence") && userId) {
    try {
      const evidenceResults = await db
        .select()
        .from(evidence)
        .where(
          and(
            or(
              like(evidence.title, searchPattern),
              like(evidence.description, searchPattern),
              like(evidence.fileName, searchPattern)
            ),
            eq(evidence.userId, userId)
          )
        )
        .limit(Math.min(limit, 20));

      results.push(
        ...evidenceResults.map((e) => ({
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
          relevance: calculateRelevance(query, [e.title, e.description || "", e.fileName || ""]),
        }))
      );
    } catch (error) {
      console.error("Error searching evidence:", error);
    }
  }

  // Search documents
  if (types.includes("document") && userId) {
    try {
      const documentResults = await db
        .select()
        .from(documents)
        .where(
          and(
            or(
              like(documents.name, searchPattern),
              like(documents.type, searchPattern),
              like(documents.folder, searchPattern)
            ),
            eq(documents.userId, userId)
          )
        )
        .limit(Math.min(limit, 20));

      results.push(
        ...documentResults.map((d) => ({
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
          relevance: calculateRelevance(query, [d.name || "", d.type || "", d.folder || ""]),
        }))
      );
    } catch (error) {
      console.error("Error searching documents:", error);
    }
  }

  // Search communications
  if (types.includes("communication") && userId) {
    try {
      const commResults = await db
        .select()
        .from(communications)
        .where(
          and(
            or(
              like(communications.subject, searchPattern),
              like(communications.content, searchPattern)
            ),
            eq(communications.userId, userId)
          )
        )
        .limit(Math.min(limit, 20));

      results.push(
        ...commResults.map((c) => ({
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
          relevance: calculateRelevance(query, [c.subject || "", c.content || ""]),
        }))
      );
    } catch (error) {
      console.error("Error searching communications:", error);
    }
  }

  // Sort by relevance and limit
  return results
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
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
  const queryLower = query.toLowerCase();
  let score = 0;

  for (const field of fields) {
    const fieldLower = field.toLowerCase();
    
    // Exact match
    if (fieldLower === queryLower) {
      score += 100;
    }
    // Starts with query
    else if (fieldLower.startsWith(queryLower)) {
      score += 50;
    }
    // Contains query
    else if (fieldLower.includes(queryLower)) {
      score += 25;
    }
    // Word boundary match
    else if (new RegExp(`\\b${queryLower}\\b`).test(fieldLower)) {
      score += 40;
    }
  }

  return score;
}

/**
 * Get search suggestions based on partial query
 */
export async function getSearchSuggestions(
  partialQuery: string,
  limit: number = 5,
  userId?: string
): Promise<string[]> {
  const db = await getDb();
  if (!db || partialQuery.length < 2) {
    return [];
  }

  const suggestions = new Set<string>();
  const searchPattern = `${partialQuery}%`;

  try {
    // Get case type suggestions
    if (userId) {
      const caseResults = await db
        .select({ caseType: cases.caseType })
        .from(cases)
        .where(and(like(cases.caseType, searchPattern), eq(cases.userId, userId)))
        .limit(limit);

      caseResults.forEach(c => c.caseType && suggestions.add(c.caseType));
    }

    // Get lawyer name suggestions
    const lawyerResults = await db
      .select({ name: lawyers.name })
      .from(lawyers)
      .where(like(lawyers.name, searchPattern))
      .limit(limit);
    
    lawyerResults.forEach(l => l.name && suggestions.add(l.name));

    // Get city suggestions
    const cityResults = await db
      .select({ city: lawyers.city })
      .from(lawyers)
      .where(like(lawyers.city, searchPattern))
      .limit(limit);
    
    cityResults.forEach(l => l.city && suggestions.add(l.city));

  } catch (error) {
    console.error("Error getting search suggestions:", error);
  }

  return Array.from(suggestions).slice(0, limit);
}
