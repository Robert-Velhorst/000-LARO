import { createHash } from "crypto";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";
import { getDocument, type PDFDocumentLoadingTask, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { Open } from "unzipper";
import {
  getSupportedDocumentAnalysisMimeTypes,
  isSupportedDocumentAnalysisMimeType,
  isSupportedImageOcrMimeType,
} from "../shared/evidenceFiles";
import { getLLMProviderDescriptors, invokeLLM, isLLMProviderConfigured, type LLMProvider } from "./llm";
import { extractImageBatchText, extractImageText } from "./ocr";

export const DOCUMENT_ANALYSIS_VERSION = "3.0.0";
const MAX_ANALYSIS_CHARS = 8 * 1024 * 1024;
const MAX_PROVIDER_CHUNK_CHARS = 60_000;
const MAX_CITATIONS = 10_000;
const MAX_PDF_PAGES = 200;
const MAX_PDF_OCR_PAGES = 25;
const PDF_RENDER_WIDTH = 1_800;
const MAX_PDF_PAGE_PIXELS = 12_000_000;
const MAX_PDF_TOTAL_RENDER_PIXELS = 120_000_000;
const MAX_PDF_RENDERED_BYTES = 64 * 1024 * 1024;
const PDF_RENDER_CHUNK_PAGES = 5;
const DOCUMENT_EXTRACTION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ACTIVE_DOCUMENT_EXTRACTIONS = 2;
const MAX_QUEUED_DOCUMENT_EXTRACTIONS = 8;
const MAX_DOCX_ARCHIVE_ENTRIES = 1_000;
const MAX_DOCX_ENTRY_BYTES = MAX_ANALYSIS_CHARS;
const MAX_DOCX_EXPANDED_BYTES = 32 * 1024 * 1024;

let activeDocumentExtractions = 0;
const documentExtractionWaiters: Array<() => void> = [];

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

export type ContradictionFinding = {
  statementA: string;
  statementB: string;
  explanation: string;
  citations: string[];
};

export type DocumentAnalysisResult = {
  schemaVersion: 2;
  analysisVersion: string;
  contentHash: string;
  status: "complete";
  extractionMethod: "plain_text" | "html" | "pdf_text" | "pdf_ocr" | "docx_text" | "email_text" | "ocr_text";
  extractionConfidence: number | null;
  /** Missing on analyses created before provider-aware cache invalidation. */
  analysisProvider?: "local" | LLMProvider;
  providerModel?: string | null;
  providerStatus: "not_requested" | "unavailable" | "complete" | "partial" | "invalid_response" | "failed";
  providerMessage: string | null;
  documentType: string;
  confidence: number;
  summary: string;
  analyzedChars: number;
  analyzedWords: number;
  truncated: boolean;
  coverage: {
    sourceChars: number;
    analyzedChars: number;
    sourceChunks: number;
    analyzedChunks: number;
    complete: boolean;
  };
  citations: Citation[];
  parties: CitedFinding[];
  dates: CitedFinding[];
  amounts: CitedFinding[];
  claims: CitedFinding[];
  obligations: CitedFinding[];
  legalIssues: CitedFinding[];
  riskFlags: CitedFinding[];
  timelineEvents: TimelineFinding[];
  contradictions: ContradictionFinding[];
};

export type ExtractionResult = {
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

async function acquireDocumentExtractionSlot(): Promise<void> {
  if (activeDocumentExtractions < MAX_ACTIVE_DOCUMENT_EXTRACTIONS) {
    activeDocumentExtractions += 1;
    return;
  }
  if (documentExtractionWaiters.length >= MAX_QUEUED_DOCUMENT_EXTRACTIONS) {
    throw new Error("Document analysis queue is full; retry after current jobs finish");
  }
  await new Promise<void>((resolve) => {
    documentExtractionWaiters.push(resolve);
  });
}

function releaseDocumentExtractionSlot(): void {
  const next = documentExtractionWaiters.shift();
  if (next) next();
  else activeDocumentExtractions -= 1;
}

export async function extractDocumentText(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  return withDocumentAnalysisResourceSlot(() => extractDocumentTextInAcquiredSlot(bytes, mimeType));
}

export async function withDocumentAnalysisResourceSlot<T>(operation: () => Promise<T>): Promise<T> {
  await acquireDocumentExtractionSlot();
  try {
    return await operation();
  } finally {
    releaseDocumentExtractionSlot();
  }
}

export async function extractDocumentTextInAcquiredSlot(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
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
    const deadlineAt = Date.now() + DOCUMENT_EXTRACTION_TIMEOUT_MS;
    try {
      const document = await loadPdfWithinDeadline(bytes, deadlineAt);
      (parser as unknown as { doc: PDFDocumentProxy }).doc = document;
      const info = await beforeExtractionDeadline(() => parser.getInfo(), deadlineAt);
      if (!Number.isInteger(info.total) || info.total < 1) {
        throw new Error("PDF does not contain a valid page count");
      }
      if (info.total > MAX_PDF_PAGES) {
        throw new Error(`PDF exceeds the ${MAX_PDF_PAGES} page analysis limit`);
      }

      const pages: string[] = [];
      let extractedChars = 0;
      for (let pageNumber = 1; pageNumber <= info.total; pageNumber += 1) {
        const pageResult = await beforeExtractionDeadline(
          () => parser.getText({ partial: [pageNumber] }),
          deadlineAt,
        );
        const text = normalizeText(pageResult.pages[0]?.text ?? pageResult.text);
        extractedChars += text.length;
        if (extractedChars > MAX_ANALYSIS_CHARS) {
          throw new Error("PDF text exceeds the 8 MB analysis limit");
        }
        pages.push(text);
      }

      const missingPages = pages
        .map((text, index) => ({ text, pageNumber: index + 1 }))
        .filter((page) => page.text.replace(/[^\p{L}\p{N}]/gu, "").length < 20);
      if (!missingPages.length) {
        const text = normalizeText(pages.join("\n\n"));
        if (text.length > MAX_ANALYSIS_CHARS) {
          throw new Error("PDF text exceeds the 8 MB analysis limit");
        }
        return { text, method: "pdf_text", confidence: null };
      }
      if (missingPages.length > MAX_PDF_OCR_PAGES) {
        throw new Error(`PDF requires OCR for more than ${MAX_PDF_OCR_PAGES} pages`);
      }

      const missingPageNumbers = missingPages.map((page) => page.pageNumber);
      const hasAllPageDimensions = missingPageNumbers.every((pageNumber) =>
        info.pages.some((page) => page.pageNumber === pageNumber)
      );
      const detailedInfo = hasAllPageDimensions
        ? info
        : await beforeExtractionDeadline(
          () => parser.getInfo({ partial: missingPageNumbers, parsePageInfo: true }),
          deadlineAt,
        );
      const pageInfo = new Map(detailedInfo.pages.map((page) => [page.pageNumber, page]));
      let totalRenderPixels = 0;
      for (const pageNumber of missingPageNumbers) {
        const dimensions = pageInfo.get(pageNumber);
        if (!dimensions || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) ||
            dimensions.width <= 0 || dimensions.height <= 0) {
          throw new Error(`PDF page ${pageNumber} has invalid dimensions`);
        }
        const renderedHeight = Math.ceil(dimensions.height * (PDF_RENDER_WIDTH / dimensions.width));
        const pixels = PDF_RENDER_WIDTH * renderedHeight;
        if (!Number.isSafeInteger(pixels) || pixels > MAX_PDF_PAGE_PIXELS) {
          throw new Error(`PDF page ${pageNumber} exceeds the raster pixel limit`);
        }
        totalRenderPixels += pixels;
        if (totalRenderPixels > MAX_PDF_TOTAL_RENDER_PIXELS) {
          throw new Error("PDF exceeds the aggregate raster pixel limit");
        }
      }

      type BatchOcrResult = Awaited<ReturnType<typeof extractImageBatchText>>[number];
      const ocrByPage = new Map<number, BatchOcrResult>();
      let totalRenderedBytes = 0;
      for (const pageChunk of chunks(missingPageNumbers, PDF_RENDER_CHUNK_PAGES)) {
        const rendered = await beforeExtractionDeadline(() => parser.getScreenshot({
          partial: pageChunk,
          desiredWidth: PDF_RENDER_WIDTH,
          imageDataUrl: false,
          imageBuffer: true,
        }), deadlineAt);
        const renderedPageNumbers = new Set(rendered.pages.map((page) => page.pageNumber));
        if (rendered.pages.length !== pageChunk.length || renderedPageNumbers.size !== pageChunk.length ||
            pageChunk.some((pageNumber) => !renderedPageNumbers.has(pageNumber))) {
          throw new Error("PDF renderer did not return every requested page");
        }
        for (const page of rendered.pages) {
          const actualPixels = page.width * page.height;
          if (!Number.isFinite(page.width) || !Number.isFinite(page.height) ||
              page.width < 1 || page.height < 1 || !Number.isSafeInteger(actualPixels) ||
              actualPixels > MAX_PDF_PAGE_PIXELS) {
            throw new Error(`PDF page ${page.pageNumber} exceeds the raster pixel limit`);
          }
        }
        const images = rendered.pages.map((page) => Buffer.from(page.data));
        totalRenderedBytes += images.reduce((sum, image) => sum + image.length, 0);
        if (totalRenderedBytes > MAX_PDF_RENDERED_BYTES) {
          throw new Error("PDF rendered output exceeds the 64 MB analysis limit");
        }
        const recognized = await beforeExtractionDeadline(() => extractImageBatchText(images), deadlineAt);
        if (recognized.length !== rendered.pages.length) {
          throw new Error("OCR did not return a result for every rendered PDF page");
        }
        rendered.pages.forEach((page, index) => ocrByPage.set(page.pageNumber, recognized[index]));
      }
      const merged = pages.map((text, index) => {
        const pageNumber = index + 1;
        const ocr = ocrByPage.get(pageNumber);
        return `[PDF page ${pageNumber}]\n${text || normalizeText(ocr?.text || "")}`;
      });
      const confidences = [...ocrByPage.values()].map((item) => item.confidence);
      const extractedText = normalizeText(merged.join("\n\n"));
      if (extractedText.length > MAX_ANALYSIS_CHARS) {
        throw new Error("PDF extracted text exceeds the 8 MB analysis limit");
      }
      return {
        text: extractedText,
        method: "pdf_ocr",
        confidence: confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : null,
      };
    } finally {
      await parser.destroy();
    }
  }
  if (normalizedMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const deadlineAt = Date.now() + DOCUMENT_EXTRACTION_TIMEOUT_MS;
    await validateDocxArchive(bytes, deadlineAt);
    const result = await beforeExtractionDeadline(() => mammoth.extractRawText({ buffer: bytes }), deadlineAt);
    const text = normalizeText(result.value);
    if (text.length > MAX_ANALYSIS_CHARS) {
      throw new Error("DOCX extracted text exceeds the 8 MB analysis limit");
    }
    return { text, method: "docx_text", confidence: null };
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
      if (citations.length >= MAX_CITATIONS) return citations;
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
  const summarySegments = citations.length <= 3
    ? citations
    : [citations[0], citations[Math.floor(citations.length / 2)], citations[citations.length - 1]];
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
    coverage: {
      sourceChars: text.length,
      analyzedChars: analyzedText.length,
      sourceChunks: citations.length,
      analyzedChunks: citations.length,
      complete: !truncated,
    },
    citations,
    parties: extractParties(citations),
    dates,
    amounts: findingsForPattern(citations, AMOUNT_PATTERN),
    claims: contextualFindings(citations, CLAIM_PATTERN),
    obligations: contextualFindings(citations, OBLIGATION_PATTERN),
    legalIssues,
    riskFlags: contextualFindings(citations, RISK_PATTERN),
    timelineEvents: buildTimeline(citations, dates),
    contradictions: [],
  };
}

