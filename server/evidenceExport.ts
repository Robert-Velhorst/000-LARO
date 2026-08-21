import archiver from "archiver";
import { and, eq, sql } from "drizzle-orm";
import { PassThrough, Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { randomBytes } from "crypto";
import { getDb } from "./db";
import { cases, documentAnalyses, evidence } from "./schema";
import { sanitizeFilename, storageOpenReadStream } from "./storage";
import { MAX_EVIDENCE_FILE_BYTES } from "../shared/evidenceFiles";

const MAX_EXPORT_EVIDENCE_ITEMS = 1_000;
const MAX_EXPORT_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_EXPORT_ARCHIVE_BYTES = 600 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_ACTIVE_EXPORTS = 1;
const MAX_QUEUED_EXPORTS = 2;
const EXPORT_TICKET_TTL_MS = 2 * 60 * 1000;
const MAX_EXPORT_TICKETS = 100;
const MAX_EXPORT_TICKETS_PER_USER = 5;
const MAX_GENERATED_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_GENERATED_TOTAL_BYTES = 64 * 1024 * 1024;
let activeExports = 0;
type ExportWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};
const exportWaiters: ExportWaiter[] = [];
const exportTickets = new Map<string, { userId: string; caseId: string; expiresAt: number }>();

export function issueCaseZipDownloadTicket(userId: string, caseId: string): string {
  const now = Date.now();
  for (const [token, ticket] of exportTickets) {
    if (ticket.expiresAt <= now) exportTickets.delete(token);
  }
  if (exportTickets.size >= MAX_EXPORT_TICKETS) {
    throw new Error("Evidence export ticket capacity is full; retry shortly");
  }
  const userTicketCount = [...exportTickets.values()].filter((ticket) => ticket.userId === userId).length;
  if (userTicketCount >= MAX_EXPORT_TICKETS_PER_USER) {
    throw new Error("Too many pending evidence export links; use or wait for an existing link");
  }
  const token = randomBytes(32).toString("base64url");
  exportTickets.set(token, { userId, caseId, expiresAt: now + EXPORT_TICKET_TTL_MS });
  return token;
}

export function consumeCaseZipDownloadTicket(token: string, userId: string): string {
  const ticket = exportTickets.get(token);
  exportTickets.delete(token);
  if (!ticket || ticket.expiresAt <= Date.now() || ticket.userId !== userId) {
    throw new Error("Evidence export link is invalid or expired");
  }
  return ticket.caseId;
}

const SENSITIVE_METADATA_FIELDS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "refreshtoken",
  "secret",
  "storagekey",
  "token",
]);

