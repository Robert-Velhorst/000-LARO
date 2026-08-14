import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const ROOT = join(__dirname, '../..');

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'laro-runtime-readiness-'));
  const databasePath = join(directory, 'laro.sqlite');
  const storagePath = join(directory, 'uploads');
  const migrationCount = readdirSync(join(ROOT, 'drizzle')).filter((name) => name.endsWith('.sql')).length;
  const database = new Database(databasePath);
  database.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY)');
  const insert = database.prepare('INSERT INTO __drizzle_migrations (id) VALUES (?)');
  for (let id = 1; id <= migrationCount; id += 1) insert.run(id);
  database.close();

  const moduleUrl = pathToFileURL(join(ROOT, 'scripts/runtime-readiness.mjs')).href;
  const readiness = await import(moduleUrl);
  const env = {
    NODE_ENV: 'production',
    SERVER_ONLY: 'true',
    JWT_SECRET: 'j'.repeat(48),
    COOKIE_SECRET: 'c'.repeat(48),
    DATABASE_URL: databasePath,
    LOCAL_STORAGE_DIR: storagePath,
    PORT: '3000',
  };
  return { directory, env, readiness };
}

function healthyFetch(haiStatus = 401) {
  return async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/live') return Response.json({ status: 'alive' });
    if (path === '/api/ready') return Response.json({ status: 'ready', dbReady: true });
    if (path === '/api/health') return Response.json({ status: 'healthy', dbReady: true, version: '1.3.0' });
    if (path === '/api/integrations/hai/health') {
      return Response.json({ error: 'A valid LARO HAI bearer token is required' }, { status: haiStatus });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  };
}

describe('production runtime readiness', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('verifies the lean API image contract without development tooling', async () => {
    const current = await fixture();
    directories.push(current.directory);
    const report = await current.readiness.assessRuntimeReadiness({
      env: current.env,
      fetchImpl: healthyFetch(),
    });

    expect(report.ok).toBe(true);
    expect(report.checks.every((entry: { ok: boolean }) => entry.ok)).toBe(true);
    expect(report.checks.find((entry: { name: string }) => entry.name === 'database migrations')?.detail)
      .toMatch(/^\d+\/\d+ applied$/);
    expect(readdirSync(current.env.LOCAL_STORAGE_DIR)).toEqual([]);
  });

  it('fails when the HAI route stops enforcing bearer authentication', async () => {
    const current = await fixture();
    directories.push(current.directory);
    const report = await current.readiness.assessRuntimeReadiness({
      env: current.env,
      fetchImpl: healthyFetch(200),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((entry: { name: string }) => entry.name === 'HAI authentication boundary'))
      .toMatchObject({ ok: false, detail: 'HTTP 200' });
  });
});
