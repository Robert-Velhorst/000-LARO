import express from 'express';
import { createServer, type Server } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENV } from '../../server/_core/env';
import { cookieMiddleware } from '../../server/cookieMiddleware';
import healthRoutes from '../../server/healthRoutes';
import { listenHttpServer } from '../../server/listen';
import { operationalMetricsMiddleware } from '../../server/operationalMetrics';
import { publicPathPrefixMiddleware } from '../../server/publicPathPrefix';
import { SESSION_COOKIE_NAME } from '../../server/sessionCookie';
import { buildUser } from '../factories';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';

const suite = sqliteAvailable ? describe : describe.skip;

suite('public health and protected operator diagnostics', () => {
  let app: TestApp;
  let server: Server;
  let origin: string;
  const user = buildUser({ id: 'HEALTH_USER', role: 'user', email: 'health-user@example.test' });
  const operator = buildUser({ id: 'HEALTH_OPERATOR', role: 'operator', email: 'health-operator@example.test' });
  const admin = buildUser({ id: 'HEALTH_ADMIN', role: 'admin', email: 'health-admin@example.test' });

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([user, operator, admin]);
    const httpApp = express();
    httpApp.use(publicPathPrefixMiddleware);
    httpApp.use(operationalMetricsMiddleware);
    httpApp.use(cookieMiddleware);
    httpApp.use(healthRoutes);
    server = createServer(httpApp);
    const port = await listenHttpServer(server, 0, '127.0.0.1');
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    delete process.env.PUBLIC_PATH_PREFIX;
    if (server?.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    app?.cleanup();
  });

  function sessionCookie(userId: string): string {
    const token = jwt.sign({ userId, scope: 'session' }, ENV.JWT_SECRET, {
      algorithm: 'HS256',
      expiresIn: '15m',
    });
    return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`;
  }

  async function get(path: string, userId?: string) {
    const response = await fetch(`${origin}${path}`, {
      headers: userId ? { Cookie: sessionCookie(userId) } : undefined,
    });
    return { response, body: await response.json() as Record<string, any> };
  }

  it('keeps every unauthenticated public probe at its minimum supported contract', async () => {
    const live = await get('/api/live');
    expect(live.response.status).toBe(200);
    expect(live.response.headers.get('cache-control')).toBe('no-store');
    expect(live.body).toEqual({ status: 'alive' });

    const ready = await get('/api/ready');
    expect(ready.response.status).toBe(200);
    expect(ready.body).toEqual({ status: 'ready', dbReady: true });

    const health = await get('/api/health');
    expect(health.response.status).toBe(200);
    expect(Object.keys(health.body).sort()).toEqual(['dbReady', 'status', 'timestamp', 'version']);
    expect(health.body).toMatchObject({ status: 'healthy', dbReady: true, version: expect.any(String) });
    expect(health.body).not.toHaveProperty('backup');
    expect(health.body).not.toHaveProperty('warnings');
    expect(health.body).not.toHaveProperty('operations');
    expect(health.body).not.toHaveProperty('workers');
    expect(health.body).not.toHaveProperty('jobs');
  });

  it('denies detailed diagnostics to anonymous and normal users', async () => {
    const anonymous = await get('/api/operator/diagnostics');
    expect(anonymous.response.status).toBe(401);
    expect(anonymous.body).toEqual({ error: 'Authentication required' });

    const normal = await get('/api/operator/diagnostics', user.id);
    expect(normal.response.status).toBe(403);
    expect(normal.body).toEqual({ error: 'Operator access required' });

    await expect(app.makeCaller(user).admin.diagnostics()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(app.makeCaller(user).health.readiness()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it.each([
    ['operator', operator],
    ['admin', admin],
  ] as const)('allows a %s to use the same detailed diagnostic service over HTTP and tRPC', async (_role, account) => {
    const http = await get('/api/operator/diagnostics', account.id);
    expect(http.response.status).toBe(200);
    expect(http.response.headers.get('cache-control')).toBe('no-store');
    expect(http.body).toMatchObject({
      version: expect.any(String),
      db: { ready: true },
      backup: { configured: expect.any(Boolean), status: expect.any(String) },
      operations: {
        totalRequests: expect.any(Number),
        recentP95LatencyMs: expect.any(Number),
      },
      jobs: expect.any(Array),
      workers: expect.any(Array),
      integrations: {
        ai: expect.any(Boolean),
        s3: expect.any(Boolean),
        google: expect.any(Boolean),
        microsoft: expect.any(Boolean),
        email: expect.any(Boolean),
      },
    });

    const trpc = await app.makeCaller(account).admin.diagnostics();
    expect(trpc).toMatchObject({
      version: http.body.version,
      db: { ready: true },
      backup: { configured: http.body.backup.configured },
      jobs: expect.any(Array),
      workers: expect.any(Array),
    });
    const readiness = await app.makeCaller(account).health.readiness();
    expect(readiness).toMatchObject({ dbReady: true, jobs: expect.any(Array) });
  });

  it('preserves minimal public probes and protected diagnostics below a configured public prefix', async () => {
    process.env.PUBLIC_PATH_PREFIX = '/laro';
    const health = await get('/laro/api/health');
    expect(health.response.status).toBe(200);
    expect(Object.keys(health.body).sort()).toEqual(['dbReady', 'status', 'timestamp', 'version']);

    const denied = await get('/laro/api/operator/diagnostics', user.id);
    expect(denied.response.status).toBe(403);
    const allowed = await get('/laro/api/operator/diagnostics', operator.id);
    expect(allowed.response.status).toBe(200);
    expect(allowed.body).toHaveProperty('operations');
    delete process.env.PUBLIC_PATH_PREFIX;
  });
});
