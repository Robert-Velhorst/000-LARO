import { inArray } from "drizzle-orm";
import { getDb } from "./db";
import { findMatchingLawyers, MATCH_SCORE_MAX } from "./matching";
import { lawyers } from "./schema";
import { toLawyerComparisonDto } from "./lawyerData";

export async function getLawyerComparison(options: {
  lawyerIds: string[];
  caseId?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const uniqueIds = [...new Set(options.lawyerIds)];
  const rows = await db.select().from(lawyers).where(inArray(lawyers.id, uniqueIds));
  const byId = new Map(rows.map((row) => [row.id, row]));
  let matchStatus: "not_selected" | "available" | "unavailable" = options.caseId ? "available" : "not_selected";
  const matches = new Map<string, Awaited<ReturnType<typeof findMatchingLawyers>>[number]>();

  if (options.caseId) {
    try {
      const canonicalMatches = await findMatchingLawyers(options.caseId, {
        lawyerIds: uniqueIds,
        maxResults: uniqueIds.length,
        sortBy: "score",
      });
      for (const match of canonicalMatches) matches.set(match.id, match);
    } catch {
      matchStatus = "unavailable";
    }
  }

  return {
    caseId: options.caseId || null,
    matchStatus,
    matchScoreMax: options.caseId ? MATCH_SCORE_MAX : null,
    missingCount: uniqueIds.filter((id) => !byId.has(id)).length,
    lawyers: uniqueIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [toLawyerComparisonDto(row, matches.get(id) || null, MATCH_SCORE_MAX)] : [];
    }),
  };
}
