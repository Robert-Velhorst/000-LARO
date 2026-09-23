import Papa from "papaparse";

export const IMPORT_LIMITS = {
  csv: {
    maxBytes: 2 * 1024 * 1024,
    maxRows: 500,
    maxColumns: 20,
    maxHeaderChars: 4_096,
    maxFilenameChars: 255,
    maxTitleChars: 500,
    maxDescriptionChars: 100_000,
    maxCategoryChars: 200,
    maxEvidenceUrlsChars: 20_000,
    maxTagsChars: 10_000,
  },
} as const;

export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

export interface NormalizedCaseImportRow {
  caseTitle: string;
  description: string;
  category: string;
  urgency: "Low" | "Medium" | "High";
  evidenceUrls: string;
  tags: string;
}

type CsvRow = {
  caseTitle?: unknown;
  description?: unknown;
  category?: unknown;
  urgency?: unknown;
  evidenceUrls?: unknown;
  tags?: unknown;
  __parsed_extra?: unknown;
};

function byteLabel(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  return `${bytes} bytes`;
}

function requireByteLimit(value: string, maxBytes: number, label: string): void {
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new ImportValidationError(`${label} exceeds the ${byteLabel(maxBytes)} import limit.`);
  }
}

function normalizeFilename(fileName: string, maxChars: number): string {
  const normalized = fileName.trim();
  if (!normalized) throw new ImportValidationError("A filename is required.");
  if (normalized.length > maxChars) {
    throw new ImportValidationError(`Filename exceeds the ${maxChars} character limit.`);
  }
  if (/\p{Cc}/u.test(normalized)) {
    throw new ImportValidationError("Filename contains unsupported control characters.");
  }
  return normalized;
}

function normalizeString(value: unknown, label: string, maxChars: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ImportValidationError(`${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length > maxChars) {
    throw new ImportValidationError(`${label} exceeds the ${maxChars} character limit.`);
  }
  return normalized;
}

function normalizeUrgency(value: unknown): "Low" | "Medium" | "High" {
  const normalized = normalizeString(value, "urgency", 20);
  if (!normalized || /^medium$/i.test(normalized)) return "Medium";
  if (/^high$/i.test(normalized)) return "High";
  if (/^low$/i.test(normalized)) return "Low";
  throw new ImportValidationError('Urgency must be "Low", "Medium", or "High".');
}

function preflightCsvStructure(csvContent: string): string {
  const delimiters = [",", ";", "\t", "|"];
  const headerCounts = new Map(delimiters.map((delimiter) => [delimiter, 0]));
  let headerLength = 0;
  let inQuotes = false;
  for (let index = 0; index < csvContent.length; index++) {
    const character = csvContent[index];
    if (character === '"') {
      if (inQuotes && csvContent[index + 1] === '"') index++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && (character === "\r" || character === "\n")) {
      break;
    } else if (!inQuotes && headerCounts.has(character)) {
      headerCounts.set(character, (headerCounts.get(character) || 0) + 1);
    }
    headerLength++;
    if (headerLength > IMPORT_LIMITS.csv.maxHeaderChars) {
      throw new ImportValidationError(
        `CSV header exceeds the ${IMPORT_LIMITS.csv.maxHeaderChars} character limit.`,
      );
    }
  }

  const delimiter = delimiters.reduce((best, candidate) =>
    (headerCounts.get(candidate) || 0) > (headerCounts.get(best) || 0) ? candidate : best,
  ",");
  if ((headerCounts.get(delimiter) || 0) + 1 > IMPORT_LIMITS.csv.maxColumns) {
    throw new ImportValidationError(`CSV imports are limited to ${IMPORT_LIMITS.csv.maxColumns} columns.`);
  }

  let columns = 1;
  let records = 0;
  let recordHasContent = false;
  inQuotes = false;
  for (let index = 0; index < csvContent.length; index++) {
    const character = csvContent[index];
    if (character !== "\r" && character !== "\n" && (!/\s/.test(character) || character === delimiter)) {
      recordHasContent = true;
    }
    if (character === '"') {
      if (inQuotes && csvContent[index + 1] === '"') index++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes && character === delimiter) {
      columns++;
      if (columns > IMPORT_LIMITS.csv.maxColumns) {
        throw new ImportValidationError(`CSV imports are limited to ${IMPORT_LIMITS.csv.maxColumns} columns.`);
      }
    } else if (!inQuotes && (character === "\r" || character === "\n")) {
      if (character === "\r" && csvContent[index + 1] === "\n") index++;
      columns = 1;
      if (recordHasContent) records++;
      recordHasContent = false;
      if (records > IMPORT_LIMITS.csv.maxRows + 1) {
        throw new ImportValidationError(`CSV imports are limited to ${IMPORT_LIMITS.csv.maxRows} rows at a time.`);
      }
    }
  }
  if (recordHasContent) records++;
  if (records > IMPORT_LIMITS.csv.maxRows + 1) {
    throw new ImportValidationError(`CSV imports are limited to ${IMPORT_LIMITS.csv.maxRows} rows at a time.`);
  }
  return delimiter;
}

export function normalizeCaseCsvImport(
  csvContent: string,
  filename: string,
): { filename: string; rows: NormalizedCaseImportRow[] } {
  const normalizedFilename = normalizeFilename(filename, IMPORT_LIMITS.csv.maxFilenameChars);
  requireByteLimit(csvContent, IMPORT_LIMITS.csv.maxBytes, "CSV file");
  const delimiter = preflightCsvStructure(csvContent);

  const parsed = Papa.parse<CsvRow>(csvContent, {
    delimiter,
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });
  if (parsed.errors.length > 0) {
    const first = parsed.errors[0]?.message || "The CSV file could not be parsed.";
    throw new ImportValidationError(`CSV parse error: ${first}`);
  }
  if (parsed.data.length > IMPORT_LIMITS.csv.maxRows) {
    throw new ImportValidationError(`CSV imports are limited to ${IMPORT_LIMITS.csv.maxRows} rows at a time.`);
  }

  const rows = parsed.data.map((row, index) => {
    if (Array.isArray(row.__parsed_extra) && row.__parsed_extra.length > 0) {
      throw new ImportValidationError(`Row ${index + 1} has more values than the header defines.`);
    }
    const caseTitle = normalizeString(row.caseTitle, `Row ${index + 1} case title`, IMPORT_LIMITS.csv.maxTitleChars);
    const description = normalizeString(row.description, `Row ${index + 1} description`, IMPORT_LIMITS.csv.maxDescriptionChars);
    if (!caseTitle && !description) {
      throw new ImportValidationError(`Row ${index + 1} needs a case title or description.`);
    }
    return {
      caseTitle,
      description,
      category: normalizeString(row.category, `Row ${index + 1} category`, IMPORT_LIMITS.csv.maxCategoryChars),
      urgency: normalizeUrgency(row.urgency),
      evidenceUrls: normalizeString(
        row.evidenceUrls,
        `Row ${index + 1} evidence URLs`,
        IMPORT_LIMITS.csv.maxEvidenceUrlsChars,
      ),
      tags: normalizeString(row.tags, `Row ${index + 1} tags`, IMPORT_LIMITS.csv.maxTagsChars),
    };
  });

  if (rows.length === 0) {
    throw new ImportValidationError(
      "No data rows found. Expected headers such as caseTitle, description, category, and urgency.",
    );
  }
  return { filename: normalizedFilename, rows };
}
