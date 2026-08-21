import { Worker } from "worker_threads";

export type OcrWorkerRecognition = {
  data: {
    text: string;
    confidence: number;
  };
};

export type OcrWorkerSession = {
  ready: Promise<void>;
  recognize(bytes: Buffer): Promise<OcrWorkerRecognition>;
  terminate(): Promise<void>;
};

export type OcrWorkerOptions = {
  cachePath: string;
  corePath: string;
  langPath: string;
  workerPath: string;
};

const OCR_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('worker_threads');
  const { createWorker, OEM } = require(workerData.tesseractModulePath);
  let engine;

  async function initialize() {
    try {
      engine = await createWorker(workerData.languages, OEM.LSTM_ONLY, {
        cachePath: workerData.options.cachePath,
        corePath: workerData.options.corePath,
        gzip: true,
        langPath: workerData.options.langPath,
        workerPath: workerData.options.workerPath,
      });
      parentPort.postMessage({ type: 'ready' });
    } catch (error) {
      parentPort.postMessage({ type: 'fatal', error: error instanceof Error ? error.message : String(error) });
    }
  }

  parentPort.on('message', async (message) => {
    if (!engine || message.type !== 'recognize') return;
    try {
      const result = await engine.recognize(Buffer.from(message.bytes), { rotateAuto: true });
      parentPort.postMessage({
        type: 'result',
        id: message.id,
        text: result.data.text,
        confidence: result.data.confidence,
      });
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  void initialize();
`;

export function startOcrWorkerSession(
  languages: string | string[],
  options: OcrWorkerOptions,
): OcrWorkerSession {
  const worker = new Worker(OCR_WORKER_SOURCE, {
    eval: true,
    workerData: {
      languages,
      options,
      tesseractModulePath: require.resolve("tesseract.js"),
    },
  });
  let nextRequestId = 1;
  let terminated = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const pending = new Map<number, {
    resolve: (value: OcrWorkerRecognition) => void;
    reject: (error: Error) => void;
  }>();

  const rejectPending = (error: Error) => {
    rejectReady(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  worker.on("message", (message: {
    type: "ready" | "fatal" | "result" | "error";
    id?: number;
    text?: string;
    confidence?: number;
    error?: string;
  }) => {
    if (message.type === "ready") {
      resolveReady();
      return;
    }
    if (message.type === "fatal") {
      rejectPending(new Error(message.error || "OCR worker initialization failed"));
      return;
    }
    if (typeof message.id !== "number") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === "error") request.reject(new Error(message.error || "OCR recognition failed"));
    else request.resolve({ data: { text: message.text || "", confidence: message.confidence || 0 } });
  });
  worker.on("error", (error) => rejectPending(error));
  worker.on("exit", (code) => {
    if (!terminated && code !== 0) rejectPending(new Error(`OCR worker exited with code ${code}`));
  });

  return {
    ready,
    recognize(bytes) {
      if (terminated) return Promise.reject(new Error("OCR worker has been terminated"));
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise<OcrWorkerRecognition>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "recognize", id, bytes });
      });
    },
    async terminate() {
      if (terminated) return;
      terminated = true;
      rejectPending(new Error("OCR worker was terminated"));
      await worker.terminate();
    },
  };
}
