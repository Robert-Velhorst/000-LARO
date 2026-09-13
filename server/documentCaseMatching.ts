import type { cases } from "./schema";

type CaseRow = typeof cases.$inferSelect;
export type SourceReference = { value: string; quote: string; start: number; end: number };

// Only explicit reference labels in the extracted source, never filenames or summaries.
export function sourceReferences(text: string): SourceReference[] {
  const pattern = /\b(?:zaaknummer|dossiernummer|kenmerk|case\s+(?:number|reference)|dossier\s*(?:nr\.?|nummer))\s*[:#]?\s*([A-Z0-9][A-Z0-9./_-]{4,79})\b/gi;
  const references = new Map<string, SourceReference>();
  for (const match of text.matchAll(pattern)) {
    const value = match[1].replace(/[./_-]+$/, "").toUpperCase();
    if (!/[0-9]/.test(value) || !/[A-Z]/.test(value) || value.length < 6) continue;
    references.set(value, { value, quote: match[0], start: match.index!, end: match.index! + match[0].length });
  }
  return [...references.values()];
}

export function referencesForCase(row: CaseRow): string[] {
  let saved: string[] = [];
  try {
    const metadata = JSON.parse(row.metadata || "{}");
    if (Array.isArray(metadata.sourceReferences)) saved = metadata.sourceReferences.filter((value: unknown) => typeof value === "string");
  } catch { /* Older case metadata may not be structured. */ }
  return [...new Set([...saved, ...sourceReferences(row.caseSummary || "").map((item) => item.value)])];
}

const STOP_WORDS = new Set("aan als and bij case dat document een for from het inzake letter met naar niet onder over reference the this tot van voor was werd with zaak".split(" "));
function tokens(text: string): Set<string> {
  return new Set((text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [])
    .filter((word) => !STOP_WORDS.has(word)));
}

/** Port of the legacy review-only matcher. Fuzzy scores never authorize assignment. */
export function suggestDocumentCases(text: string, rows: CaseRow[]) {
  const terms = tokens(text);
  const refs = new Set(sourceReferences(text).map((item) => item.value));
  return rows.map((row) => {
    const exact = referencesForCase(row).filter((ref) => refs.has(ref));
    const shared = [...tokens(`${row.clientName || ""} ${row.caseSummary || ""}`)].filter((term) => terms.has(term));
    return { caseId: row.id, title: row.clientName || row.caseType || row.id,
      score: exact.length ? 100 : Math.min(60, shared.length * 6),
      reasons: exact.length ? [`Source reference: ${exact.join(", ")}`] : [`Shared source terms: ${shared.slice(0, 5).join(", ")}`],
    };
  }).filter((item) => item.score >= 18).sort((a, b) => b.score - a.score || a.caseId.localeCompare(b.caseId)).slice(0, 5);
}
