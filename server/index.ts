/**
 * LARO Server — Express + tRPC entry point
 */

import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// A packaged desktop must not trust an arbitrary launch directory's `.env`.
// Standalone/development servers retain cwd and dist-root discovery, while a
// packaged build may only read configuration deliberately shipped as a resource.
const packagedDesktop = process.env.LARO_PACKAGED_DESKTOP === 'true';
const resourcesPath = (process as any).resourcesPath || '';
const possibleEnvPaths = packagedDesktop
  ? [
      path.join(resourcesPath, '.env'),
      path.join(resourcesPath, 'app', '.env'),
    ]
  : [
      path.join(process.cwd(), '.env'),
      path.join(__dirname, '..', '..', '.env'),
    ];

for (const envPath of possibleEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

import express from 'express';
import { createServer } from 'http';
import { createExpressMiddleware } from '@trpc/server/adapters/express';
import cookieParser from 'cookie-parser';
import { corsMiddleware, csrfGuard } from './_core/csrf';

import { appRouter } from './routers';
import { createContext } from './context';
import { compressionMiddleware } from './compression';
import { initCronScheduler } from './cronScheduler';
import oauth2CallbacksRouter from './oauth2Callbacks';
import { getDb } from './db';
import { assertSecurityConfig, ENV } from './_core/env';
import { listenHttpServer } from './listen';
import { APP_VERSION } from './_core/version';
import { initializeRealtimeServer } from './realtime';
import {
  normalizePublicPathPrefix,
  publicPathPrefixMiddleware,
} from './publicPathPrefix';

// ─── Environment ──────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
const isDev = process.env.NODE_ENV === 'development';

// ─── Express setup ────────────────────────────────────────────────────────────

const app = express();
const httpServer = createServer(app);
const publicPathPrefix = normalizePublicPathPrefix(process.env.PUBLIC_PATH_PREFIX);
initializeRealtimeServer(httpServer, `${publicPathPrefix}/socket.io`);

// ─── Middleware ───────────────────────────────────────────────────────────────

// A shared-domain gateway may expose this API below a dedicated prefix. Strip
// it before routing while leaving direct loopback health checks unchanged.
app.use(publicPathPrefixMiddleware);

// Phase 080 (D5) — strict CORS (never `*` with credentials) + CSRF origin guard.
app.use(corsMiddleware);
app.use(csrfGuard);

// ─── Security headers (Phase 029) ───────────────────────────────────────────
// Applied to every response. No external dependency (helmet) is required.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0'); // rely on CSP, not the legacy auditor
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Permissions-Policy',
    'geolocation=(), microphone=(), camera=(), payment=()'
  );
  // Content Security Policy. The renderer is a bundled SPA served from the same
  // origin; connect-src allows the local API. 'unsafe-inline' is kept for styles
  // only (Tailwind/Radix inject style tags). Tighten further in Phase 041.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self' http://localhost:3000 ws://localhost:3000",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  // HSTS only over real HTTPS in production (never on plain localhost).
  if (ENV.isProd && (req.secure || req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(cookieParser());
app.use(express.json({ limit: ENV.API_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: ENV.API_BODY_LIMIT }));
app.use(compressionMiddleware);

// ─── Health check ─────────────────────────────────────────────────────────────

// Phase 035 — observability: liveness (process up), readiness (DB reachable),
// and a health summary. Liveness must never touch the DB; readiness does.
app.get('/api/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

app.get('/api/ready', async (_req, res) => {
  let dbReady = false;
  try {
    const db = await getDb();
    dbReady = !!db;
  } catch {
    dbReady = false;
  }
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? 'ready' : 'not-ready',
    dbReady,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/health', async (_req, res) => {
  let dbReady = false;
  try {
    dbReady = !!(await getDb());
  } catch {
    dbReady = false;
  }
  res.status(dbReady ? 200 : 503).json({
    status: dbReady ? 'healthy' : 'degraded',
    dbReady,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// ─── OAuth2 routes ────────────────────────────────────────────────────────────

if (ENV.SERVER_ONLY) {
  app.get('/', (_req, res) => {
    res.status(200).json({
      service: 'LARO API',
      status: 'available',
      version: APP_VERSION,
      endpoints: {
        health: 'api/health',
        rpc: 'api/trpc',
      },
    });
  });
}

// Mount OAuth2 callback routes
app.use(oauth2CallbacksRouter);

// ─── tRPC middleware ──────────────────────────────────────────────────────────

app.use(
  '/api/trpc',
  createExpressMiddleware({
    router: appRouter,
    createContext,
  })
);

// ─── Static files (Production) ────────────────────────────────────────────────

if (!isDev && !ENV.SERVER_ONLY) {
  // In a packaged Electron app, we need to find the renderer files relative to this file
  // dist/main/server/index.js -> dist/renderer
  const possiblePaths = [
    path.join(__dirname, '..', 'renderer'), // dist/server -> dist/renderer
    path.join(__dirname, '..', '..', 'renderer'), // just in case it's in dist/main/server
    path.join((process as any).resourcesPath || __dirname, 'app', 'dist', 'renderer'),
    path.join(process.cwd(), 'dist', 'renderer'),
    path.join(process.cwd(), 'resources', 'app', 'dist', 'renderer'),
  ];

  let rendererPath = '';
  for (const p of possiblePaths) {
    if (fs.existsSync(p) && fs.existsSync(path.join(p, 'index.html'))) {
      rendererPath = p;
      break;
    }
  }

  if (rendererPath) {
    console.log(`[Server] Serving static files from: ${rendererPath}`);
    app.use(express.static(rendererPath));
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/trpc') && !req.path.startsWith('/api')) {
        res.sendFile(path.join(rendererPath, 'index.html'));
      }
    });
  } else {
    console.error(`[Server] Critical: Could not find renderer path in: ${possiblePaths.join(', ')}`);
  }
} else if (ENV.SERVER_ONLY) {
  console.log('[Server] API-only mode enabled; renderer static files are intentionally disabled.');
}
// ─── Lifecycle ──────────────────────────────────────────────────────────────

export async function startServer(port: number = PORT): Promise<number> {
  // Phase 006: validate security-critical configuration BEFORE accepting any
  // request. In production this throws (fail-safe) if secrets are insecure; in
  // development it returns warnings we log loudly so the mode is unmistakable.
  const configWarnings = assertSecurityConfig();
  console.log(`[Server] Environment: ${ENV.NODE_ENV.toUpperCase()}${ENV.isProd ? '' : ' (development — not for production use)'}`);
  for (const w of configWarnings) console.warn(`[config] ${w}`);

  // Pre-warm the DB so migrations run (and any schema issue surfaces) before
  // we start accepting requests. The first signup/login otherwise races with
  // migration and can hit "no such table: users".
  try {
    const db = await getDb();
    if (!db) throw new Error('Database initialization returned no connection');
    console.log('[Server] Database ready.');
  } catch (err) {
    console.error('[Server] Database pre-warm failed:', err);
    if (ENV.isProd) throw err;
    console.warn('[Server] Development mode will continue without a ready database.');
  }

  const actualPort = await listenHttpServer(httpServer, port, ENV.HOST);
  console.log(`[Server] Integrated backend listening on http://${ENV.HOST}:${actualPort}`);
  initCronScheduler();
  return actualPort;
}

// Start if run directly (though Electron usually calls startServer)
if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
