/**
 * Shared test harness (Phases 040–048).
 *
 * Boots the REAL app against a throwaway temp SQLite database (migrations run),
 * and provides `makeCaller(user)` — a real tRPC caller built from `appRouter`, so
 * tests exercise the actual API layer (auth, ownership, rate limits, audit).
 *
 * If the better-sqlite3 native binding is not built, `sqliteAvailable` is false
 * and suites should skip rather than fail.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';

export let sqliteAvailable = true;
try {
  createRequire(import.meta.url)('better-sqlite3');
} catch {
  sqliteAvailable = false;
}

export interface TestApp {
  db: any;
  schema: any;
  appRouter: any;
  tmpDir: string;
  makeCaller: (
    user: { id: string; name?: string; role?: string; email?: string | null } | null,
    authScope?: "session",
    desktopScanner?: boolean,
  ) => any;
  cleanup: () => void;
}

function fakeReqRes() {
  const req: any = {
    headers: {},
    cookies: {},
    protocol: 'http',
    secure: false,
    socket: { remoteAddress: '127.0.0.1' },
    get: () => undefined,
  };
  const cookies: Record<string, any> = {};
  const res: any = {
    cookie: (name: string, val: string) => { cookies[name] = val; return res; },
    clearCookie: (name: string) => { delete cookies[name]; return res; },
    _cookies: cookies,
  };
  return { req, res };
}

export async function bootTestApp(): Promise<TestApp> {
  process.env.NODE_ENV = 'test';
  const tmpDir = mkdtempSync(join(tmpdir(), 'laro-app-'));
  process.env.DATABASE_URL = join(tmpDir, 'test.sqlite');
  process.env.LOCAL_STORAGE_DIR = join(tmpDir, 'uploads');

  const dbmod = await import('../../server/db');
  const schema = await import('../../server/schema');
  const routers = await import('../../server/routers');
  const appRouter: any = routers.appRouter;

  const db = await dbmod.getDb();

  const makeCaller = (user: any, authScope: "session" = "session", desktopScanner = false) => {
    const { req, res } = fakeReqRes();
    return appRouter.createCaller({ req, res, user, authScope, desktopScanner });
  };

  return {
    db,
    schema,
    appRouter,
    tmpDir,
    makeCaller,
    cleanup: () => { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}
