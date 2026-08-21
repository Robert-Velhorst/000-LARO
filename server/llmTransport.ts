export const LLM_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const LLM_ERROR_MAX_BYTES = 2 * 1024;
export const LLM_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ACTIVE_LLM_REQUESTS = 2;
const MAX_QUEUED_LLM_REQUESTS = 8;

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  onAbort: () => void;
};

const waiters: Waiter[] = [];
let activeRequests = 0;

function abortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} request was cancelled`);
}

function throwIfAborted(signal: AbortSignal, label: string): void {
  if (signal.aborted) throw abortError(signal, label);
}

async function acquireRequestSlot(signal: AbortSignal, label: string): Promise<void> {
  throwIfAborted(signal, label);
  if (activeRequests < MAX_ACTIVE_LLM_REQUESTS) {
    activeRequests += 1;
    return;
  }
  if (waiters.length >= MAX_QUEUED_LLM_REQUESTS) {
    throw new Error("LLM request queue is full; retry after current analyses finish");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      signal,
      onAbort: () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(abortError(signal, label));
      },
    } satisfies Waiter;
    waiters.push(waiter);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    if (signal.aborted) waiter.onAbort();
  });
}

function releaseRequestSlot(): void {
  while (waiters.length > 0) {
    const next = waiters.shift()!;
    next.signal.removeEventListener("abort", next.onAbort);
    if (next.signal.aborted) {
      next.reject(abortError(next.signal, "LLM"));
      continue;
    }
    next.resolve();
    return;
  }
  activeRequests -= 1;
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length")?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The request lifecycle will still be aborted or released by the caller.
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  label: string,
  signal: AbortSignal,
  truncate: boolean,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const declared = contentLength(response);
  if (!truncate && declared !== null && declared > maxBytes) {
    await cancelBody(response);
    throw new Error(`${label} response exceeds the 8 MB limit`);
  }
  if (!response.body) return { bytes: Buffer.alloc(0), truncated: false };

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let wasTruncated = false;
  try {
    while (true) {
      throwIfAborted(signal, label);
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      const remaining = maxBytes - total;
      if (chunk.length > remaining) {
        if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
        total = maxBytes;
        wasTruncated = true;
        await reader.cancel();
        if (!truncate) throw new Error(`${label} response exceeds the 8 MB limit`);
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, total), truncated: wasTruncated };
}

function statusLabel(response: Response): string {
  const text = response.statusText.replace(/[^\x20-\x7E]/g, " ").trim().slice(0, 80);
  return text ? `${response.status} ${text}` : String(response.status);
}

export async function requestLLMJson<T>(options: {
  url: string;
  init: RequestInit;
  label: string;
  signal?: AbortSignal;
}): Promise<T> {
  const lifecycle = new AbortController();
  const cancelFromCaller = () => lifecycle.abort(
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : new Error(`${options.label} request was cancelled`),
  );
  options.signal?.addEventListener("abort", cancelFromCaller, { once: true });
  if (options.signal?.aborted) cancelFromCaller();
  const timeout = setTimeout(
    () => lifecycle.abort(new Error(`${options.label} request exceeded the 300 second limit`)),
    LLM_REQUEST_TIMEOUT_MS,
  );
  timeout.unref?.();
  let acquired = false;
  try {
    await acquireRequestSlot(lifecycle.signal, options.label);
    acquired = true;
    throwIfAborted(lifecycle.signal, options.label);
    const response = await fetch(options.url, { ...options.init, signal: lifecycle.signal });
    if (!response.ok) {
      const errorBody = await readBoundedBody(
        response,
        LLM_ERROR_MAX_BYTES,
        options.label,
        lifecycle.signal,
        true,
      );
      const snippet = errorBody.bytes.toString("utf8").replace(/\s+/g, " ").trim();
      const suffix = snippet ? `: ${snippet}${errorBody.truncated ? " [truncated]" : ""}` : "";
      throw new Error(`LLM invoke failed (${options.label}): ${statusLabel(response)}${suffix}`);
    }
    const body = await readBoundedBody(
      response,
      LLM_RESPONSE_MAX_BYTES,
      options.label,
      lifecycle.signal,
      false,
    );
    try {
      return JSON.parse(body.bytes.toString("utf8")) as T;
    } catch {
      throw new Error(`${options.label} returned invalid JSON`);
    }
  } catch (error) {
    if (lifecycle.signal.aborted) throw abortError(lifecycle.signal, options.label);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancelFromCaller);
    if (acquired) releaseRequestSlot();
  }
}
