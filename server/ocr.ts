import { copyFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, sep } from "path";
import engData from "@tesseract.js-data/eng";
import nldData from "@tesseract.js-data/nld";
import { createWorker, OEM } from "tesseract.js";
import { MAX_EVIDENCE_FILE_BYTES } from "../shared/evidenceFiles";

export type OcrLanguage = "nld" | "eng" | "nld+eng";

export type OcrResult = {
  text: string;
  confidence: number;
  language: OcrLanguage;
  processingTimeMs: number;
};

const OCR_TIMEOUT_MS = 120_000;
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

async function runOcr(bytes: Buffer, language: OcrLanguage): Promise<OcrResult> {
  if (!bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error("OCR images must be between 1 byte and 7 MB");
  }

  await prepareLanguageData();
  const startedAt = Date.now();
  const languages = language === "nld+eng" ? ["nld", "eng"] : language;
  const worker = await createWorker(languages, OEM.LSTM_ONLY, {
    cachePath: OCR_CACHE_PATH,
    corePath: corePath(),
    gzip: true,
    langPath: OCR_LANG_PATH,
    workerPath: workerPath(),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void worker.terminate().catch(() => undefined);
        reject(new Error("OCR exceeded the 120 second processing limit"));
      }, OCR_TIMEOUT_MS);
    });
    const recognition = worker.recognize(bytes, { rotateAuto: true });
    const result = await Promise.race([recognition, timeout]);
    return {
      text: result.data.text,
      confidence: Math.max(0, Math.min(100, result.data.confidence)),
      language,
      processingTimeMs: Date.now() - startedAt,
    };
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate().catch(() => undefined);
  }
}

async function runOcrBatch(images: Buffer[], language: OcrLanguage): Promise<OcrResult[]> {
  if (!images.length) return [];
  if (images.some((bytes) => !bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES)) {
    throw new Error("OCR images must each be between 1 byte and 7 MB");
  }

  await prepareLanguageData();
  const languages = language === "nld+eng" ? ["nld", "eng"] : language;
  const worker = await createWorker(languages, OEM.LSTM_ONLY, {
    cachePath: OCR_CACHE_PATH,
    corePath: corePath(),
    gzip: true,
    langPath: OCR_LANG_PATH,
    workerPath: workerPath(),
  });

  try {
    const results: OcrResult[] = [];
    for (const bytes of images) {
      const startedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("OCR exceeded the 120 second per-page processing limit")), OCR_TIMEOUT_MS);
        });
        const result = await Promise.race([worker.recognize(bytes, { rotateAuto: true }), timeout]);
        results.push({
          text: result.data.text,
          confidence: Math.max(0, Math.min(100, result.data.confidence)),
          language,
          processingTimeMs: Date.now() - startedAt,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return results;
  } finally {
    await worker.terminate().catch(() => undefined);
  }
}

let ocrQueue: Promise<void> = Promise.resolve();

export function extractImageText(bytes: Buffer, language?: string): Promise<OcrResult> {
  const selectedLanguage = normalizeLanguage(language);
  const job = ocrQueue.then(
    () => runOcr(bytes, selectedLanguage),
    () => runOcr(bytes, selectedLanguage),
  );
  ocrQueue = job.then(() => undefined, () => undefined);
  return job;
}

export function extractImageBatchText(images: Buffer[], language?: string): Promise<OcrResult[]> {
  const selectedLanguage = normalizeLanguage(language);
  const job = ocrQueue.then(
    () => runOcrBatch(images, selectedLanguage),
    () => runOcrBatch(images, selectedLanguage),
  );
  ocrQueue = job.then(() => undefined, () => undefined);
  return job;
}

export function resolveOcrLanguage(language?: string): OcrLanguage {
  return normalizeLanguage(language);
}
