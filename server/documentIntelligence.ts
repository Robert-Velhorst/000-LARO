import { createHash } from "crypto";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import {
  getSupportedDocumentAnalysisMimeTypes,
  isSupportedDocumentAnalysisMimeType,
  isSupportedImageOcrMimeType,
} from "../shared/evidenceFiles";
import { getLLMProviderDescriptors, invokeLLM, isLLMProviderConfigured, type LLMProvider } from "./llm";
import { extractImageText } from "./ocr";

export const DOCUMENT_ANALYSIS_VERSION = "2.2.0";
const MAX_ANALYSIS_CHARS = 250_000;
const MAX_PROVIDER_CHARS = 100_000;

export type Citation = {
  id: string;
  quote: string;
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
};

export type CitedFinding = {
  text: string;
  citations: string[];
  normalized?: string;
};

export type TimelineFinding = CitedFinding & {
  date: string;
  title: string;
  actor: string | null;
  importance: "critical" | "high" | "medium" | "low";
  category: "employment" | "termination" | "communication" | "legal" | "financial" | "other";
};

export type DocumentAnalysisResult = {
  schemaVersion: 2;
  analysisVersion: string;
  contentHash: string;
  status: "complete";
  extractionMethod: "plain_text" | "html" | "pdf_text" | "docx_text" | "email_text" | "ocr_text";
  extractionConfidence: number | null;
  /** Missing on analyses created before provider-aware cache invalidation. */
  analysisProvider?: "local" | LLMProvider;
  providerModel?: string | null;
  providerStatus: "not_requested" | "unavailable" | "complete" | "invalid_response" | "failed";
  providerMessage: string | null;
  documentType: string;
  confidence: number;
  summary: string;
  analyzedChars: number;
  analyzedWords: number;
  truncated: boolean;
  citations: Citation[];
  parties: CitedFinding[];
  dates: CitedFinding[];
  amounts: CitedFinding[];
  claims: CitedFinding[];
  obligations: CitedFinding[];
  legalIssues: CitedFinding[];
  riskFlags: CitedFinding[];
  timelineEvents: TimelineFinding[];
};

type ExtractionResult = {
  text: string;
  method: DocumentAnalysisResult["extractionMethod"];
  confidence: number | null;
};

export function supportsDocumentAnalysisMime(mimeType: string): boolean {
  return isSupportedDocumentAnalysisMimeType(mimeType);
}

export function supportedDocumentAnalysisMimeTypes(): string[] {
  return getSupportedDocumentAnalysisMimeTypes();
}

const DATE_PATTERN = /\b(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+(?:januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december|january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4})\b/gi;
const AMOUNT_PATTERN = /(?:EUR|EURO|\u20ac)\s?\d[\d.,]*(?:\s?(?:miljoen|million))?|\b\d[\d.,]*\s?(?:EUR|EURO|\u20ac)\b/gi;
const OBLIGATION_PATTERN = /\b(moet|dient|verplicht|uiterlijk|binnen\s+\d+|bezwaar|beroep|deadline|must|shall|required|no later than|within\s+\d+)\b/i;
const CLAIM_PATTERN = /\b(stelt|verklaart|beweert|betwist|erkent|volgens|claims?|alleges?|states?|declares?|disputes?|admits?|according to)\b/i;
const RISK_PATTERN = /\b(boete|sanctie|opzegging|ontslag|aansprakelijk|ingebrekestelling|verjaring|executie|beslag|fraude|penalty|sanction|termination|liability|default|limitation period|enforcement|seizure|fraud)\b/i;

const ISSUE_KEYWORDS: Array<[string, RegExp]> = [
  ["employment law", /\b(werkgever|werknemer|arbeidsovereenkomst|ontslag|employment|employer|employee|dismissal)\b/i],
  ["administrative law", /\b(besluit|bestuursorgaan|bezwaar|beroep|awb|administrative decision|public authority)\b/i],
  ["tenancy law", /\b(huurder|verhuurder|huurprijs|huurovereenkomst|tenant|landlord|rent|lease)\b/i],
  ["consumer law", /\b(consument|verkoper|garantie|koopovereenkomst|consumer|seller|warranty|purchase agreement)\b/i],
  ["family law", /\b(echtscheiding|alimentatie|gezag|omgang|divorce|maintenance|custody|contact arrangement)\b/i],
  ["criminal law", /\b(verdachte|strafbaar|officier van justitie|dagvaarding|suspect|criminal offence|prosecutor|summons)\b/i],
  ["immigration law", /\b(verblijfsvergunning|asiel|ind|residence permit|asylum|immigration)\b/i],
  ["insurance law", /\b(verzekeraar|polis|dekking|schade|insurer|policy|coverage|claim)\b/i],
  ["tax law", /\b(belastingdienst|aanslag|inkomstenbelasting|btw|tax authority|assessment|income tax|vat)\b/i],
  ["privacy law", /\b(avg|persoonsgegevens|verwerkingsverantwoordelijke|gdpr|personal data|controller)\b/i],
];

