import type { Request, Response, NextFunction } from 'express';

/**
 * Phase 080 (D5) — CSRF protection + strict CORS origin control.
 *
 * The API authenticates via a cookie, which makes it a CSRF target. Defense:
 * for any state-changing request (POST/PUT/PATCH/DELETE) that arrives with an
 * Origin/Referer, that origin MUST be in the allowlist. A cross-site page cannot
 * forge the Origin header, so a forged request from evil.example is rejected.
 *
 * Requests with NO Origin and NO Referer are same-origin/native (the Electron
 * renderer, server-to-server, tests) and are allowed — browsers always attach an
 * Origin to cross-origin state-changing requests, so their absence is safe.
 */

const DEVELOPMENT_ALLOWED = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5181',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5181',
];

function canonicalHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function allowedOrigins(): string[] {
  const configured = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .map(canonicalHttpOrigin)
    .filter((origin): origin is string => Boolean(origin));
  const development = process.env.NODE_ENV === 'development' ? DEVELOPMENT_ALLOWED : [];
  return [...new Set([...development, ...configured])];
}

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  const canonical = canonicalHttpOrigin(origin);
  return canonical !== null && allowedOrigins().includes(canonical);
}

function requestOrigin(req: Request): string | null {
  const host = req.get?.('host') || req.headers.host;
  if (!host) return null;
  const protocol = req.protocol || ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http');
  return canonicalHttpOrigin(`${protocol}://${host}`);
}

/** One canonical decision shared by preflight, CORS response, and CSRF. */
export function isOriginAllowedForRequest(
  req: Request,
  candidate: string | undefined | null,
): boolean {
  if (!candidate) return false;
  const canonical = canonicalHttpOrigin(candidate);
  if (!canonical) return false;
  return allowedOrigins().includes(canonical) || canonical === requestOrigin(req);
}

/** Strict CORS: only ever echo an allowlisted origin — never `*` with credentials. */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  const permitted = isOriginAllowedForRequest(req, origin);
  if (origin && permitted) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(permitted || !origin ? 200 : 403);
    return;
  }
  next();
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Reject state-changing requests whose Origin/Referer is a disallowed cross-site. */
export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING.has(req.method)) return next();

  const origin = req.headers.origin;
  if (origin) {
    if (!isOriginAllowedForRequest(req, origin)) {
      res.status(403).json({ error: 'CSRF: origin not allowed' });
      return;
    }
    return next();
  }
  // No Origin: fall back to Referer host check when present.
  const referer = req.headers.referer;
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      if (!isOriginAllowedForRequest(req, refOrigin)) {
        res.status(403).json({ error: 'CSRF: referer not allowed' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'CSRF: malformed referer' });
      return;
    }
  }
  // Neither Origin nor Referer → same-origin/native client; allow.
  next();
}
