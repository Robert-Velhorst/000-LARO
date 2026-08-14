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

const STATIC_ALLOWED = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5181',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5181',
  'app://.',
  'file://',
];

export function allowedOrigins(): string[] {
  const extra = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...STATIC_ALLOWED, ...extra];
}

export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return false;
  return allowedOrigins().includes(origin);
}

function isRequestOrigin(req: Request, candidate: string): boolean {
  const host = req.get?.('host') || req.headers.host;
  if (!host) return false;
  const protocol = req.protocol || ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http');
  try {
    return new URL(candidate).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
}

/** Strict CORS: only ever echo an allowlisted origin — never `*` with credentials. */
export function corsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && (isAllowedOrigin(origin) || isRequestOrigin(req, origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus((!!origin && isRequestOrigin(req, origin)) || isAllowedOrigin(origin) || !origin ? 200 : 403);
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
    if (!isAllowedOrigin(origin) && !isRequestOrigin(req, origin)) {
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
      if (!isAllowedOrigin(refOrigin) && !isRequestOrigin(req, refOrigin)) {
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
