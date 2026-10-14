#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isProd = (process.env.NODE_ENV || 'production') === 'production';
const results = [];
const record = (level, message) => results.push([level, message]);

const [major, minor, patch] = process.versions.node.split('.').map(Number);
const supportedNode = major > 26 || (major === 26 && (minor > 11 || (minor === 11 && patch >= 1)));
record(supportedNode ? 'ok' : 'fail',
  `Node ${process.versions.node}${supportedNode ? '' : ' (need Node 26.11.1 or newer)'}`);

for (const [key, placeholder] of [['JWT_SECRET', 'change-this-secret'], ['COOKIE_SECRET', 'change-this-cookie-secret']]) {
  const value = process.env[key] || '';
  const bad = !value || value === placeholder;
  record(bad ? (isProd ? 'fail' : 'warn') : 'ok', `${key} ${bad ? 'missing or insecure' : 'set'}${isProd ? ' (production)' : ''}`);
}

try {
  require('better-sqlite3');
  record('ok', 'better-sqlite3 native binding loads');
} catch {
  record('fail', 'better-sqlite3 native binding not built for Node (run: npm run rebuild:node)');
}

const dbPath = process.env.DATABASE_URL || 'laro.sqlite';
record(fs.existsSync(dbPath) ? 'ok' : 'warn', `Database ${fs.existsSync(dbPath) ? 'present' : 'not created yet'} (${dbPath})`);
record(fs.existsSync(path.resolve('drizzle', 'meta', '_journal.json')) ? 'ok' : 'warn', 'Migrations folder present');
record(process.env.FORGE_API_KEY ? 'ok' : 'warn', process.env.FORGE_API_KEY ? 'LLM provider configured' : 'No FORGE_API_KEY; provider-backed AI actions are unavailable');
record(process.env.AWS_S3_BUCKET ? 'ok' : 'warn', process.env.AWS_S3_BUCKET ? 'S3 storage configured' : 'S3 not configured; evidence uses local storage');
record(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'ok' : 'warn',
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET ? 'Google OAuth configured' : 'Google OAuth not configured; Gmail and Drive are disabled');

console.log(`\nLARO doctor: env=${process.env.NODE_ENV || 'production'}\n`);
for (const [level, message] of results) console.log(`  [${level.toUpperCase()}] ${message}`);
const failures = results.filter(([level]) => level === 'fail').length;
const warnings = results.filter(([level]) => level === 'warn').length;
console.log(`\n${results.length} checks: ${failures} failed, ${warnings} warnings.\n`);
process.exit(failures > 0 ? 1 : 0);
