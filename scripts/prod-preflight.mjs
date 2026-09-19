#!/usr/bin/env node
import 'dotenv/config';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (level, name, ok, detail) => results.push({ level, name, ok, detail });
const effectiveNodeEnv = process.env.NODE_ENV || 'production';
const isProd = effectiveNodeEnv === 'production';

check('INFO', 'NODE_ENV', true, `NODE_ENV=${effectiveNodeEnv}${process.env.NODE_ENV ? '' : ' (default)'}`);
const insecure = new Set(['', undefined, 'change-me', 'changeme', 'secret', 'dev', 'development', 'insecure']);
for (const key of ['JWT_SECRET', 'COOKIE_SECRET']) {
  const value = process.env[key];
  const strong = !!value && value.length >= 16 && !insecure.has(value);
  check('BLOCKER', `${key} strong`, strong || !isProd,
    strong ? 'set and strong' : isProd ? 'missing or weak in production' : 'not set (allowed outside production)');
}

if (process.env.LARO_BACKUP_DIRECTORY?.trim()) {
  const recoveryKeyFile = process.env.LARO_RECOVERY_KEY_FILE?.trim();
  let recoveryKey = process.env.LARO_RECOVERY_KEY;
  if (!recoveryKey && recoveryKeyFile && existsSync(recoveryKeyFile)) {
    recoveryKey = readFileSync(recoveryKeyFile, 'utf8').trim();
  }
  const recoveryStrong = !!recoveryKey && Buffer.byteLength(recoveryKey, 'utf8') >= 32;
  check(
    'BLOCKER',
    'separate backup recovery credential',
    recoveryStrong || !isProd,
    recoveryStrong ? 'configured separately from app secrets' : 'missing or weak while scheduled backups are enabled',
  );
}

const demoOff = process.env.DEMO_MODE !== 'true';
check('BLOCKER', 'demo mode off', demoOff || !isProd, demoOff ? 'demo off' : 'demo must be off in production');

const migrationDir = join(ROOT, 'drizzle');
const hasMigrations = existsSync(migrationDir) && readdirSync(migrationDir).some((name) => name.endsWith('.sql'));
check('BLOCKER', 'migrations present', hasMigrations, hasMigrations ? 'SQL migrations found' : 'no SQL migrations found');

let tracked = '';
try { tracked = execSync('git ls-files', { cwd: ROOT }).toString(); } catch { /* source archive without git */ }
const leaked = tracked.split('\n').filter((file) => /^\.env($|\.)/.test(file) && file !== '.env.example');
check('BLOCKER', 'no tracked .env', leaked.length === 0, leaked.length ? `tracked: ${leaked.join(', ')}` : 'clean');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const changelog = existsSync(join(ROOT, 'CHANGELOG.md')) ? readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8') : '';
const versioned = changelog.includes(`[${pkg.version}]`);
check('WARN', 'CHANGELOG has version', versioned, versioned ? `[${pkg.version}] present` : `no entry for ${pkg.version}`);

const blockers = results.filter((result) => result.level === 'BLOCKER' && !result.ok);
console.log('\nProduction preflight');
console.log('----------------------------------------------------------------');
for (const result of results) {
  const status = result.ok ? 'PASS' : result.level === 'BLOCKER' ? 'FAIL' : 'WARN';
  console.log(`[${status}] [${result.level}] ${result.name}: ${result.detail}`);
}
if (blockers.length > 0) {
  console.error(`\n${blockers.length} blocker(s): NOT production-ready.`);
  process.exit(1);
}
console.log('\nNo blockers. Warnings, if any, are advisory.');
