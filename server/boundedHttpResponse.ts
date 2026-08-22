import { collectBoundedBytes, withByteReadAdmission } from "./boundedBytes";

export type BoundedHttpResponseOptions = {
  maxBytes: number;
  label: string;
  limitMessage?: string;
};

export async function withBoundedHttpResponse<T>(
  request: () => Promise<Response>,
  handle: (response: Response) => Promise<T>,
): Promise<T> {
  return withByteReadAdmission(async () => {
    const response = await request();
    try {
      return await handle(response);
    } finally {
      if (!response.bodyUsed && typeof response.body?.cancel === "function") {
        await response.body.cancel().catch(() => undefined);
      }
    }
  });
}

function formatByteLimit(maxBytes: number): string {
  const megabyte = 1024 * 1024;
  if (maxBytes % megabyte === 0) return `${maxBytes / megabyte} MB`;
  if (maxBytes % 1024 === 0) return `${maxBytes / 1024} KB`;
  return `${maxBytes} bytes`;
}

function limitMessage(options: BoundedHttpResponseOptions): string {
  return options.limitMessage
    ?? `${options.label} exceeds the ${formatByteLimit(options.maxBytes)} response limit`;
}

function declaredLengthExceedsLimit(response: Response, options: BoundedHttpResponseOptions): boolean {
  const rawLength = response.headers.get("content-length");
  if (rawLength === null) return false;
  const declaredLength = Number(rawLength);
  return !Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > options.maxBytes;
}

export async function readBoundedResponseBytes(
  response: Response,
  options: BoundedHttpResponseOptions,
): Promise<Buffer> {
  if (declaredLengthExceedsLimit(response, options)) {
    if (typeof response.body?.cancel === "function") {
      await response.body.cancel().catch(() => undefined);
    }
    throw new Error(limitMessage(options));
  }
  if (!response.body) return Buffer.alloc(0);
  return collectBoundedBytes(response.body, {
    maxBytes: options.maxBytes,
    label: options.label,
    limitMessage: limitMessage(options),
  });
}

export async function readBoundedResponseText(
  response: Response,
  options: BoundedHttpResponseOptions,
): Promise<string> {
  return (await readBoundedResponseBytes(response, options)).toString("utf8");
}

export async function readBoundedResponseJson<T>(
  response: Response,
  options: BoundedHttpResponseOptions,
): Promise<T> {
  return JSON.parse(await readBoundedResponseText(response, options)) as T;
}