async function loadPdfWithinDeadline(bytes: Buffer, deadlineAt: number): Promise<PDFDocumentProxy> {
  const loadingTask: PDFDocumentLoadingTask = getDocument({
    data: new Uint8Array(bytes),
    maxImageSize: MAX_PDF_PAGE_PIXELS,
    canvasMaxAreaInBytes: MAX_PDF_RENDERED_BYTES,
    stopAtErrors: true,
    isEvalSupported: false,
  });
  try {
    return await beforeExtractionDeadline(() => loadingTask.promise, deadlineAt);
  } catch (error) {
    try {
      await loadingTask.destroy();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "PDF initialization failed and its renderer could not be stopped safely",
      );
    }
    throw error;
  }
}

async function validateDocxArchive(bytes: Buffer, deadlineAt: number): Promise<void> {
  const directory = await beforeExtractionDeadline(() => Open.buffer(bytes), deadlineAt);
  if (directory.files.length > MAX_DOCX_ARCHIVE_ENTRIES) {
    throw new Error(`DOCX archive exceeds the ${MAX_DOCX_ARCHIVE_ENTRIES} entry processing limit`);
  }

  let declaredTotal = 0;
  for (const file of directory.files) {
    if (file.type !== "File") continue;
    if (!Number.isSafeInteger(file.uncompressedSize) || file.uncompressedSize < 0) {
      throw new Error("DOCX archive contains an invalid expanded size");
    }
    if (file.uncompressedSize > MAX_DOCX_ENTRY_BYTES) {
      throw new Error("DOCX expanded content exceeds the 8 MB per-entry analysis limit");
    }
    declaredTotal += file.uncompressedSize;
    if (!Number.isSafeInteger(declaredTotal) || declaredTotal > MAX_DOCX_EXPANDED_BYTES) {
      throw new Error("DOCX expanded content exceeds the 32 MB processing limit");
    }
  }

  let actualTotal = 0;
  for (const file of directory.files) {
    if (file.type !== "File") continue;
    const stream = file.stream();
    let entryBytes = 0;
    try {
      await beforeExtractionDeadline(async () => {
        for await (const chunk of stream) {
          const chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
          entryBytes += chunkBytes;
          actualTotal += chunkBytes;
          if (entryBytes > MAX_DOCX_ENTRY_BYTES) {
            throw new Error("DOCX expanded content exceeds the 8 MB per-entry analysis limit");
          }
          if (actualTotal > MAX_DOCX_EXPANDED_BYTES) {
            throw new Error("DOCX expanded content exceeds the 32 MB processing limit");
          }
        }
      }, deadlineAt);
    } finally {
      stream.destroy();
    }
  }
}

