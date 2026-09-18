import type { lawyers } from "./schema";

export type LawyerRow = typeof lawyers.$inferSelect;

export type CanonicalRate = {
  percent: number;
  numerator: number;
  denominator: number;
};

export type CanonicalCaseMatch = {
  score: number;
  maxScore: number;
  percent: number;
  reasons: string[];
};

export type LawyerComparisonDto = {
  id: string;
  name: string;
  firm: string | null;
  city: string | null;
  legalAreas: string[];
  languages: string[];
  experienceYears: number | null;
  availability: "accepting" | "limited" | "unavailable" | "unknown";
  availabilityLabel: string;
  caseLoad: number | null;
  capacityPercent: number | null;
  averageResponseHours: number | null;
  responseRate: CanonicalRate | null;
  acceptanceRate: CanonicalRate | null;
  officialProfileUrl: string | null;
  directorySource: string | null;
  caseMatch: CanonicalCaseMatch | null;
};

function cleanListItem(value: unknown): string | null {
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/^['"]+|['"]+$/g, "").trim();
    return cleaned || null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["area", "areaEn", "name", "label"]) {
    const candidate = cleanListItem(record[key]);
    if (candidate) return candidate;
  }
  return null;
}

function uniqueItems(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = cleanListItem(value);
    if (!item) continue;
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** Parse current JSON arrays and historical CSV/object/string variants safely. */
export function parseLegacyStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueItems(value);
  if (typeof value !== "string") return [];
  const source = value.trim();
  if (!source) return [];

  try {
    const parsed = JSON.parse(source) as unknown;
    if (Array.isArray(parsed)) return uniqueItems(parsed);
    if (typeof parsed === "string") return uniqueItems([parsed]);
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      for (const key of ["areas", "legalAreas", "languages", "items"]) {
        if (Array.isArray(record[key])) return uniqueItems(record[key] as unknown[]);
      }
      return uniqueItems([parsed]);
    }
  } catch {
    // Historical imports also stored comma/semicolon text and truncated JSON.
  }

  const withoutBrackets = source.replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  return uniqueItems(withoutBrackets.split(/[,;|\n]+/));
}

export function parseStoredNumber(
  value: unknown,
  options: { minimum?: number; maximum?: number; integer?: boolean } = {},
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return null;
  const normalized = options.integer ? Math.trunc(parsed) : parsed;
  if (options.minimum !== undefined && normalized < options.minimum) return null;
  if (options.maximum !== undefined && normalized > options.maximum) return null;
  return normalized;
}

function observedRate(numerator: number | null, denominator: number | null): CanonicalRate | null {
  if (numerator === null || denominator === null || denominator <= 0 || numerator > denominator) return null;
  return {
    percent: Math.round((numerator / denominator) * 1_000) / 10,
    numerator,
    denominator,
  };
}

function availability(row: LawyerRow): Pick<LawyerComparisonDto, "availability" | "availabilityLabel"> {
  if (/^(?:yes|true)$/i.test(row.caseStop?.trim() || "") || /^(?:yes|true)$/i.test(row.permanentlyFiltered?.trim() || "")) {
    return { availability: "unavailable", availabilityLabel: "Not accepting" };
  }
  const current = row.currentlyAccepting?.trim().toLocaleLowerCase();
  if (["yes", "true", "accepting", "available", "ja"].includes(current || "")) {
    return { availability: "accepting", availabilityLabel: "Accepting new cases" };
  }
  if (["limited", "beperkt"].includes(current || "")) {
    return { availability: "limited", availabilityLabel: "Limited availability" };
  }
  if (["no", "false", "unavailable", "nee"].includes(current || "")) {
    return { availability: "unavailable", availabilityLabel: "Not accepting" };
  }
  return { availability: "unknown", availabilityLabel: "Availability not recorded" };
}

export function toLawyerComparisonDto(
  row: LawyerRow,
  match: { matchScore: number; matchReasons: string[] } | null,
  matchScoreMax: number,
): LawyerComparisonDto {
  const totalOutreaches = parseStoredNumber(row.totalOutreaches, { minimum: 0, integer: true });
  const totalResponses = parseStoredNumber(row.totalResponses, { minimum: 0, integer: true });
  const totalAcceptances = parseStoredNumber(row.totalAcceptances, { minimum: 0, integer: true });
  const matchScore = match && Number.isFinite(match.matchScore)
    ? Math.max(0, Math.min(matchScoreMax, match.matchScore))
    : null;

  return {
    id: row.id,
    name: row.name?.trim() || "Unnamed lawyer",
    firm: row.firmName?.trim() || row.firm?.trim() || null,
    city: row.city?.trim() || null,
    legalAreas: parseLegacyStringArray(row.legalAreas),
    languages: parseLegacyStringArray(row.languages),
    experienceYears: parseStoredNumber(row.experienceYears, { minimum: 0, maximum: 100, integer: true }),
    ...availability(row),
    caseLoad: parseStoredNumber(row.caseLoad, { minimum: 0, integer: true }),
    capacityPercent: parseStoredNumber(row.capacityPercentage, { minimum: 0, maximum: 100 }),
    averageResponseHours: parseStoredNumber(row.averageResponseTimeHours, { minimum: 0 }),
    responseRate: observedRate(totalResponses, totalOutreaches),
    acceptanceRate: observedRate(totalAcceptances, totalResponses),
    officialProfileUrl: row.officialProfileUrl?.trim() || null,
    directorySource: row.directorySource?.trim() || null,
    caseMatch: matchScore === null ? null : {
      score: Math.round(matchScore * 10) / 10,
      maxScore: matchScoreMax,
      percent: Math.round((matchScore / matchScoreMax) * 100),
      reasons: match?.matchReasons.filter((reason) => typeof reason === "string" && reason.trim()).slice(0, 8) || [],
    },
  };
}
