import proxyaddr from 'proxy-addr';

type ProxyRequest = {
  connection?: { remoteAddress?: string };
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | string[] | undefined>;
};

let cachedSpec: string | undefined;
let cachedTrust: ReturnType<typeof proxyaddr.compile> | undefined;

function proxyTrust(spec: string): ReturnType<typeof proxyaddr.compile> | undefined {
  const normalized = spec.trim();
  if (!normalized) return undefined;
  if (cachedSpec !== normalized || !cachedTrust) {
    const ranges = normalized.split(',').map((value) => value.trim()).filter(Boolean);
    cachedTrust = proxyaddr.compile(ranges);
    cachedSpec = normalized;
  }
  return cachedTrust;
}

export function validateTrustedProxyCidrs(spec: string | undefined): void {
  if (spec?.trim()) proxyaddr.compile(spec.split(',').map((value) => value.trim()).filter(Boolean));
}

/**
 * Resolve the rate-limit identity at one explicit proxy trust boundary.
 * Forwarded headers are ignored unless the immediate peer is covered by the
 * configured proxy allowlist. proxy-addr then walks outward only through
 * additional trusted hops and returns the first untrusted client address.
 */
export function resolveClientIp(
  request: ProxyRequest,
  trustedProxyCidrs = process.env.LARO_TRUSTED_PROXY_CIDRS || '',
): string {
  const remoteAddress = request.socket?.remoteAddress || request.connection?.remoteAddress || 'unknown';
  const trust = proxyTrust(trustedProxyCidrs);
  if (!trust || !trust(remoteAddress, 0)) return remoteAddress;

  const compatibleRequest = request.connection
    ? request
    : { ...request, connection: request.socket || { remoteAddress } };
  return proxyaddr(compatibleRequest as Parameters<typeof proxyaddr>[0], trust);
}
