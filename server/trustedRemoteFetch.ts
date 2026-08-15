import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

type ResolvedAddress = { address: string; family: number };

export interface TrustedRemoteFetchOptions {
  allowedHosts: readonly string[];
  init?: RequestInit;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

function ipv4Number(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function isNonPublicIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === null) return true;
  const inRange = (base: number, mask: number) => (value & mask) === (base & mask);
  return inRange(0x00000000, 0xff000000) ||
    inRange(0x0a000000, 0xff000000) ||
    inRange(0x64400000, 0xffc00000) ||
    inRange(0x7f000000, 0xff000000) ||
    inRange(0xa9fe0000, 0xffff0000) ||
    inRange(0xac100000, 0xfff00000) ||
    inRange(0xc0000000, 0xffffff00) ||
    inRange(0xc0a80000, 0xffff0000) ||
    inRange(0xc6120000, 0xfffe0000) ||
    inRange(0xe0000000, 0xf0000000) ||
    inRange(0xf0000000, 0xf0000000);
}

function isNonPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  const family = isIP(normalized);
  if (family === 4) return isNonPublicIpv4(normalized);
  if (family !== 6) return true;
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isNonPublicIpv4(mapped[1]) : false;
}

function trustedHttpsUrl(rawUrl: string, allowedHosts: readonly string[], base?: URL): URL {
  const url = new URL(rawUrl, base);
  const normalizedHosts = new Set(allowedHosts.map((host) => host.toLowerCase()));
  if (url.protocol !== "https:" || url.username || url.password || !normalizedHosts.has(url.hostname.toLowerCase())) {
    throw new Error("Remote URL is outside the trusted HTTPS origins");
  }
  return url;
}

async function assertPublicResolution(hostname: string): Promise<void> {
  if (isIP(hostname)) {
    if (isNonPublicAddress(hostname)) throw new Error("Remote URL resolved to a non-public address");
    return;
  }
  const addresses = await lookup(hostname, { all: true, verbatim: true }) as ResolvedAddress[];
  if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw new Error("Remote URL resolved to a non-public address");
  }
}

async function readBoundedBody(response: Response, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Remote response exceeded the byte limit");
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  const aborted = new Promise<never>((_, reject) => {
    const rejectAbort = () => reject(new Error("Remote response exceeded the time limit"));
    if (signal.aborted) rejectAbort();
    else signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Remote response exceeded the byte limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

function redirectSafeInit(init: RequestInit | undefined, initialOrigin: string, currentOrigin: string): RequestInit {
  const headers = new Headers(init?.headers);
  if (currentOrigin !== initialOrigin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
  }
  return { ...init, headers };
}

export async function fetchTrustedRemote(
  rawUrl: string,
  options: TrustedRemoteFetchOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const externalSignal = options.init?.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });

  try {
    let url = trustedHttpsUrl(rawUrl, options.allowedHosts);
    const initialOrigin = url.origin;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    for (let redirectCount = 0; ; redirectCount += 1) {
      await assertPublicResolution(url.hostname);
      const response = await fetch(url.toString(), {
        ...redirectSafeInit(options.init, initialOrigin, url.origin),
        redirect: "manual",
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const bytes = await readBoundedBody(response, controller.signal, options.maxBytes ?? DEFAULT_MAX_BYTES);
        const body = [204, 205, 304].includes(response.status) ? null : Uint8Array.from(bytes).buffer;
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      await response.body?.cancel().catch(() => undefined);
      if (redirectCount >= maxRedirects) throw new Error("Remote URL exceeded the redirect limit");
      const location = response.headers.get("location");
      if (!location) throw new Error("Remote redirect omitted its destination");
      url = trustedHttpsUrl(location, options.allowedHosts, url);
    }
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}