type AiFinding = { text: string; citations: string[]; evidenceQuotes: string[] };
type AiContradiction = {
  statementA: string;
  statementB: string;
  explanation: string;
  citations: string[];
  evidenceQuotes: string[];
};
type AiResult = {
  summary: string;
  summaryCitations: string[];
  summaryEvidenceQuotes: string[];
  documentType: string;
  legalIssues: AiFinding[];
  parties: AiFinding[];
  claims: AiFinding[];
  obligations: AiFinding[];
  riskFlags: AiFinding[];
  timelineEvents: Array<AiFinding & { date: string; title: string; actor: string | null; importance: TimelineFinding["importance"]; category: TimelineFinding["category"] }>;
  contradictions: AiContradiction[];
};

const SUPPORT_STOP_WORDS = new Set([
  "and", "the", "that", "this", "with", "from", "voor", "door", "het", "een", "van", "dat", "die", "deze", "zijn", "haar",
  "also", "alsof", "maar", "niet", "naar", "over", "onder", "zoals", "because", "because", "which", "where", "when", "then",
]);

function normalizeSupportText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("nl-NL").replace(/\s+/g, " ").trim();
}

function materialAnchors(value: string): string[] {
  return [...new Set(value.match(/(?:ECLI:[A-Z0-9:.]+|\b\d{1,4}(?:[.,/-]\d{1,4})+\b|[€$£]\s?\d[\d.,]*|\b\d[\d.,]*\s?(?:EUR|EURO|USD|GBP)\b|\b(?:twee|drie|vier|vijf|zes|zeven|acht|negen|tien|elf|twaalf|dertien|veertien|vijftien|zestien|zeventien|achttien|negentien|twintig|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b)/gi) ?? [])]
    .map(normalizeSupportText);
}

function meaningfulTokens(value: string): string[] {
  return [...new Set(normalizeSupportText(value).match(/[\p{L}\p{N}]{4,}/gu) ?? [])]
    .filter((token) => !SUPPORT_STOP_WORDS.has(token));
}

export function findingHasLiteralSourceSupport(
  finding: { text: string; citations: string[]; evidenceQuotes: string[] },
  citationMap: Map<string, Citation>,
): boolean {
  if (!finding.text.trim() || !finding.citations.length || !finding.evidenceQuotes.length) return false;
  const citedSources = finding.citations.map((id) => citationMap.get(id)).filter((item): item is Citation => Boolean(item));
  if (citedSources.length !== finding.citations.length) return false;
  const normalizedSources = citedSources.map((citation) => normalizeSupportText(citation.quote));
  const exactQuotes = finding.evidenceQuotes.map(normalizeSupportText).filter((quote) => quote.length >= 12);
  if (exactQuotes.length !== finding.evidenceQuotes.length) return false;
  if (!exactQuotes.every((quote) => normalizedSources.some((source) => source.includes(quote)))) return false;

  const evidence = exactQuotes.join(" ");
  if (!materialAnchors(finding.text).every((anchor) => evidence.includes(anchor))) return false;
  const tokens = meaningfulTokens(finding.text);
  if (!tokens.length) return true;
  const overlap = tokens.filter((token) => evidence.includes(token)).length;
  return overlap >= Math.min(2, Math.max(1, Math.ceil(tokens.length * 0.12)));
}

function validateAiResult(value: unknown, citationMap: Map<string, Citation>): value is AiResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AiResult>;
  if (
    typeof candidate.summary !== "string" ||
    typeof candidate.documentType !== "string" ||
    !Array.isArray(candidate.summaryCitations) ||
    !Array.isArray(candidate.summaryEvidenceQuotes) ||
    candidate.summaryCitations.length === 0 ||
    !candidate.summaryCitations.every((id) => typeof id === "string" && citationMap.has(id)) ||
    !findingHasLiteralSourceSupport({
      text: candidate.summary,
      citations: candidate.summaryCitations as string[],
      evidenceQuotes: candidate.summaryEvidenceQuotes as string[],
    }, citationMap)
  ) return false;
  const groups = [candidate.legalIssues, candidate.parties, candidate.claims, candidate.obligations, candidate.riskFlags, candidate.timelineEvents];
  if (!groups.every((group) => Array.isArray(group) && group.every((item) =>
    item && typeof item.text === "string" && Array.isArray(item.citations) && Array.isArray(item.evidenceQuotes) &&
    findingHasLiteralSourceSupport(item as AiFinding, citationMap)
  ))) return false;
  if (!candidate.timelineEvents!.every((event) =>
    typeof event.date === "string" && typeof event.title === "string" &&
    (typeof event.actor === "string" || event.actor === null) &&
    ["critical", "high", "medium", "low"].includes(event.importance) &&
    ["employment", "termination", "communication", "legal", "financial", "other"].includes(event.category)
  )) return false;
  return Array.isArray(candidate.contradictions) && candidate.contradictions.every((item) =>
    item && typeof item.statementA === "string" && typeof item.statementB === "string" &&
    typeof item.explanation === "string" && Array.isArray(item.citations) && Array.isArray(item.evidenceQuotes) &&
    findingHasLiteralSourceSupport({ text: `${item.statementA} ${item.statementB}`, citations: item.citations, evidenceQuotes: item.evidenceQuotes }, citationMap)
  );
}

