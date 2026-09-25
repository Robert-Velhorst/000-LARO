export type NumericStorage = "integer" | "real";

export type NumericColumnPolicy = {
  table: string;
  column: string;
  storage: NumericStorage;
  unit: string;
  minimum: number;
  maximum: number;
};

const SAFE_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Active numeric fields that historically used TEXT affinity.
 *
 * Counts and byte sizes are non-negative safe integers. Durations and
 * distances retain fractions as REAL values. Percentages are bounded to their
 * product scale. Retired monetary/billing compatibility
 * fields intentionally remain text until their business semantics are retired
 * or separately specified.
 */
export const numericColumnPolicies: readonly NumericColumnPolicy[] = [
  { table: "lawyers", column: "totalOutreaches", storage: "integer", unit: "events", minimum: 0, maximum: SAFE_MAX },
  { table: "lawyers", column: "totalResponses", storage: "integer", unit: "events", minimum: 0, maximum: SAFE_MAX },
  { table: "lawyers", column: "totalAcceptances", storage: "integer", unit: "events", minimum: 0, maximum: SAFE_MAX },
  { table: "lawyers", column: "averageResponseTimeHours", storage: "real", unit: "hours", minimum: 0, maximum: SAFE_MAX },
  { table: "lawyers", column: "caseLoad", storage: "integer", unit: "cases", minimum: 0, maximum: SAFE_MAX },
  { table: "lawyers", column: "experienceYears", storage: "integer", unit: "years", minimum: 0, maximum: 100 },
  { table: "lawyers", column: "capacityPercentage", storage: "real", unit: "percent", minimum: 0, maximum: 100 },
  { table: "lawyers", column: "directoryDistanceKm", storage: "real", unit: "kilometres", minimum: 0, maximum: SAFE_MAX },
  { table: "evidence", column: "fileSize", storage: "integer", unit: "bytes", minimum: 0, maximum: SAFE_MAX },
  { table: "evidence_items", column: "size", storage: "integer", unit: "bytes", minimum: 0, maximum: SAFE_MAX },
  { table: "evidence_files", column: "fileSize", storage: "integer", unit: "bytes", minimum: 0, maximum: SAFE_MAX },
  { table: "outreach_status", column: "responseTimeHours", storage: "real", unit: "hours", minimum: 0, maximum: SAFE_MAX },
  { table: "outreach_status", column: "lawyerCapacityPercentage", storage: "real", unit: "percent", minimum: 0, maximum: 100 },
  { table: "usage_tracking", column: "quantity", storage: "integer", unit: "units", minimum: 0, maximum: SAFE_MAX },
  { table: "bulk_import_jobs", column: "totalRows", storage: "integer", unit: "rows", minimum: 0, maximum: SAFE_MAX },
  { table: "bulk_import_jobs", column: "processedRows", storage: "integer", unit: "rows", minimum: 0, maximum: SAFE_MAX },
  { table: "bulk_import_jobs", column: "failedRows", storage: "integer", unit: "rows", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_settings", column: "totalItemsCollected", storage: "integer", unit: "items", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_settings", column: "totalEmailsCollected", storage: "integer", unit: "items", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_settings", column: "totalFilesCollected", storage: "integer", unit: "items", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_logs", column: "emailsFound", storage: "integer", unit: "items", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_logs", column: "emailsProcessed", storage: "integer", unit: "items", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_logs", column: "filesFound", storage: "integer", unit: "items", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_logs", column: "filesDownloaded", storage: "integer", unit: "items", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_logs", column: "errorCount", storage: "integer", unit: "errors", minimum: 0, maximum: SAFE_MAX },
  { table: "auto_collection_logs", column: "executionTimeSeconds", storage: "real", unit: "seconds", minimum: 0, maximum: SAFE_MAX },
  { table: "keyword_matches", column: "matchCount", storage: "integer", unit: "matches", minimum: 0, maximum: SAFE_MAX },
];

export function numericColumnKey(policy: Pick<NumericColumnPolicy, "table" | "column">): string {
  return `${policy.table}.${policy.column}`;
}