function normalizeText(text: string): string {
  return text.replace(/\u0000/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

function stripHtml(html: string): string {
  return normalizeText(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
  );
}

export async function extractDocumentText(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  const normalizedMime = mimeType.toLowerCase().split(";")[0].trim();
  if (["text/plain", "text/csv"].includes(normalizedMime)) {
    return { text: normalizeText(bytes.toString("utf8")), method: "plain_text", confidence: null };
  }
  if (normalizedMime === "text/html") {
    return { text: stripHtml(bytes.toString("utf8")), method: "html", confidence: null };
  }
  if (normalizedMime === "message/rfc822") {
    return { text: normalizeText(bytes.toString("utf8")), method: "email_text", confidence: null };
  }
  if (normalizedMime === "application/pdf") {
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const result = await parser.getText();
      return { text: normalizeText(result.text), method: "pdf_text", confidence: null };
    } finally {
      await parser.destroy();
    }
  }
  if (normalizedMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const result = await mammoth.extractRawText({ buffer: bytes });
    return { text: normalizeText(result.value), method: "docx_text", confidence: null };
  }
  if (isSupportedImageOcrMimeType(normalizedMime)) {
    const result = await extractImageText(bytes);
    return { text: normalizeText(result.text), method: "ocr_text", confidence: result.confidence };
  }
  throw new Error(`Document analysis does not support ${mimeType || "this file type"}`);
}

function buildCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineForOffset = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (lineStarts[mid] <= offset) low = mid + 1;
      else high = mid - 1;
    }
    return Math.max(1, high + 1);
  };

  const paragraphPattern = /[^\n]+(?:\n|$)/g;
  for (const match of text.matchAll(paragraphPattern)) {
    const raw = match[0].trim();
    if (!raw) continue;
    const base = match.index ?? 0;
    for (let cursor = 0; cursor < raw.length; cursor += 900) {
      const quote = raw.slice(cursor, cursor + 900).trim();
      if (!quote) continue;
      const start = base + cursor;
      const end = start + quote.length;
      citations.push({
        id: `src-${citations.length + 1}`,
        quote,
        start,
        end,
        lineStart: lineForOffset(start),
        lineEnd: lineForOffset(end),
      });
      if (citations.length >= 500) return citations;
    }
  }
  return citations;
}

