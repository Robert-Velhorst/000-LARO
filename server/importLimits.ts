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
  telegram: {
    maxBytes: 8 * 1024 * 1024,
    maxMessages: 2_000,
    maxJsonDepth: 32,
    maxJsonStructuralTokens: 100_000,
    maxRichTextPartsPerMessage: 1_000,
    maxRichTextPartsTotal: 10_000,
    maxFilenameChars: 255,
    maxChatNameChars: 500,
    maxTypeChars: 100,
    maxSenderChars: 500,
    maxMessageTextChars: 100_000,
    maxFilePathChars: 2_000,
    maxMimeTypeChars: 255,
    maxMediaTypeChars: 100,
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

export interface TelegramExportMessage {
  id: number;
  type: string;
  date: string;
  date_unixtime: string;
  from?: string;
  from_id?: string;
  text?: string;
  text_entities?: Array<{ type: string; offset: number; length: number }>;
  file?: string;
  mime_type?: string;
  media_type?: string;
}

export interface TelegramExportedChat {
  name: string;
  type: string;
  id: number;
  messages: TelegramExportMessage[];
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

function preflightJsonStructure(jsonContent: string): void {
  let depth = 0;
  let structuralTokens = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < jsonContent.length; index++) {
    const character = jsonContent[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth++;
      structuralTokens++;
      if (depth > IMPORT_LIMITS.telegram.maxJsonDepth) {
        throw new ImportValidationError(
          `Telegram export exceeds the ${IMPORT_LIMITS.telegram.maxJsonDepth}-level JSON nesting depth limit.`,
        );
      }
    } else if (character === "}" || character === "]") {
      depth--;
    } else if (character === "," || character === ":") {
      structuralTokens++;
    }
    if (structuralTokens > IMPORT_LIMITS.telegram.maxJsonStructuralTokens) {
      throw new ImportValidationError("Telegram export contains too many JSON elements.");
    }
  }
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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImportValidationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ImportValidationError(`${label} must be a whole number.`);
  }
  return value;
}

function normalizeUnixTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{1,10}$/.test(value)) {
    throw new ImportValidationError(`${label} is invalid.`);
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 4_102_444_800) {
    throw new ImportValidationError(`${label} is outside the supported date range.`);
  }
  return String(seconds);
}

function flattenTelegramText(value: unknown, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") {
    return normalizeString(value, label, IMPORT_LIMITS.telegram.maxMessageTextChars);
  }
  if (!Array.isArray(value)) throw new ImportValidationError(`${label} must be text.`);
  const flattened = value.map((part) => {
    if (typeof part === "string") return part;
    const record = asRecord(part, label);
    return typeof record.text === "string" ? record.text : "";
  }).join("");
  return normalizeString(flattened, label, IMPORT_LIMITS.telegram.maxMessageTextChars);
}

export function normalizeTelegramExport(
  jsonContent: string,
  filename: string,
): { filename: string; chat: TelegramExportedChat } {
  const normalizedFilename = normalizeFilename(filename, IMPORT_LIMITS.telegram.maxFilenameChars);
  requireByteLimit(jsonContent, IMPORT_LIMITS.telegram.maxBytes, "Telegram export");
  preflightJsonStructure(jsonContent);

  let raw: unknown;
  try {
    raw = JSON.parse(jsonContent);
  } catch {
    throw new ImportValidationError("Invalid Telegram export JSON.");
  }
  const data = asRecord(raw, "Telegram export");
  if (!Array.isArray(data.messages)) {
    throw new ImportValidationError("Invalid Telegram export format: messages must be an array.");
  }
  if (data.messages.length === 0) {
    throw new ImportValidationError("The Telegram export does not contain any messages.");
  }
  if (data.messages.length > IMPORT_LIMITS.telegram.maxMessages) {
    throw new ImportValidationError(
      `Telegram imports are limited to ${IMPORT_LIMITS.telegram.maxMessages} messages at a time.`,
    );
  }

  let richTextParts = 0;
  const messages = data.messages.map((value, index): TelegramExportMessage => {
    const message = asRecord(value, `Message ${index + 1}`);
    const label = `Message ${index + 1}`;
    if (Array.isArray(message.text)) {
      if (message.text.length > IMPORT_LIMITS.telegram.maxRichTextPartsPerMessage) {
        throw new ImportValidationError(
          `${label} exceeds the ${IMPORT_LIMITS.telegram.maxRichTextPartsPerMessage} rich-text parts limit.`,
        );
      }
      richTextParts += message.text.length;
      if (richTextParts > IMPORT_LIMITS.telegram.maxRichTextPartsTotal) {
        throw new ImportValidationError("Telegram export contains too many rich-text parts.");
      }
    }
    return {
      id: normalizeInteger(message.id, `${label} ID`),
      type: normalizeString(message.type, `${label} type`, IMPORT_LIMITS.telegram.maxTypeChars),
      date: normalizeString(message.date, `${label} date`, 100),
      date_unixtime: normalizeUnixTime(message.date_unixtime, `${label} timestamp`),
      from: normalizeString(message.from, `${label} sender`, IMPORT_LIMITS.telegram.maxSenderChars) || undefined,
      from_id: normalizeString(message.from_id, `${label} sender ID`, IMPORT_LIMITS.telegram.maxSenderChars) || undefined,
      text: flattenTelegramText(message.text, `${label} message text`) || undefined,
      file: normalizeString(message.file, `${label} file path`, IMPORT_LIMITS.telegram.maxFilePathChars) || undefined,
      mime_type: normalizeString(message.mime_type, `${label} MIME type`, IMPORT_LIMITS.telegram.maxMimeTypeChars) || undefined,
      media_type: normalizeString(message.media_type, `${label} media type`, IMPORT_LIMITS.telegram.maxMediaTypeChars) || undefined,
    };
  });

  const name = normalizeString(data.name, "Chat name", IMPORT_LIMITS.telegram.maxChatNameChars);
  if (!name) throw new ImportValidationError("The Telegram export is missing a chat name.");
  return {
    filename: normalizedFilename,
    chat: {
      name,
      type: normalizeString(data.type, "Chat type", IMPORT_LIMITS.telegram.maxTypeChars),
      id: normalizeInteger(data.id, "Chat ID"),
      messages,
    },
  };
}