async function beforeExtractionDeadline<T>(operation: () => Promise<T>, deadlineAt: number): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new Error("Document extraction exceeded the 5 minute processing limit");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Document extraction exceeded the 5 minute processing limit")),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function providerChunks(citations: Citation[]): Citation[][] {
  const chunks: Citation[][] = [];
  let current: Citation[] = [];
  let chars = 0;
  for (const citation of citations) {
    const renderedLength = citation.id.length + citation.quote.length + 4;
    if (current.length && chars + renderedLength > MAX_PROVIDER_CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(citation);
    chars += renderedLength;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const FINDING_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    text: { type: "string" },
    citations: { type: "array", minItems: 1, items: { type: "string" } },
    evidenceQuotes: { type: "array", minItems: 1, items: { type: "string" } },
  },
  required: ["text", "citations", "evidenceQuotes"],
};

async function analyzeProviderChunk(provider: LLMProvider, citations: Citation[]): Promise<AiResult> {
  const sourceText = citations.map((citation) => `[${citation.id}] ${citation.quote}`).join("\n");
  const response = await invokeLLM({
    provider,
    messages: [
      {
        role: "system",
        content: [
          "Analyze this portion of a legal document conservatively.",
          "Every finding must cite supplied source IDs and include one or more evidenceQuotes copied verbatim from those cited passages.",
          "Separate allegations from established facts. Do not invent law, dates, motives, causation, or outcomes.",
          "Identify materially inconsistent statements in contradictions; do not call ordinary differences contradictions.",
          "Return every required JSON field even when its array is empty. Return JSON only.",
        ].join(" "),
      },
      { role: "user", content: sourceText },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "source_grounded_legal_document_analysis_v3",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            summary: { type: "string" },
            summaryCitations: { type: "array", minItems: 1, items: { type: "string" } },
            summaryEvidenceQuotes: { type: "array", minItems: 1, items: { type: "string" } },
            documentType: { type: "string" },
            legalIssues: { type: "array", items: { $ref: "#/$defs/finding" } },
            parties: { type: "array", items: { $ref: "#/$defs/finding" } },
            claims: { type: "array", items: { $ref: "#/$defs/finding" } },
            obligations: { type: "array", items: { $ref: "#/$defs/finding" } },
            riskFlags: { type: "array", items: { $ref: "#/$defs/finding" } },
            timelineEvents: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                properties: {
                  ...FINDING_SCHEMA.properties,
                  date: { type: "string" }, title: { type: "string" }, actor: { type: ["string", "null"] },
                  importance: { type: "string", enum: ["critical", "high", "medium", "low"] },
                  category: { type: "string", enum: ["employment", "termination", "communication", "legal", "financial", "other"] },
                },
                required: [...FINDING_SCHEMA.required, "date", "title", "actor", "importance", "category"],
              },
            },
            contradictions: {
              type: "array",
              items: {
                type: "object", additionalProperties: false,
                properties: {
                  statementA: { type: "string" }, statementB: { type: "string" }, explanation: { type: "string" },
                  citations: { type: "array", minItems: 2, items: { type: "string" } },
                  evidenceQuotes: { type: "array", minItems: 2, items: { type: "string" } },
                },
                required: ["statementA", "statementB", "explanation", "citations", "evidenceQuotes"],
              },
            },
          },
          required: ["summary", "summaryCitations", "summaryEvidenceQuotes", "documentType", "legalIssues", "parties", "claims", "obligations", "riskFlags", "timelineEvents", "contradictions"],
          $defs: { finding: FINDING_SCHEMA },
        },
      },
    },
  });
  const content = response.choices[0]?.message.content;
  const parsed = typeof content === "string" ? JSON.parse(content) : content;
  const citationMap = new Map(citations.map((citation) => [citation.id, citation]));
  if (!validateAiResult(parsed, citationMap)) throw new Error("UNSUPPORTED_PROVIDER_FINDINGS");
  return parsed;
}

