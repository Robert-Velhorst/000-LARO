export type BoundedByteReadOptions = {
  maxBytes: number;
  label: string;
  limitMessage?: string;
};

const MAX_ACTIVE_BYTE_READS = 4;
const MAX_QUEUED_BYTE_READS = 16;
let activeByteReads = 0;
const byteReadWaiters: Array<() => void> = [];

async function acquireByteReadSlot(): Promise<void> {
  if (activeByteReads < MAX_ACTIVE_BYTE_READS) {
    activeByteReads += 1;
    return;
  }
  if (byteReadWaiters.length >= MAX_QUEUED_BYTE_READS) {
    throw new Error("Evidence import queue is full; retry after current reads finish");
  }
  await new Promise<void>((resolve) => {
    byteReadWaiters.push(resolve);
  });
}

function releaseByteReadSlot(): void {
  const next = byteReadWaiters.shift();
  if (next) next();
  else activeByteReads -= 1;
}

export async function withByteReadAdmission<T>(operation: () => Promise<T>): Promise<T> {
  await acquireByteReadSlot();
  try {
    return await operation();
  } finally {
    releaseByteReadSlot();
  }
}

function assertByteLimit(length: number, options: BoundedByteReadOptions): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > options.maxBytes) {
    throw new Error(options.limitMessage ?? `${options.label} exceeds the ${options.maxBytes} byte read limit`);
  }
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error("Byte stream returned an unsupported chunk type");
}

export async function collectBoundedBytes(
  source: unknown,
  options: BoundedByteReadOptions,
): Promise<Buffer> {
  if (Buffer.isBuffer(source) || source instanceof Uint8Array || source instanceof ArrayBuffer || typeof source === "string") {
    const buffer = toBuffer(source);
    assertByteLimit(buffer.length, options);
    return buffer;
  }

  const iterable = source as AsyncIterable<unknown> | null;
  if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
    throw new Error("Byte source is not a readable stream");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of iterable) {
    const buffer = toBuffer(chunk);
    total += buffer.length;
    assertByteLimit(total, options);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}
