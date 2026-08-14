import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '../..');

async function startHealthServer(haiStatus: number) {
  const server = createServer((request, response) => {
    const bodies: Record<string, { status: number; body: object }> = {
      '/api/live': { status: 200, body: { status: 'alive' } },
      '/api/ready': { status: 200, body: { status: 'ready', dbReady: true } },
      '/api/health': { status: 200, body: { status: 'healthy', dbReady: true, version: '1.3.0' } },
      '/api/integrations/hai/health': {
        status: haiStatus,
        body: haiStatus === 401 ? { error: 'A valid LARO HAI bearer token is required' } : { status: 'healthy' },
      },
    };
    const result = bodies[request.url || ''] ?? { status: 404, body: { error: 'Not found' } };
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Readiness test server did not bind to a TCP port.');
  return { server, port: address.port };
}

function runReadiness(env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts/runtime-readiness.mjs')], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture(haiStatus = 401) {
  const directory = mkdtempSync(join(tmpdir(), 'laro-runtime-readiness-'));
  const databasePath = join(directory, 'laro.sqlite');
  const storagePath = join(directory, 'uploads');
  const migrationCount = readdirSync(join(ROOT, 'drizzle')).filter((name) => name.endsWith('.sql')).length;
  const database = new Database(databasePath);
  database.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY)');
  const insert = database.prepare('INSERT INTO __drizzle_migrations (id) VALUES (?)');
  for (let id = 1; id <= migrationCount; id += 1) insert.run(id);
  database.close();

  const healthServer = await startHealthServer(haiStatus);
  const env = {
    NODE_ENV: 'production',
    SERVER_ONLY: 'true',
    JWT_SECRET: 'j'.repeat(48),
    COOKIE_SECRET: 'c'.repeat(48),
    DATABASE_URL: databasePath,
    LOCAL_STORAGE_DIR: storagePath,
    PORT: String(healthServer.port),
  };
  return { directory, env, server: healthServer.server };
}

describe('production runtime readiness', () => {
  const directories: string[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('verifies the lean API image contract without development tooling', async () => {
    const current = await fixture();
    directories.push(current.directory);
    servers.push(current.server);
    const result = await runReadiness(current.env);

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('Runtime readiness passed.');
    expect(result.stdout).toMatch(/\[PASS\] database migrations: \d+\/\d+ applied/);
    expect(result.stdout).toContain('[PASS] HAI authentication boundary: HTTP 401');
    expect(readdirSync(current.env.LOCAL_STORAGE_DIR)).toEqual([]);
  });

  it('fails when the HAI route stops enforcing bearer authentication', async () => {
    const current = await fixture(200);
    directories.push(current.directory);
    servers.push(current.server);
    const result = await runReadiness(current.env);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[FAIL] HAI authentication boundary: HTTP 200; status=healthy');
    expect(result.stderr).toContain('Runtime is not ready.');
  });

  it('fails when a required live provider is absent from the running container', async () => {
    const current = await fixture();
    directories.push(current.directory);
    servers.push(current.server);
    const result = await runReadiness({
      ...current.env,
      LARO_REQUIRED_LIVE_PROVIDERS: 'google,outboundEmail',
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('[FAIL] required Google provider: credentials missing');
    expect(result.stdout).toContain('[FAIL] required outbound email provider: configuration missing');
  });
});
