import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export const LITERAL_SEARCH_CONTRACT_VERSION = "literal-search-v1" as const;

/**
 * Canonical text identity for maintained search surfaces.
 *
 * - NFKC makes compatibility-equivalent Unicode input deterministic.
 * - Internal whitespace is collapsed so stored and entered spacing agree.
 * - Unicode-aware JavaScript lower-casing is exposed to SQLite through the
 *   deterministic `laro_search_normalize` connection function.
 * - Query punctuation remains data; there is no implicit regex/LIKE syntax.
 */
export function normalizeLiteralSearchText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function literalSearchPattern(value: unknown, mode: "contains" | "prefix" = "contains"): string {
  const escaped = escapeLikeLiteral(normalizeLiteralSearchText(value));
  return mode === "prefix" ? `${escaped}%` : `%${escaped}%`;
}

export function literalSearchCondition(
  field: SQLWrapper,
  value: unknown,
  mode: "contains" | "prefix" = "contains",
): SQL {
  const pattern = literalSearchPattern(value, mode);
  return sql`laro_search_normalize(COALESCE(${field}, '')) LIKE ${pattern} ESCAPE '\\'`;
}

export function literalTextIncludes(field: unknown, query: unknown): boolean {
  const normalizedQuery = normalizeLiteralSearchText(query);
  return normalizedQuery.length > 0
    && normalizeLiteralSearchText(field).includes(normalizedQuery);
}