function uniqueFindings(findings: CitedFinding[]): CitedFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.text.toLowerCase()}|${finding.citations.join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findingsForPattern(citations: Citation[], pattern: RegExp): CitedFinding[] {
  const output: CitedFinding[] = [];
  for (const citation of citations) {
    const matches = citation.quote.match(new RegExp(pattern.source, pattern.flags));
    for (const value of matches ?? []) {
      output.push({ text: value.trim(), citations: [citation.id] });
      if (output.length >= 50) return uniqueFindings(output);
    }
  }
  return uniqueFindings(output);
}

function contextualFindings(citations: Citation[], pattern: RegExp, limit = 30): CitedFinding[] {
  return citations
    .filter((citation) => pattern.test(citation.quote))
    .slice(0, limit)
    .map((citation) => ({ text: citation.quote.slice(0, 500), citations: [citation.id] }));
}

function classifyDocument(text: string): { type: string; confidence: number } {
  const candidates: Array<[string, RegExp[]]> = [
    ["court decision", [/\brechtbank\b/i, /\bgerechtshof\b/i, /\bvonnis\b/i, /\bjudgment\b/i]],
    ["administrative decision", [/\bbesluit\b/i, /\bbezwaar\b/i, /\bawb\b/i, /\badministrative decision\b/i]],
    ["contract", [/\bovereenkomst\b/i, /\bcontract\b/i, /\bpartijen komen overeen\b/i, /\bparties agree\b/i]],
    ["formal notice", [/\bingebrekestelling\b/i, /\bsommatie\b/i, /\bnotice of default\b/i]],
    ["invoice", [/\bfactuur\b/i, /\binvoice\b/i, /\btotaal(?:bedrag)?\b/i]],
    ["correspondence", [/\bvan:\s*/i, /\baan:\s*/i, /\bfrom:\s*/i, /\bto:\s*/i, /\bsubject:\s*/i]],
  ];
  let best = { type: "legal document", score: 0 };
  for (const [type, patterns] of candidates) {
    const score = patterns.filter((pattern) => pattern.test(text)).length;
    if (score > best.score) best = { type, score };
  }
  return { type: best.type, confidence: best.score ? Math.min(95, 55 + best.score * 12) : 45 };
}

function extractParties(citations: Citation[]): CitedFinding[] {
  const findings: CitedFinding[] = [];
  const patterns = [
    /^(?:van|aan|afzender|geadresseerde|from|to|sender|recipient)\s*:\s*(.{2,120})$/gim,
    /\b([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,4})\b/gu,
    /\b([A-Z][\p{L}\d&.' -]{2,80}\s(?:B\.V\.|N\.V\.|Stichting|Gemeente|Ministerie|Rechtbank|Ltd\.?|LLC|Inc\.?))\b/gu,
  ];
  for (const citation of citations) {
    for (const pattern of patterns) {
      for (const match of citation.quote.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const value = (match[1] || match[0]).trim().replace(/[;,]$/, "");
        if (value.length > 2 && value.length <= 120) findings.push({ text: value, citations: [citation.id] });
        if (findings.length >= 40) return uniqueFindings(findings);
      }
    }
  }
  return uniqueFindings(findings);
}

function inferCategory(text: string): TimelineFinding["category"] {
  if (/ontslag|werkgever|werknemer|employment|dismissal/i.test(text)) return "employment";
  if (/opzegging|termination/i.test(text)) return "termination";
  if (/email|brief|bericht|mail|letter|message/i.test(text)) return "communication";
  if (/factuur|betaling|bedrag|invoice|payment|\u20ac|EUR/i.test(text)) return "financial";
  if (/besluit|vonnis|bezwaar|beroep|court|judgment|appeal|decision/i.test(text)) return "legal";
  return "other";
}

function inferImportance(text: string): TimelineFinding["importance"] {
  if (/uiterlijk|deadline|binnen\s+\d+|verjaring|ontslag|beslag|no later than|within\s+\d+|limitation|termination|seizure/i.test(text)) return "critical";
  if (/moet|dient|verplicht|bezwaar|beroep|must|shall|required|appeal/i.test(text)) return "high";
  if (/betaling|afspraak|bevestig|payment|agreement|confirm/i.test(text)) return "medium";
  return "low";
}

function normalizeDate(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const numeric = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (numeric) {
    const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
    return `${year}-${numeric[2].padStart(2, "0")}-${numeric[1].padStart(2, "0")}`;
  }
  const months: Record<string, string> = {
    januari: "01", january: "01", februari: "02", february: "02", maart: "03", march: "03",
    april: "04", mei: "05", may: "05", juni: "06", june: "06", juli: "07", july: "07",
    augustus: "08", august: "08", september: "09", oktober: "10", october: "10",
    november: "11", december: "12",
  };
  const named = trimmed.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/);
  if (named && months[named[2]]) return `${named[3]}-${months[named[2]]}-${named[1].padStart(2, "0")}`;
  return value;
}

function buildTimeline(citations: Citation[], dates: CitedFinding[]): TimelineFinding[] {
  return dates.slice(0, 60).map((date) => {
    const citation = citations.find((item) => item.id === date.citations[0]);
    const text = citation?.quote ?? date.text;
    const actorMatch = text.match(/^(?:van|afzender|from|sender)\s*:\s*([^\n,;]{2,100})/i);
    return {
      date: date.normalized || normalizeDate(date.text),
      title: text.slice(0, 110),
      text: text.slice(0, 500),
      actor: actorMatch?.[1]?.trim() ?? null,
      importance: inferImportance(text),
      category: inferCategory(text),
      citations: date.citations,
    };
  });
}

function deterministicAnalysis(extraction: ExtractionResult): DocumentAnalysisResult {
  const { text, method } = extraction;
  const truncated = text.length > MAX_ANALYSIS_CHARS;
  const analyzedText = text.slice(0, MAX_ANALYSIS_CHARS);
  const citations = buildCitations(analyzedText);
  const classification = classifyDocument(analyzedText);
  const dates = findingsForPattern(citations, DATE_PATTERN).map((finding) => ({
    ...finding,
    normalized: normalizeDate(finding.text),
  }));
  const legalIssues: CitedFinding[] = [];
  for (const [issue, pattern] of ISSUE_KEYWORDS) {
    const citation = citations.find((item) => pattern.test(item.quote));
    if (citation) legalIssues.push({ text: issue, citations: [citation.id] });
  }
  const summarySegments = citations.slice(0, 3);
  return {
    schemaVersion: 2,
    analysisVersion: DOCUMENT_ANALYSIS_VERSION,
    contentHash: createHash("sha256").update(analyzedText).digest("hex"),
    status: "complete",
    extractionMethod: method,
    extractionConfidence: extraction.confidence,
    analysisProvider: "local",
    providerModel: null,
    providerStatus: "not_requested",
    providerMessage: null,
    documentType: classification.type,
    confidence: classification.confidence,
    summary: summarySegments.map((item) => item.quote).join(" ").slice(0, 900) || "No readable text was found.",
    analyzedChars: analyzedText.length,
    analyzedWords: analyzedText.match(/[\p{L}\p{N}]+(?:['\u2019-][\p{L}\p{N}]+)*/gu)?.length ?? 0,
    truncated,
    citations,
    parties: extractParties(citations),
    dates,
    amounts: findingsForPattern(citations, AMOUNT_PATTERN),
    claims: contextualFindings(citations, CLAIM_PATTERN),
    obligations: contextualFindings(citations, OBLIGATION_PATTERN),
    legalIssues,
    riskFlags: contextualFindings(citations, RISK_PATTERN),
    timelineEvents: buildTimeline(citations, dates),
  };
}

type AiFinding = { text: string; citations: string[] };
type AiResult = {
  summary: string;
  summaryCitations: string[];
  documentType: string;
  legalIssues: AiFinding[];
  parties: AiFinding[];
  claims: AiFinding[];
  obligations: AiFinding[];
  riskFlags: AiFinding[];
  timelineEvents: Array<AiFinding & { date: string; title: string; actor: string | null; importance: TimelineFinding["importance"]; category: TimelineFinding["category"] }>;
};

function validateAiResult(value: unknown, validCitationIds: Set<string>): value is AiResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AiResult>;
  if (
    typeof candidate.summary !== "string" ||
    typeof candidate.documentType !== "string" ||
    !Array.isArray(candidate.summaryCitations) ||
    candidate.summaryCitations.length === 0 ||
    !candidate.summaryCitations.every((id) => typeof id === "string" && validCitationIds.has(id))
  ) return false;
  const groups = [candidate.legalIssues, candidate.parties, candidate.claims, candidate.obligations, candidate.riskFlags, candidate.timelineEvents];
  if (!groups.every((group) => Array.isArray(group) && group.every((item) =>
    item && typeof item.text === "string" && Array.isArray(item.citations) && item.citations.length > 0 &&
    item.citations.every((id) => typeof id === "string" && validCitationIds.has(id))
  ))) return false;
  return candidate.timelineEvents!.every((event) =>
    typeof event.date === "string" && typeof event.title === "string" &&
    (typeof event.actor === "string" || event.actor === null) &&
    ["critical", "high", "medium", "low"].includes(event.importance) &&
    ["employment", "termination", "communication", "legal", "financial", "other"].includes(event.category)
  );
}

async function enrichAnalysis(base: DocumentAnalysisResult, provider: LLMProvider): Promise<DocumentAnalysisResult> {
  const providerModel = getLLMProviderDescriptors().find((item) => item.id === provider)?.model ?? null;
  if (!isLLMProviderConfigured(provider)) {
    return {
      ...base,
      analysisProvider: provider,
      providerModel,
      providerStatus: "unavailable",
      providerMessage: `${provider} is selected but not configured; local source extraction completed.`,
    };
  }
  const providerCitations: Citation[] = [];
  let providerLength = 0;
  for (const citation of base.citations) {
    const renderedLength = citation.id.length + citation.quote.length + 4;
    if (providerLength + renderedLength > MAX_PROVIDER_CHARS) break;
    providerCitations.push(citation);
    providerLength += renderedLength;
  }
  const sourceText = providerCitations.map((citation) => `[${citation.id}] ${citation.quote}`).join("\n");
  try {
    const response = await invokeLLM({
      provider,
      messages: [
        {
          role: "system",
          content: "Analyze the legal document conservatively. Every finding must cite one or more supplied source IDs. Separate allegations from established facts, do not invent law or dates, and identify obligations, deadlines, risks, parties, and dated events. Return JSON only.",
        },
        { role: "user", content: sourceText },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "source_grounded_legal_document_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              summaryCitations: { type: "array", minItems: 1, items: { type: "string" } },
              documentType: { type: "string" },
              legalIssues: { type: "array", items: { $ref: "#/$defs/finding" } },
              parties: { type: "array", items: { $ref: "#/$defs/finding" } },
              claims: { type: "array", items: { $ref: "#/$defs/finding" } },
              obligations: { type: "array", items: { $ref: "#/$defs/finding" } },
              riskFlags: { type: "array", items: { $ref: "#/$defs/finding" } },
              timelineEvents: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    text: { type: "string" }, citations: { type: "array", minItems: 1, items: { type: "string" } },
                    date: { type: "string" }, title: { type: "string" }, actor: { type: ["string", "null"] },
                    importance: { type: "string", enum: ["critical", "high", "medium", "low"] },
                    category: { type: "string", enum: ["employment", "termination", "communication", "legal", "financial", "other"] },
                  },
                  required: ["text", "citations", "date", "title", "actor", "importance", "category"],
                },
              },
            },
            required: ["summary", "summaryCitations", "documentType", "legalIssues", "parties", "claims", "obligations", "riskFlags", "timelineEvents"],
            $defs: {
              finding: {
                type: "object", additionalProperties: false,
                properties: { text: { type: "string" }, citations: { type: "array", minItems: 1, items: { type: "string" } } },
                required: ["text", "citations"],
              },
            },
          },
        },
      },
    });
    const content = response.choices[0]?.message.content;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const validIds = new Set(providerCitations.map((citation) => citation.id));
    if (!validateAiResult(parsed, validIds)) {
      return {
        ...base,
        analysisProvider: provider,
        providerModel,
        providerStatus: "invalid_response",
        providerMessage: "Deep analysis was discarded because one or more findings lacked valid source citations.",
      };
    }
    return {
      ...base,
      analysisProvider: provider,
      providerModel,
      providerStatus: "complete",
      providerMessage: null,
      summary: parsed.summary,
      documentType: parsed.documentType,
      confidence: Math.max(base.confidence, 80),
      legalIssues: uniqueFindings([...base.legalIssues, ...parsed.legalIssues]),
      parties: uniqueFindings([...base.parties, ...parsed.parties]),
      claims: uniqueFindings([...base.claims, ...parsed.claims]),
      obligations: uniqueFindings([...base.obligations, ...parsed.obligations]),
      riskFlags: uniqueFindings([...base.riskFlags, ...parsed.riskFlags]),
      timelineEvents: parsed.timelineEvents,
    };
  } catch (error) {
    return {
      ...base,
      analysisProvider: provider,
      providerModel,
      providerStatus: "failed",
      providerMessage: error instanceof Error ? error.message.slice(0, 300) : "Deep analysis provider failed.",
    };
  }
}

export async function analyzeDocumentBytes(options: {
  bytes: Buffer;
  mimeType: string;
  deepAnalysis: boolean;
  provider?: LLMProvider;
}): Promise<DocumentAnalysisResult> {
  const extraction = await extractDocumentText(options.bytes, options.mimeType);
  if (extraction.text.length < 20) {
    throw new Error(
      extraction.method === "ocr_text"
        ? "OCR could not extract enough readable text from this image."
        : "No readable text was extracted from this document. Scanned PDFs require conversion to an image before OCR.",
    );
  }
  const base = deterministicAnalysis(extraction);
  return options.deepAnalysis ? enrichAnalysis(base, options.provider || "forge") : base;
}