function normalizeFieldName(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_METADATA_FIELDS.has(normalizeFieldName(key)))
        .map(([key, item]) => [key, redactMetadata(item)])
    );
  }
  return value;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function csvCell(value: unknown): string {
  const rendered = value == null ? "" : String(value);
  return /[",\r\n]/.test(rendered) ? `"${rendered.replace(/"/g, '""')}"` : rendered;
}

function throwIfExportAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("Evidence export was cancelled");
}

async function loadCaseExportRows(
  userId: string,
  caseId: string,
  options: { includeAnalyses: boolean; signal?: AbortSignal },
) {
  throwIfExportAborted(options.signal);
  const db = await getDb();
  const [caseRow] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.userId, userId)))
    .limit(1);
  throwIfExportAborted(options.signal);
  if (!caseRow) throw new Error("Case not found");
  const itemSizes = await db.select({
      id: evidence.id,
      generatedBytes: sql<number>`
        length(CAST(coalesce(${evidence.id}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.title}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.type}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.source}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.description}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.fileUrl}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.fileName}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.fileSize}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.mimeType}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.metadata}, '') AS BLOB)) +
        length(CAST(coalesce(${evidence.tags}, '') AS BLOB))
      `,
    }).from(evidence).where(and(eq(evidence.caseId, caseId), eq(evidence.userId, userId))).limit(MAX_EXPORT_EVIDENCE_ITEMS + 1);
  throwIfExportAborted(options.signal);
  const analysisRefs = options.includeAnalyses
    ? await db.select({
      id: documentAnalyses.id,
      evidenceId: documentAnalyses.evidenceId,
      resultBytes: sql<number>`length(CAST(${documentAnalyses.result} AS BLOB))`,
    }).from(documentAnalyses).where(and(
      eq(documentAnalyses.caseId, caseId),
      eq(documentAnalyses.userId, userId)
    )).limit(MAX_EXPORT_EVIDENCE_ITEMS + 1)
    : [];
  throwIfExportAborted(options.signal);
  if (itemSizes.length > MAX_EXPORT_EVIDENCE_ITEMS || analysisRefs.length > MAX_EXPORT_EVIDENCE_ITEMS) {
    throw new Error(`Case export exceeds the ${MAX_EXPORT_EVIDENCE_ITEMS} item limit`);
  }
  const preflightGeneratedBytes = [...itemSizes.map((item) => item.generatedBytes), ...analysisRefs.map((item) => item.resultBytes)];
  if (preflightGeneratedBytes.some((bytes) => !Number.isSafeInteger(bytes) || bytes > MAX_GENERATED_ENTRY_BYTES) ||
      preflightGeneratedBytes.reduce((total, bytes) => total + bytes, 0) > MAX_GENERATED_TOTAL_BYTES) {
    throw new Error("Case export generated content exceeds the 64 MB processing limit");
  }
  const items = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.caseId, caseId), eq(evidence.userId, userId)))
    .limit(MAX_EXPORT_EVIDENCE_ITEMS);
  throwIfExportAborted(options.signal);
  return { db, caseRow, items, analysisRefs };
}

function renderCaseCsv(items: Array<typeof evidence.$inferSelect>): Buffer {
  const headers = [
    "id",
    "title",
    "type",
    "source",
    "fileName",
    "mimeType",
    "relevant",
    "relevanceScore",
    "createdAt",
    "contentHash",
  ];
  const rows = items.map((item) => {
    const metadata = parseMetadata(item.metadata);
    return [
      item.id,
      item.title,
      item.type,
      item.source,
      item.fileName,
      item.mimeType,
      item.relevant === false ? "No" : "Yes",
      metadata.relevanceScore,
      item.createdAt?.toISOString(),
      metadata.contentHash,
    ].map(csvCell).join(",");
  });
  return Buffer.from(`\uFEFF${[headers.join(","), ...rows].join("\r\n")}\r\n`, "utf8");
}

export async function buildCaseCsv(userId: string, caseId: string): Promise<Buffer> {
  const { items } = await loadCaseExportRows(userId, caseId, { includeAnalyses: false });
  return renderCaseCsv(items);
}

async function acquireExportSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("Evidence export was cancelled");
  if (activeExports < MAX_ACTIVE_EXPORTS) {
    activeExports += 1;
    return;
  }
  if (exportWaiters.length >= MAX_QUEUED_EXPORTS) {
    throw new Error("Evidence export queue is full; retry after the current export finishes");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: ExportWaiter = { resolve, reject, signal };
    waiter.onAbort = () => {
      const index = exportWaiters.indexOf(waiter);
      if (index >= 0) exportWaiters.splice(index, 1);
      reject(new Error("Evidence export was cancelled"));
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    exportWaiters.push(waiter);
  });
}

function releaseExportSlot(): void {
  while (exportWaiters.length) {
    const next = exportWaiters.shift()!;
    next.signal?.removeEventListener("abort", next.onAbort!);
    if (next.signal?.aborted) {
      next.reject(new Error("Evidence export was cancelled"));
      continue;
    }
    next.resolve();
    return;
  }
  activeExports -= 1;
}

function appendStreamEntry(
  archive: archiver.Archiver,
  source: Readable,
  name: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
      source.off("error", onError);
    };
    const onEntry = (entry: { name?: string }) => {
      if (entry.name !== name) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      source.destroy(error);
      reject(error);
    };
    archive.on("entry", onEntry);
    archive.on("error", onError);
    source.on("error", onError);
    archive.append(source, { name });
  });
}

async function appendGeneratedEntry(
  archive: archiver.Archiver,
  name: string,
  value: string | Buffer,
  budget: { bytes: number },
): Promise<void> {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length > MAX_GENERATED_ENTRY_BYTES) {
    throw new Error(`Evidence ZIP entry ${name} exceeds the 8 MB generated-entry limit`);
  }
  budget.bytes += bytes.length;
  if (budget.bytes > MAX_GENERATED_TOTAL_BYTES) {
    throw new Error("Evidence ZIP generated content exceeds the 64 MB processing limit");
  }
  await appendStreamEntry(archive, Readable.from([bytes]), name);
}

export type CaseZipStream = {
  filename: string;
  stream: Readable;
  completion: Promise<{ bytes: number; sourceFileCount: number }>;
};

export async function createCaseZipStream(
  userId: string,
  caseId: string,
  options: { signal?: AbortSignal } = {},
): Promise<CaseZipStream> {
  await acquireExportSlot(options.signal);
  const lifecycle = new AbortController();
  const cancelFromCaller = () => lifecycle.abort(
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : new Error("Evidence export was cancelled"),
  );
  options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
  if (options.signal?.aborted) cancelFromCaller();
  const timeout = setTimeout(
    () => lifecycle.abort(new Error("Evidence ZIP exceeded the 15 minute processing limit")),
    EXPORT_TIMEOUT_MS,
  );
  let slotTransferred = false;
  try {
    throwIfExportAborted(lifecycle.signal);
    const { db, caseRow, items, analysisRefs } = await loadCaseExportRows(userId, caseId, {
      includeAnalyses: true,
      signal: lifecycle.signal,
    });
    const analysisByEvidence = new Map(analysisRefs.map((analysis) => [analysis.evidenceId, analysis]));
    const output = new PassThrough({ highWaterMark: 64 * 1024 });
    const archive = archiver("zip", { zlib: { level: 9 } });
    let archiveBytes = 0;
    let currentSource: Readable | null = null;
    const archiveLimiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        archiveBytes += chunk.length;
        callback(
          archiveBytes > MAX_EXPORT_ARCHIVE_BYTES
            ? new Error("Evidence ZIP exceeds the 600 MB archive limit")
            : null,
          chunk,
        );
      },
    });
    const pipePromise = pipeline(archive, archiveLimiter, output);
    const cancel = (error: Error) => {
      currentSource?.destroy(error);
      archive.abort();
      output.destroy(error);
    };
    const onAbort = () => cancel(
      lifecycle.signal.reason instanceof Error
        ? lifecycle.signal.reason
        : new Error("Evidence export was cancelled"),
    );
    lifecycle.signal.addEventListener("abort", onAbort, { once: true });

    const completion = (async () => {
      let sourceFileCount = 0;
      let sourceBytes = 0;
      const generatedBudget = { bytes: 0 };
      try {
        await appendGeneratedEntry(archive, "evidence.csv", renderCaseCsv(items), generatedBudget);
        await appendGeneratedEntry(
          archive,
          "README.txt",
          "LARO case evidence export.\n\nmanifest.json lists provenance and analysis coverage.\nevidence.csv is a spreadsheet-ready index.\nfiles/ contains available source documents.\nanalysis/ contains source-linked document analyses.\n",
          generatedBudget,
        );
        for (const item of items) {
          throwIfExportAborted(lifecycle.signal);
          await appendGeneratedEntry(
            archive,
            `evidence/${item.id}.json`,
            JSON.stringify({ ...item, metadata: redactMetadata(parseMetadata(item.metadata)) }, null, 2),
            generatedBudget,
          );
          const analysisRef = analysisByEvidence.get(item.id);
          if (analysisRef) {
            const [analysis] = await db
              .select({ result: documentAnalyses.result })
              .from(documentAnalyses)
              .where(and(
                eq(documentAnalyses.id, analysisRef.id),
                eq(documentAnalyses.caseId, caseId),
                eq(documentAnalyses.userId, userId),
              ))
              .limit(1);
            if (analysis) {
              await appendGeneratedEntry(
                archive,
                `analysis/${item.id}.json`,
                analysis.result,
                generatedBudget,
              );
            }
          }
        }
        for (const item of items) {
          throwIfExportAborted(lifecycle.signal);
          const metadata = parseMetadata(item.metadata);
          if (typeof metadata.storageKey !== "string" || !metadata.storageKey) continue;
          let source;
          try {
            source = await storageOpenReadStream(metadata.storageKey, {
              maxBytes: MAX_EVIDENCE_FILE_BYTES,
              signal: lifecycle.signal,
            });
            throwIfExportAborted(lifecycle.signal);
          } catch (error) {
            if (error instanceof Error && /limit/.test(error.message)) throw error;
            continue;
          }
          currentSource = source.stream;
          if (source.declaredBytes !== null && sourceBytes + source.declaredBytes > MAX_EXPORT_SOURCE_BYTES) {
            const error = new Error("Evidence ZIP exceeds the 512 MB aggregate source limit");
            source.stream.destroy(error);
            await source.completion.catch(() => undefined);
            throw error;
          }
          const aggregateLimiter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              sourceBytes += chunk.length;
              callback(
                sourceBytes > MAX_EXPORT_SOURCE_BYTES
                  ? new Error("Evidence ZIP exceeds the 512 MB aggregate source limit")
                  : null,
                chunk,
              );
            },
          });
          const aggregatePipeline = pipeline(source.stream, aggregateLimiter);
          const sourceName = sanitizeFilename(item.fileName || item.title || `${item.id}.bin`);
          await Promise.all([
            appendStreamEntry(archive, aggregateLimiter, `files/${item.id}-${sourceName}`),
            source.completion,
            aggregatePipeline,
          ]);
          currentSource = null;
          sourceFileCount += 1;
        }
        const manifest = {
          format: "laro-case-evidence/v2",
          generatedAt: new Date().toISOString(),
          case: {
            id: caseRow.id,
            clientName: caseRow.clientName,
            caseType: caseRow.caseType,
            caseSummary: caseRow.caseSummary,
            legalAreas: caseRow.legalAreas,
            status: caseRow.status,
          },
          evidenceCount: items.length,
          analyzedEvidenceCount: analysisRefs.length,
          sourceFileCount,
          evidence: items.map((item) => {
            const metadata = parseMetadata(item.metadata);
            return {
              id: item.id,
              title: item.title,
              type: item.type,
              source: item.source,
              fileName: item.fileName,
              mimeType: item.mimeType,
              relevant: item.relevant,
              relevanceScore: metadata.relevanceScore ?? null,
              contentHash: metadata.contentHash ?? null,
              analyzed: analysisByEvidence.has(item.id),
            };
          }),
        };
        await appendGeneratedEntry(archive, "manifest.json", JSON.stringify(manifest, null, 2), generatedBudget);
        await archive.finalize();
        await pipePromise;
        return { bytes: archiveBytes, sourceFileCount };
      } catch (error) {
        cancel(error as Error);
        await pipePromise.catch(() => undefined);
        throw error;
      } finally {
        currentSource?.destroy();
        clearTimeout(timeout);
        lifecycle.signal.removeEventListener("abort", onAbort);
        options.signal?.removeEventListener("abort", cancelFromCaller);
        releaseExportSlot();
      }
    })();
    slotTransferred = true;
    return { filename: `case-${caseId}-evidence.zip`, stream: output, completion };
  } finally {
    if (!slotTransferred) {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancelFromCaller);
      releaseExportSlot();
    }
  }
}
