const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

type SqliteClient = {
  prepare: (statement: string) => {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
  };
};

type NumericField = {
  table: string;
  column: string;
};

type NumericConstraint = {
  name: string;
  table: string;
  columns: string[];
  violation: (value: (column: string) => string) => string;
};

export interface NumericFieldIntegrity {
  table: string;
  column: string;
  available: boolean;
  totalRows: number;
  emptyValues: number;
  invalidValues: number;
  ok: boolean;
}

export interface NumericConstraintIntegrity {
  name: string;
  table: string;
  available: boolean;
  violatingRows: number;
  ok: boolean;
}

export interface NumericIntegrityReport {
  ok: boolean;
  fields: NumericFieldIntegrity[];
  constraints: NumericConstraintIntegrity[];
}

const numericFields: NumericField[] = [
  { table: "lawyers", column: "totalOutreaches" },
  { table: "lawyers", column: "totalResponses" },
  { table: "lawyers", column: "totalAcceptances" },
  { table: "lawyers", column: "caseLoad" },
  { table: "bulk_import_jobs", column: "totalRows" },
  { table: "bulk_import_jobs", column: "processedRows" },
  { table: "bulk_import_jobs", column: "failedRows" },
  { table: "lawyer_ratings", column: "totalInteractions" },
  { table: "lawyer_ratings", column: "fastResponses" },
  { table: "lawyer_ratings", column: "mediumResponses" },
  { table: "lawyer_ratings", column: "slowResponses" },
  { table: "lawyer_ratings", column: "verySlowResponses" },
  { table: "lawyer_ratings", column: "completeAnswers" },
  { table: "lawyer_ratings", column: "partialAnswers" },
  { table: "lawyer_ratings", column: "incompleteAnswers" },
  { table: "lawyer_ratings", column: "casesAccepted" },
  { table: "lawyer_ratings", column: "casesDeclined" },
  { table: "lawyer_ratings", column: "casesNoResponse" },
  { table: "lawyer_interactions", column: "responseLength" },
  { table: "rating_calculation_logs", column: "interactionsAnalyzed" },
  { table: "auto_collection_settings", column: "totalItemsCollected" },
  { table: "auto_collection_settings", column: "totalEmailsCollected" },
  { table: "auto_collection_settings", column: "totalFilesCollected" },
  { table: "auto_collection_logs", column: "emailsFound" },
  { table: "auto_collection_logs", column: "emailsProcessed" },
  { table: "auto_collection_logs", column: "filesFound" },
  { table: "auto_collection_logs", column: "filesDownloaded" },
  { table: "auto_collection_logs", column: "errorCount" },
];

const numericConstraints: NumericConstraint[] = [
  {
    name: "lawyer responses do not exceed outreaches",
    table: "lawyers",
    columns: ["totalResponses", "totalOutreaches"],
    violation: (value) => `${value("totalResponses")} > ${value("totalOutreaches")}`,
  },
  {
    name: "lawyer acceptances do not exceed responses",
    table: "lawyers",
    columns: ["totalAcceptances", "totalResponses"],
    violation: (value) => `${value("totalAcceptances")} > ${value("totalResponses")}`,
  },
  {
    name: "bulk-import processed rows do not exceed total rows",
    table: "bulk_import_jobs",
    columns: ["processedRows", "totalRows"],
    violation: (value) => `${value("processedRows")} > ${value("totalRows")}`,
  },
  {
    name: "bulk-import failed rows do not exceed processed rows",
    table: "bulk_import_jobs",
    columns: ["failedRows", "processedRows"],
    violation: (value) => `${value("failedRows")} > ${value("processedRows")}`,
  },
  {
    name: "lawyer rating outcomes do not exceed interactions",
    table: "lawyer_ratings",
    columns: ["casesAccepted", "casesDeclined", "casesNoResponse", "totalInteractions"],
    violation: (value) =>
      `${value("casesAccepted")} + ${value("casesDeclined")} + ${value("casesNoResponse")} > ${value("totalInteractions")}`,
  },
  {
    name: "processed emails do not exceed found emails",
    table: "auto_collection_logs",
    columns: ["emailsProcessed", "emailsFound"],
    violation: (value) => `${value("emailsProcessed")} > ${value("emailsFound")}`,
  },
  {
    name: "downloaded files do not exceed found files",
    table: "auto_collection_logs",
    columns: ["filesDownloaded", "filesFound"],
    violation: (value) => `${value("filesDownloaded")} > ${value("filesFound")}`,
  },
  {
    name: "collection item total equals email and file totals",
    table: "auto_collection_settings",
    columns: ["totalItemsCollected", "totalEmailsCollected", "totalFilesCollected"],
    violation: (value) =>
      `${value("totalItemsCollected")} <> ${value("totalEmailsCollected")} + ${value("totalFilesCollected")}`,
  },
];

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function columnExpression(column: string): string {
  return `TRIM(CAST(${quoteIdentifier(column)} AS TEXT))`;
}

