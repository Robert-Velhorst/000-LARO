// Run with Node 22 after the renderer and server builds. Only disposable data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { verifySourceProgress } from './sourceProgressFlow.mjs';
import { verifySourceChecks } from './sourceCheckFlow.mjs';
import { verifyGoogleAccounts } from './googleAccountsFlow.mjs';
import { verifyTimelineEvents } from './timelineEventsFlow.mjs';

const require = createRequire(import.meta.url);
const { ensureDesktopSecrets } = require('../../dist/main/src-main/desktopSecrets.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = mkdtempSync(path.join(os.tmpdir(), 'laro-workspace-access-'));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
const servers = [];
async function start(workspace) {
  const env = { ...baseEnv, NODE_ENV: 'production', SERVER_ONLY: 'false', HOST: '127.0.0.1', PORT: String(workspace.port),
    DATABASE_URL: path.join(workspace.dir, 'test.sqlite'), LOCAL_STORAGE_DIR: path.join(workspace.dir, 'sources'),
    LARO_RUNTIME_MODE: 'local', LARO_BACKGROUND_JOBS: 'false', LARO_WORKSPACE_KIND: workspace.kind,
    LARO_SESSION_COOKIE_NAME: workspace.cookie, ALLOWED_ORIGINS: workspace.url,
    LARO_LOCAL_TEST_ACCESS: workspace.kind === 'local' ? 'true' : 'false' };
  ensureDesktopSecrets(workspace.dir, env);
  const child = spawn(process.execPath, [path.join(root, 'dist/server/server/index.js')], { cwd: workspace.dir, env, stdio: 'pipe', windowsHide: true });
  let output = '';
  const capture = chunk => { output = (output + chunk.toString()).slice(-5000); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  child.on('error', () => {});
  servers.push(child);
  for (let i = 0; i < 480; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited before readiness: ${output}`);
    try { if ((await fetch(`${workspace.url}/api/ready`)).ok) return child; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Test server readiness timed out: ${output}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit');
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
  child.kill();
  try { await exit; } finally { clearTimeout(deadline); }
  assert.equal(timedOut, false, 'Server failed to stop within 15 seconds with a live browser connection');
}
async function workspace(kind) {
  const dir = path.join(runtime, kind); mkdirSync(dir);
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  return { dir, port, url: `http://127.0.0.1:${port}`, kind, cookie: `laro_${kind}_session` };
}
const browser = await chromium.launch({ headless: true });
try {
  const a = await workspace('local'), b = await workspace('preview');
  let childA = await start(a); await start(b);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const offlineAuth = route => route.abort('connectionrefused');
  await page.route('**/api/trpc/auth.me*', offlineAuth);
  await page.goto(a.url);
  await page.getByRole('heading', { name: 'LARO is temporarily unavailable' }).waitFor();
  await page.unroute('**/api/trpc/auth.me*', offlineAuth);
  // No reload or retry click: the stopped-server state must recover itself.
  await page.getByRole('button', { name: "Don't have an account? Sign up" }).click();
  await page.getByLabel('Full Name').fill('Access regression');
  await page.getByLabel('Email Address').fill('access@example.test');
  await page.getByLabel('Password', { exact: true }).fill(randomBytes(18).toString('hex'));
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
  await page.getByRole('button', { name: 'Open account menu' }).waitFor();
  const me = async w => (await (await context.request.get(`${w.url}/api/trpc/auth.me`)).json()).result.data.json;
  assert.equal((await me(a)).email, 'access@example.test');
  const ownerId = (await me(a)).id;
  const secret = JSON.parse(readFileSync(path.join(a.dir, 'laro-secrets.json'), 'utf8')).jwtSecret;
  const localTicket = jwt.sign({ purpose: 'local-test-access' }, secret, {
    subject: ownerId, jwtid: randomBytes(32).toString('hex'), issuer: 'laro-local-operator', audience: 'laro-local-test', expiresIn: '5m',
  });
  const testContext = await browser.newContext();
  const testPage = await testContext.newPage();
  await testPage.goto(`${a.url}/#local-test=${localTicket}`);
  await testPage.getByRole('button', { name: 'Continue without password' }).waitFor();
  await testPage.reload();
  await testPage.getByRole('button', { name: 'Continue without password' }).click();
  await testPage.getByRole('button', { name: 'Open account menu' }).waitFor();
  assert.equal(new URL(testPage.url()).hash, '');
  const testMe = (await (await testContext.request.get(`${a.url}/api/trpc/auth.me`)).json()).result.data.json;
  assert.equal(testMe.id, ownerId);
  const replay = await testContext.request.post(`${a.url}/api/trpc/auth.localTestAccess`, {
    headers: { Origin: a.url }, data: { json: { ticket: localTicket } },
  });
  assert.equal(replay.status(), 403);
  const testDb = new Database(path.join(a.dir, 'test.sqlite'), { readonly: true });
  assert.equal(testDb.prepare('SELECT count(*) AS total FROM audit_logs WHERE action = ?').get('auth.local_test_access').total, 1);
  testDb.close();
  await testContext.close();
  const second = await context.request.post(`${b.url}/api/trpc/auth.signup`, {
    headers: { Origin: b.url }, data: { json: { name: 'Preview regression', email: 'preview@example.test', password: randomBytes(18).toString('hex') } },
  });
  assert.equal(second.status(), 200);
  assert.equal((await me(a)).email, 'access@example.test');
  assert.equal((await me(b)).email, 'preview@example.test');
  assert.ok((await context.cookies()).some(cookie => cookie.name === a.cookie));
  assert.ok((await context.cookies()).some(cookie => cookie.name === b.cookie));
  await stop(childA); childA = await start(a);
  await page.reload();
  await page.getByRole('button', { name: 'Open account menu' }).waitFor();
  assert.equal((await me(a)).email, 'access@example.test');
  await context.request.post(`${b.url}/api/trpc/auth.logout`, { headers: { Origin: b.url }, data: { json: null } });
  assert.equal(await me(b), null);
  assert.equal((await me(a)).email, 'access@example.test');
  const health = await (await fetch(`${a.url}/api/health`)).json();
  assert.ok(health.workers.length > 0);
  assert.ok(health.workers.every(job => !job.enabled && job.runs === 0));
  const signedOut = await browser.newContext();
  assert.equal((await (await signedOut.request.get(`${a.url}/api/trpc/auth.me`)).json()).result.data.json, null);
  assert.equal((await signedOut.request.get(`${a.url}/api/trpc/cases.list`)).status(), 401);
  await page.screenshot({ path: path.join(runtime, 'after-restart.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  // The account control is inside the closed mobile sidebar, not visible here.
  await page.getByRole('heading', { level: 1 }).waitFor();
  assert.equal((await me(a)).email, 'access@example.test');
  await page.screenshot({ path: path.join(runtime, 'mobile.png') });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  console.log('PASS workspace access, session isolation, and live-browser restart');
  if (process.argv.includes('--source-progress')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await verifySourceProgress(page, path.join(a.dir, 'test.sqlite'), ownerId, a.url, runtime);
    assert.deepEqual(errors, []);
    console.log('PASS source progress browser flow');
  }
  if (process.argv.includes('--source-checks')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await verifySourceChecks(page, path.join(a.dir, 'test.sqlite'), ownerId, a.url, runtime);
    assert.deepEqual(errors, []);
    console.log('PASS source recheck browser flow');
  }
  if (process.argv.includes('--google-accounts')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await verifyGoogleAccounts(page, path.join(a.dir, 'test.sqlite'), ownerId, a.url, runtime);
    assert.deepEqual(errors, []);
    console.log('PASS Google account browser flow with provider test doubles');
  }
  if (process.argv.includes('--timeline')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await verifyTimelineEvents(page, path.join(a.dir, 'test.sqlite'), ownerId, a.url, runtime);
    assert.deepEqual(errors, []);
    console.log('PASS timeline correction browser flow');
  }
  console.log('PASS: one-time local test access without password, replay blocked, audit recorded, offline API recovery, real signup UI, isolated sessions, restart retains login, anonymous access denied, disabled workers, mobile fits, no page errors.');
  console.log(`Screenshots and disposable test database: ${runtime}`);
} finally {
  await browser.close();
  const cleanup = await Promise.allSettled(servers.map(stop));
  for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
}