async function analyzeProviderChunks(provider: LLMProvider, chunks: Citation[][]): Promise<Array<{ result?: AiResult; error?: string }>> {
  const outcomes: Array<{ result?: AiResult; error?: string }> = new Array(chunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(2, chunks.length) }, async () => {
    while (next < chunks.length) {
      const index = next;
      next += 1;
      try {
        outcomes[index] = { result: await analyzeProviderChunk(provider, chunks[index]) };
      } catch (error) {
        outcomes[index] = { error: error instanceof Error ? error.message.slice(0, 300) : "Provider chunk failed" };
      }
    }
  });
  await Promise.all(workers);
  return outcomes;
}

function uniqueContradictions(items: AiContradiction[]): ContradictionFinding[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const key = `${normalizeSupportText(item.statementA)}|${normalizeSupportText(item.statementB)}|${item.citations.join(",")}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ statementA: item.statementA, statementB: item.statementB, explanation: item.explanation, citations: item.citations }];
  });
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
  const chunks = providerChunks(base.citations);
  const outcomes = await analyzeProviderChunks(provider, chunks);
  const valid = outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : []);
  const failures = outcomes.filter((outcome) => !outcome.result);
  if (!valid.length) {
    const unsupported = failures.some((failure) => failure.error === "UNSUPPORTED_PROVIDER_FINDINGS");
    return {
      ...base,
      analysisProvider: provider,
      providerModel,
      providerStatus: unsupported ? "invalid_response" : "failed",
      providerMessage: unsupported
        ? "Deep analysis was discarded because findings lacked literal support in their cited passages."
        : failures[0]?.error || "Deep analysis provider failed.",
      coverage: { ...base.coverage, sourceChunks: chunks.length, analyzedChunks: 0, complete: false },
    };
  }

  const status = failures.length ? "partial" as const : "complete" as const;
  const chunkSummary = valid.map((result, index) => `Part ${index + 1}: ${result.summary.trim()}`).join("\n\n");
  return {
    ...base,
    analysisProvider: provider,
    providerModel,
    providerStatus: status,
    providerMessage: failures.length
      ? `${failures.length} of ${chunks.length} source chunk(s) were rejected or failed; unsupported content was not retained.`
      : null,
    summary: chunkSummary.slice(0, 8_000),
    documentType: valid.map((result) => result.documentType).find((value) => value && value !== "legal document") || valid[0].documentType,
    legalIssues: uniqueFindings([...base.legalIssues, ...valid.flatMap((result) => result.legalIssues)]),
    parties: uniqueFindings([...base.parties, ...valid.flatMap((result) => result.parties)]),
    claims: uniqueFindings([...base.claims, ...valid.flatMap((result) => result.claims)]),
    obligations: uniqueFindings([...base.obligations, ...valid.flatMap((result) => result.obligations)]),
    riskFlags: uniqueFindings([...base.riskFlags, ...valid.flatMap((result) => result.riskFlags)]),
    timelineEvents: valid.flatMap((result) => result.timelineEvents),
    contradictions: uniqueContradictions(valid.flatMap((result) => result.contradictions)),
    coverage: { ...base.coverage, sourceChunks: chunks.length, analyzedChunks: valid.length, complete: !failures.length && base.coverage.complete },
  };
}

export async function analyzeDocumentBytes(options: {
  bytes: Buffer;
  mimeType: string;
  deepAnalysis: boolean;
  provider?: LLMProvider;
}): Promise<DocumentAnalysisResult> {
  const extraction = await extractDocumentText(options.bytes, options.mimeType);
  return analyzeDocumentExtraction({ ...options, extraction });
}

export async function analyzeDocumentExtraction(options: {
  extraction: ExtractionResult;
  deepAnalysis: boolean;
  provider?: LLMProvider;
}): Promise<DocumentAnalysisResult> {
  const extraction = options.extraction;
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