function isEmpty(column: string): string {
  return `${quoteIdentifier(column)} IS NULL OR ${columnExpression(column)} = ''`;
}

function isInvalid(column: string): string {
  const value = columnExpression(column);
  return `NOT (${isEmpty(column)}) AND (${value} GLOB '*[^0-9]*' OR CAST(${value} AS INTEGER) > ${MAX_SAFE_INTEGER})`;
}

function isCompatible(column: string): string {
  return `NOT (${isInvalid(column)})`;
}

function numericValue(column: string): string {
  return `CASE WHEN ${isEmpty(column)} THEN 0 ELSE CAST(${columnExpression(column)} AS INTEGER) END`;
}

function tableColumns(sqlite: SqliteClient, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name?: string }>;
  return new Set(rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])));
}

export function assessNumericIntegrity(sqlite: SqliteClient): NumericIntegrityReport {
  const tableNames = new Set([
    ...numericFields.map((field) => field.table),
    ...numericConstraints.map((constraint) => constraint.table),
  ]);
  const fields = numericFields.map<NumericFieldIntegrity>((field) => ({
    ...field,
    available: false,
    totalRows: 0,
    emptyValues: 0,
    invalidValues: 0,
    ok: false,
  }));
  const constraints = numericConstraints.map<NumericConstraintIntegrity>((constraint) => ({
    name: constraint.name,
    table: constraint.table,
    available: false,
    violatingRows: 0,
    ok: false,
  }));

  // Build one aggregate query per table so readiness remains cheap even for
  // installations with a large lawyer directory or collection history.
  for (const table of tableNames) {
    const availableColumns = tableColumns(sqlite, table);
    if (availableColumns.size === 0) continue;
    const tableFields = numericFields
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => field.table === table);
    const tableConstraints = numericConstraints
      .map((constraint, index) => ({ constraint, index }))
      .filter(({ constraint }) => constraint.table === table);
    const selections = ["count(*) AS totalRows"];

    for (const { field, index } of tableFields) {
      if (!availableColumns.has(field.column)) continue;
      selections.push(
        `sum(CASE WHEN ${isEmpty(field.column)} THEN 1 ELSE 0 END) AS ${quoteIdentifier(`empty_${index}`)}`,
        `sum(CASE WHEN ${isInvalid(field.column)} THEN 1 ELSE 0 END) AS ${quoteIdentifier(`invalid_${index}`)}`,
      );
    }
    for (const { constraint, index } of tableConstraints) {
      if (!constraint.columns.every((column) => availableColumns.has(column))) continue;
      const compatible = constraint.columns.map(isCompatible).join(" AND ");
      const violation = constraint.violation(numericValue);
      selections.push(
        `sum(CASE WHEN ${compatible} AND (${violation}) THEN 1 ELSE 0 END) AS ${quoteIdentifier(`constraint_${index}`)}`,
      );
    }

    const row = sqlite.prepare(`
      SELECT ${selections.join(",\n        ")}
      FROM ${quoteIdentifier(table)}
    `).get() as Record<string, number | null> | undefined;
    const totalRows = Number(row?.totalRows ?? 0);

    for (const { field, index } of tableFields) {
      if (!availableColumns.has(field.column)) continue;
      const invalidValues = Number(row?.[`invalid_${index}`] ?? 0);
      fields[index] = {
        ...field,
        available: true,
        totalRows,
        emptyValues: Number(row?.[`empty_${index}`] ?? 0),
        invalidValues,
        ok: invalidValues === 0,
      };
    }
    for (const { constraint, index } of tableConstraints) {
      if (!constraint.columns.every((column) => availableColumns.has(column))) continue;
      const violatingRows = Number(row?.[`constraint_${index}`] ?? 0);
      constraints[index] = {
        name: constraint.name,
        table: constraint.table,
        available: true,
        violatingRows,
        ok: violatingRows === 0,
      };
    }
  }

  return {
    ok: fields.every((field) => field.ok) && constraints.every((constraint) => constraint.ok),
    fields,
    constraints,
  };
}
