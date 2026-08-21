import { copyFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, sep } from "path";
import engData from "@tesseract.js-data/eng";
import nldData from "@tesseract.js-data/nld";
import { MAX_EVIDENCE_FILE_BYTES } from "../shared/evidenceFiles";
import { startOcrWorkerSession, type OcrWorkerSession } from "./ocrWorker";

export type OcrLanguage = "nld" | "eng" | "nld+eng";

export type OcrResult = {
  text: string;
  confidence: number;
  language: OcrLanguage;
  processingTimeMs: number;
};

const OCR_TIMEOUT_MS = 120_000;
const OCR_BATCH_TIMEOUT_MS = 5 * 60_000;
const OCR_CLEANUP_TIMEOUT_MS = 10_000;
const MAX_OCR_BATCH_IMAGES = 25;
const MAX_OCR_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_OCR_IMAGE_PIXELS = 40_000_000;
const MAX_OCR_BATCH_PIXELS = 120_000_000;
const MAX_OCR_IMAGE_DIMENSION = 20_000;
const MAX_OCR_QUEUE_JOBS = 4;
const OCR_ROOT = join(tmpdir(), "laro-ocr-v1");
const OCR_LANG_PATH = join(OCR_ROOT, "tessdata");
const OCR_CACHE_PATH = join(OCR_ROOT, "cache");

function unpackedPath(filePath: string): string {
  const marker = `${sep}app.asar${sep}`;
  const candidate = filePath.includes(marker)
    ? filePath.replace(marker, `${sep}app.asar.unpacked${sep}`)
    : filePath;
  return existsSync(candidate) ? candidate : filePath;
}

async function copyIfChanged(source: string, target: string): Promise<void> {
  const sourceStats = await stat(source);
  const targetStats = await stat(target).catch(() => null);
  if (targetStats?.size === sourceStats.size) return;
  await copyFile(source, target);
}

async function prepareLanguageData(): Promise<void> {
  await Promise.all([
    mkdir(OCR_LANG_PATH, { recursive: true }),
    mkdir(OCR_CACHE_PATH, { recursive: true }),
  ]);
  await Promise.all([
    copyIfChanged(
      unpackedPath(join(nldData.langPath, `${nldData.code}.traineddata.gz`)),
      join(OCR_LANG_PATH, `${nldData.code}.traineddata.gz`),
    ),
    copyIfChanged(
      unpackedPath(join(engData.langPath, `${engData.code}.traineddata.gz`)),
      join(OCR_LANG_PATH, `${engData.code}.traineddata.gz`),
    ),
  ]);
}

function workerPath(): string {
  return unpackedPath(require.resolve("tesseract.js/src/worker-script/node/index.js"));
}

function corePath(): string {
  return unpackedPath(dirname(require.resolve("tesseract.js-core/package.json")));
}

function normalizeLanguage(language: string | undefined): OcrLanguage {
  const normalized = language?.trim().toLowerCase();
  if (normalized === "eng" || normalized === "en") return "eng";
  if (normalized === "nld" || normalized === "nl") return "nld";
  return "nld+eng";
}

type ImageDimensions = { width: number; height: number };

function jpegDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (startOfFrame.has(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}

function webpDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const kind = bytes.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    const width = 1 + bytes.readUIntLE(24, 3);
    const height = 1 + bytes.readUIntLE(27, 3);
    return { width, height };
  }
  if (kind === "VP8 " && bytes.toString("hex", 23, 26) === "9d012a") {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  return null;
}

function imageDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      bytes.toString("ascii", 12, 16) === "IHDR") {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 22 && bytes.toString("ascii", 0, 2) === "BM") {
    const dibHeaderSize = bytes.readUInt32LE(14);
    if (dibHeaderSize === 12) {
      return { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20) };
    }
    if (dibHeaderSize >= 40 && bytes.length >= 26) {
      const width = bytes.readInt32LE(18);
      const signedHeight = bytes.readInt32LE(22);
      if (width <= 0 || signedHeight === 0 || signedHeight === -2_147_483_648) return null;
      return { width, height: Math.abs(signedHeight) };
    }
    return null;
  }
  const webp = webpDimensions(bytes);
  if (webp) return webp;
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return jpeg;
  if (bytes.length >= 7 && (bytes.toString("ascii", 0, 2) === "P1" || bytes.toString("ascii", 0, 2) === "P4")) {
    const tokens = bytes.toString("ascii", 0, Math.min(bytes.length, 1_024))
      .replace(/#[^\r\n]*/g, " ")
      .trim()
      .split(/\s+/);
    const width = Number(tokens[1]);
    const height = Number(tokens[2]);
    return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
  }
  return null;
}

function validatedOcrPixels(bytes: Buffer): number {
  const dimensions = imageDimensions(bytes);
  if (!dimensions || !Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) ||
      dimensions.width < 1 || dimensions.height < 1) {
    throw new Error("OCR image format or dimensions could not be validated");
  }
  const pixels = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_OCR_IMAGE_PIXELS ||
      dimensions.width > MAX_OCR_IMAGE_DIMENSION || dimensions.height > MAX_OCR_IMAGE_DIMENSION) {
    throw new Error("OCR image exceeds the 40 megapixel limit");
  }
  return pixels;
}

function assertOcrImageInput(bytes: Buffer): void {
  if (!bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error("OCR images must be between 1 byte and 7 MB");
  }
  validatedOcrPixels(bytes);
}

function assertOcrBatchInput(images: Buffer[]): void {
  if (images.length > MAX_OCR_BATCH_IMAGES) {
    throw new Error(`OCR batches are limited to ${MAX_OCR_BATCH_IMAGES} images`);
  }
  if (images.some((bytes) => !bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES)) {
    throw new Error("OCR images must each be between 1 byte and 7 MB");
  }
  if (images.reduce((total, bytes) => total + bytes.length, 0) > MAX_OCR_BATCH_BYTES) {
    throw new Error("OCR batch input exceeds the 64 MB processing limit");
  }
  if (images.reduce((total, bytes) => total + validatedOcrPixels(bytes), 0) > MAX_OCR_BATCH_PIXELS) {
    throw new Error("OCR batch exceeds the aggregate 120 megapixel limit");
  }
}

async function runOcr(bytes: Buffer, language: OcrLanguage): Promise<OcrResult> {
  assertOcrImageInput(bytes);

  const startedAt = Date.now();
  const deadlineAt = startedAt + OCR_TIMEOUT_MS;
  await beforeOcrDeadline(
    () => prepareLanguageData(),
    deadlineAt,
    "OCR exceeded the 120 second processing limit",
  );
  const languages = language === "nld+eng" ? ["nld", "eng"] : language;
  const worker = startOcrWorkerSession(languages, {
    cachePath: OCR_CACHE_PATH,
    corePath: corePath(),
    langPath: OCR_LANG_PATH,
    workerPath: workerPath(),
  });
  try {
    await beforeOcrDeadline(
      () => worker.ready,
      deadlineAt,
      "OCR exceeded the 120 second processing limit",
      () => terminateWorker(worker),
    );
  } catch (error) {
    await terminateWorker(worker);
    throw error;
  }

  try {
    const result = await beforeOcrDeadline(
      () => worker.recognize(bytes),
      deadlineAt,
      "OCR exceeded the 120 second processing limit",
      () => terminateWorker(worker),
    );
    return {
      text: result.data.text,
      confidence: Math.max(0, Math.min(100, result.data.confidence)),
      language,
      processingTimeMs: Date.now() - startedAt,
    };
  } finally {
    await terminateWorker(worker);
  }
}

