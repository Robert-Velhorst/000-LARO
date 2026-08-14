#!/usr/bin/env node
import { randomBytes } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import { mkdir, open, readFile, rm } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INSECURE_SECRETS = new Set([
  '',
  'change-me',
  'change-this-secret',
  'change-this-cookie-secret',
  'changeme',
  'development',
  'insecure',
  'secret',
]);

function strongSecret(value) {
  return typeof value === 'string' && value.length >= 32 && !INSECURE_SECRETS.has(value.toLowerCase());
}

function present(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function requiredProviders(environment) {
  return new Set((environment.LARO_REQUIRED_LIVE_PROVIDERS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean));
}

async function requestJson(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5_000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function inspectDatabase(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = database.pragma('quick_check', { simple: true });
    const foreignKeyViolations = database.pragma('foreign_key_check').length;
    const appliedMigrations = database.prepare('SELECT COUNT(*) AS count FROM __drizzle_migrations').get().count;
    const migrationFiles = readdirSync(join(ROOT, 'drizzle')).filter((name) => name.endsWith('.sql')).length;
    return { quickCheck, foreignKeyViolations, appliedMigrations, migrationFiles };
  } finally {
    database.close();
  }
}

async function probeStorage(storageDirectory) {
  await mkdir(storageDirectory, { recursive: true });
  const probePath = join(storageDirectory, `.runtime-readiness-${process.pid}-${randomBytes(8).toString('hex')}`);
  const expected = randomBytes(32);
  let handle;
  try {
    handle = await open(probePath, 'wx', 0o600);
    await handle.writeFile(expected);
    await handle.sync();
    await handle.close();
    handle = undefined;
    const actual = await readFile(probePath);
    return actual.equals(expected);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(probePath, { force: true });
  }
}

export async function assessRuntimeReadiness(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const packageMetadata = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

  check('production mode', env.NODE_ENV === 'production', `NODE_ENV=${env.NODE_ENV || '<unset>'}`);
  check('API-only mode', env.SERVER_ONLY === 'true', `SERVER_ONLY=${env.SERVER_ONLY || '<unset>'}`);
  check('JWT secret', strongSecret(env.JWT_SECRET), strongSecret(env.JWT_SECRET) ? 'configured' : 'missing or weak');
  check('cookie secret', strongSecret(env.COOKIE_SECRET), strongSecret(env.COOKIE_SECRET) ? 'configured' : 'missing or weak');
  const required = requiredProviders(env);
  if (required.has('google')) {
    const configured = present(env.GOOGLE_CLIENT_ID) && present(env.GOOGLE_CLIENT_SECRET);
    check('required Google provider', configured, configured ? 'configured' : 'credentials missing');
  }
  if (required.has('outboundEmail')) {
    const smtpConfigured = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].every((name) => present(env[name]));
    const sendGridConfigured = present(env.SENDGRID_API_KEY) && present(env.EMAIL_FROM);
    check(
      'required outbound email provider',
      smtpConfigured || sendGridConfigured,
      smtpConfigured ? 'SMTP configured' : sendGridConfigured ? 'SendGrid configured' : 'configuration missing',
    );
  }
  const unknownRequired = [...required].filter((provider) => !['google', 'outboundEmail'].includes(provider));
  if (unknownRequired.length > 0) {
    check('required provider names', false, `unsupported: ${unknownRequired.join(', ')}`);
  }
  if (env.LARO_PUBLIC_DEPLOYMENT_REQUIRED === 'true') {
    let publicContract = false;
    let publicContractDetail = 'invalid public URL contract';
    try {
      const publicUrl = new URL(env.LARO_PUBLIC_BASE_URL || '');
      const oauthUrl = new URL(env.OAUTH_REDIRECT_BASE_URL || '');
      const prefix = (env.PUBLIC_PATH_PREFIX || '').replace(/\/+$/, '');
      const expectedPrefix = publicUrl.pathname === '/' ? '' : publicUrl.pathname.replace(/\/+$/, '');
      const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim());
      publicContract = env.SERVER_ONLY === 'true' &&
        publicUrl.protocol === 'https:' &&
        oauthUrl.toString() === publicUrl.toString() &&
        allowedOrigins.includes(publicUrl.origin) &&
        prefix === expectedPrefix;
      publicContractDetail = publicContract ? `${publicUrl.origin}${expectedPrefix}` : publicContractDetail;
    } catch {
      publicContract = false;
    }
    check('public deployment contract', publicContract, publicContractDetail);
  }

  try {
    const database = inspectDatabase(env.DATABASE_URL || '');
    check('SQLite quick check', database.quickCheck === 'ok', String(database.quickCheck));
    check('SQLite foreign keys', database.foreignKeyViolations === 0, `${database.foreignKeyViolations} violation(s)`);
    check(
      'database migrations',
      database.migrationFiles > 0 && database.appliedMigrations === database.migrationFiles,
      `${database.appliedMigrations}/${database.migrationFiles} applied`,
    );
  } catch (error) {
    check('database inspection', false, error instanceof Error ? error.message : String(error));
  }

  try {
    const writable = await probeStorage(env.LOCAL_STORAGE_DIR || '');
    check('evidence storage', writable, writable ? 'write, sync, read, and cleanup passed' : 'readback mismatch');
  } catch (error) {
    check('evidence storage', false, error instanceof Error ? error.message : String(error));
  }

  const port = Number(env.PORT || 3000);
  const localBaseUrl = `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 3000}`;
  const endpointChecks = [
    {
      name: 'local liveness',
      path: '/api/live',
      validate: ({ status, body }) => status === 200 && body?.status === 'alive',
    },
    {
      name: 'local readiness',
      path: '/api/ready',
      validate: ({ status, body }) => status === 200 && body?.status === 'ready' && body?.dbReady === true,
    },
    {
      name: 'local health and version',
      path: '/api/health',
      validate: ({ status, body }) =>
        status === 200 && body?.status === 'healthy' && body?.dbReady === true && body?.version === packageMetadata.version,
    },
    {
      name: 'HAI authentication boundary',
      path: '/api/integrations/hai/health',
      validate: ({ status }) => status === 401,
    },
  ];
  const endpointResults = await Promise.all(endpointChecks.map(async (endpoint) => {
    try {
      const response = await requestJson(fetchImpl, `${localBaseUrl}${endpoint.path}`);
      return {
        name: endpoint.name,
        ok: endpoint.validate(response),
        detail: `HTTP ${response.status}${response.body?.status ? `; status=${response.body.status}` : ''}`,
      };
    } catch (error) {
      return {
        name: endpoint.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  checks.push(...endpointResults);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version: packageMetadata.version,
    ok: checks.every((entry) => entry.ok),
    checks,
    resources: {
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
    },
  };
}

async function main() {
  const report = await assessRuntimeReadiness();
  console.log(`\nLARO runtime readiness v${report.version}`);
  console.log('----------------------------------------------------------------');
  for (const entry of report.checks) {
    console.log(`[${entry.ok ? 'PASS' : 'FAIL'}] ${entry.name}: ${entry.detail}`);
  }
  console.log(`[INFO] memory: rss=${report.resources.rssBytes} heap=${report.resources.heapUsedBytes}`);
  if (!report.ok) {
    console.error('\nRuntime is not ready.');
    process.exitCode = 1;
    return;
  }
  console.log('\nRuntime readiness passed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