async function runOcrBatch(images: Buffer[], language: OcrLanguage): Promise<OcrResult[]> {
  if (!images.length) return [];
  assertOcrBatchInput(images);

  const deadlineAt = Date.now() + OCR_BATCH_TIMEOUT_MS;
  await beforeOcrDeadline(
    () => prepareLanguageData(),
    deadlineAt,
    "OCR batch exceeded the 5 minute processing limit",
  );
  const languages = language === "nld+eng" ? ["nld", "eng"] : language;
  const worker = startOcrWorkerSession(languages, {
    cachePath: OCR_CACHE_PATH,
    corePath: corePath(),
    langPath: OCR_LANG_PATH,
    workerPath: workerPath(),
  });
  try {
    await beforeOcrDeadline(
      () => worker.ready,
      deadlineAt,
      "OCR batch exceeded the 5 minute processing limit",
      () => terminateWorker(worker),
    );
  } catch (error) {
    await terminateWorker(worker);
    throw error;
  }

  try {
    const results: OcrResult[] = [];
    for (const bytes of images) {
      const startedAt = Date.now();
      const pageDeadlineAt = Math.min(deadlineAt, startedAt + OCR_TIMEOUT_MS);
      const timeoutMessage = pageDeadlineAt === deadlineAt
        ? "OCR batch exceeded the 5 minute processing limit"
        : "OCR exceeded the 120 second per-page processing limit";
      const result = await beforeOcrDeadline(
        () => worker.recognize(bytes),
        pageDeadlineAt,
        timeoutMessage,
        () => terminateWorker(worker),
      );
      results.push({
        text: result.data.text,
        confidence: Math.max(0, Math.min(100, result.data.confidence)),
        language,
        processingTimeMs: Date.now() - startedAt,
      });
    }
    return results;
  } finally {
    await terminateWorker(worker);
  }
}

async function beforeOcrDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  timeoutMessage: string,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    await onTimeout?.();
    throw new Error(timeoutMessage);
  }
  const timeoutToken = Symbol("ocr-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation(),
      new Promise<typeof timeoutToken>((resolve) => {
        timer = setTimeout(() => resolve(timeoutToken), remainingMs);
      }),
    ]);
    if (result === timeoutToken) {
      await onTimeout?.();
      throw new Error(timeoutMessage);
    }
    return result as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function terminateWorker(worker: OcrWorkerSession): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      worker.terminate().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, OCR_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let ocrQueue: Promise<void> = Promise.resolve();
let queuedOcrJobs = 0;

function enqueueOcr<T>(operation: () => Promise<T>): Promise<T> {
  if (queuedOcrJobs >= MAX_OCR_QUEUE_JOBS) {
    return Promise.reject(new Error("OCR queue is full; retry after current analysis jobs finish"));
  }
  queuedOcrJobs += 1;
  const job = ocrQueue.then(operation, operation);
  const settled = job.then(
    (value) => {
      queuedOcrJobs -= 1;
      return value;
    },
    (error) => {
      queuedOcrJobs -= 1;
      throw error;
    },
  );
  ocrQueue = settled.then(() => undefined, () => undefined);
  return settled;
}

export function extractImageText(bytes: Buffer, language?: string): Promise<OcrResult> {
  try {
    assertOcrImageInput(bytes);
  } catch (error) {
    return Promise.reject(error);
  }
  const selectedLanguage = normalizeLanguage(language);
  return enqueueOcr(() => runOcr(bytes, selectedLanguage));
}

export function extractImageBatchText(images: Buffer[], language?: string): Promise<OcrResult[]> {
  try {
    assertOcrBatchInput(images);
  } catch (error) {
    return Promise.reject(error);
  }
  if (!images.length) return Promise.resolve([]);
  const selectedLanguage = normalizeLanguage(language);
  return enqueueOcr(() => runOcrBatch(images, selectedLanguage));
}

export function resolveOcrLanguage(language?: string): OcrLanguage {
  return normalizeLanguage(language);
}
