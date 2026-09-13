#!/usr/bin/env node
// Windows-only rendered smoke check of the packaged app, using disposable data.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import superjson from 'superjson';

assert.equal(process.platform, 'win32', 'Run this check on the Windows build runner');
const argument = process.argv.find(value => value.startsWith('--app='));
assert.ok(argument, 'Supply --app=<packaged Windows executable>');
const executable = path.resolve(argument.slice(6));
assert.ok(existsSync(executable), 'Packaged executable is missing');
const temporary = mkdtempSync(path.join(tmpdir(), 'laro-packaged-windows-'));
const profile = path.join(temporary, 'profile');
const output = path.resolve('out/windows-verification');
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA)$/i.test(key)));
Object.assign(env, { NODE_ENV: 'production', LARO_BACKGROUND_JOBS: 'false', LARO_LOCAL_TEST_ACCESS: 'false' });
const report = { passed: false, checks: [], pageErrors: [], consoleErrors: [], failedRequests: [], badResponses: [] };
let child;
let browser;
let page;
let appLog = '';
const checked = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch() {
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const debugPort = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  child = spawn(executable, [`--user-data-dir=${profile}`, '--local', '--disable-gpu', `--remote-debugging-port=${debugPort}`],
    { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.on('data', chunk => { appLog += chunk; });
  child.stderr.on('data', chunk => { appLog += chunk; });
  let launchError;
  child.on('error', error => { launchError = error; });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (launchError) throw launchError;
    if (child.exitCode !== null) throw new Error(`Packaged app exited ${child.exitCode}: ${appLog.slice(-5000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
        break;
      }
    } catch { /* The packaged main process is still starting. */ }
    await pause(300);
  }
  assert.ok(browser, 'Packaged app did not expose its test-only debugging endpoint');
  const context = browser.contexts()[0];
  page = context.pages()[0] || await context.waitForEvent('page', { timeout: 90_000 });
  page.on('pageerror', error => report.pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('requestfailed', request => {
    if (!request.failure()?.errorText.includes('ERR_ABORTED')) report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText });
  });
  page.on('response', response => { if (response.status() >= 400) report.badResponses.push({ url: response.url(), status: response.status() }); });
  page.setDefaultTimeout(30_000);
  await page.waitForURL(url => url.protocol === 'http:' && url.hostname === '127.0.0.1', { timeout: 120_000 });
  await page.waitForLoadState('domcontentloaded');
  assert.ok(existsSync(path.join(profile, 'laro-server.sqlite')), 'App did not use the disposable profile');
  return new URL(page.url()).origin;
}

async function stop() {
  if (browser) { await browser.close(); browser = undefined; }
  if (child?.pid && child.exitCode === null) {
    // Only this test's process tree is stopped. Restart below checks crash recovery.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    const deadline = Date.now() + 15_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(100);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned packaged process did not stop');
  }
}

async function rpc(procedure, input, mutation = false) {
  const serialized = superjson.serialize(input);
  const payload = await page.evaluate(async ({ procedure, serialized, mutation }) => {
    const response = await fetch(`/api/trpc/${procedure}${mutation ? '' : `?input=${encodeURIComponent(JSON.stringify(serialized))}`}`, {
      method: mutation ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      ...(mutation ? { body: JSON.stringify(serialized) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }, { procedure, serialized, mutation });
  assert.equal(payload.status, 200, `${procedure}: ${JSON.stringify(payload.body)}`);
  return superjson.deserialize(payload.body.result.data);
}

try {
  let origin = await launch();
  const navigation = await page.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(navigation.status(), 200);
  assert.equal((await page.request.get(origin + '/api/ready')).status(), 200);
  await page.getByRole('button', { name: "Don't have an account? Sign up" }).click();
  await page.getByLabel('Full Name').fill('Packaged Windows Verification');
  await page.getByLabel('Email Address').fill('windows-verification@example.test');
  await page.getByLabel('Password', { exact: true }).fill(randomBytes(20).toString('hex'));
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
  await page.getByRole('button', { name: 'Open account menu' }).waitFor();
  assert.equal((await rpc('auth.me')).email, 'windows-verification@example.test');
  checked('packaged Windows renderer, backend readiness, and real signup');

  const created = await rpc('cases.create', {
    clientName: 'Windows packaged verification', clientEmail: 'windows-verification@example.test', caseType: 'Employment', urgency: 'Medium',
    caseSummary: 'My employer ended my employment on 12 September 2026. I need to organize the written notice and review the dates in my employment contract.',
  }, true);
  await page.goto(origin + '/cases');
  await page.getByRole('button', { name: 'Windows packaged verification', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'windows-cases.png') });
  checked('case creation and packaged case screen');

  const content = Buffer.from('Employment notice\nOn 12 September 2026 the employer delivered written notice.\n');
  const uploaded = await rpc('evidenceFiles.upload', {
    caseId: created.id, title: 'windows-notice.txt', type: 'document', fileName: 'windows-notice.txt', mimeType: 'text/plain', source: 'manual', base64: content.toString('base64'),
  }, true);
  assert.equal(uploaded.sha256, createHash('sha256').update(content).digest('hex'));
  await rpc('documentAnalysis.analyzeEvidence', { evidenceId: uploaded.id }, true);
  const exported = await rpc('evidenceExport.exportZIP', { caseId: created.id }, true);
  const download = await page.request.get(origin + exported.url);
  assert.equal(download.status(), 200);
  assert.equal((await download.body()).subarray(0, 2).toString(), 'PK');
  checked('packaged SQLite writes, evidence integrity, local analysis, and ZIP export');

  await rpc('userPreferences.updateWorkflow', { autoAnalyzeImports: false }, true);
  await page.goto(origin + '/evidence');
  await page.getByLabel('Upload documents', { exact: true }).setInputFiles({ name: 'windows-inbox.txt', mimeType: 'text/plain', buffer: content });
  await page.getByRole('heading', { name: 'windows-inbox.txt', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'windows-inbox.png') });
  const inbox = await rpc('documentInbox.list', { view: 'all', offset: 0, limit: 20 });
  const item = inbox.items.find(value => value.fileName === 'windows-inbox.txt');
  assert.ok(item);
  const original = await rpc('documentInbox.download', { id: item.id }, true);
  assert.deepEqual(Buffer.from(original.base64, 'base64'), content);
  checked('real file input and inbox original-byte download');

  const config = await page.evaluate(() => window.electronAPI.getConfig());
  assert.equal(config.apiUrl, origin);
  assert.equal(config.localSourcesAvailable, true);
  checked('packaged preload and trusted desktop IPC');
  const secretHash = createHash('sha256').update(readFileSync(path.join(profile, 'laro-secrets.json'))).digest('hex');
  await stop();
  origin = await launch();
  await page.getByRole('button', { name: 'Open account menu' }).waitFor();
  assert.equal((await rpc('auth.me')).email, 'windows-verification@example.test');
  assert.equal((await rpc('evidenceFiles.get', { id: uploaded.id })).contentHash, uploaded.sha256);
  assert.equal(createHash('sha256').update(readFileSync(path.join(profile, 'laro-secrets.json'))).digest('hex'), secretHash);
  checked('packaged restart preserves account, session, evidence, and encryption keys');
  await rpc('auth.logout', undefined, true);
  assert.equal((await page.request.get(origin + '/api/trpc/cases.list')).status(), 401);
  checked('logout denies authenticated case access');
  assert.deepEqual(report.pageErrors, []);
  assert.deepEqual(report.consoleErrors, []);
  assert.deepEqual(report.failedRequests, []);
  assert.deepEqual(report.badResponses, []);
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.stack : String(error);
  if (page && !page.isClosed()) {
    try { await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }); } catch { /* Keep the original error. */ }
  }
  console.error(report.error);
  process.exitCode = 1;
} finally {
  try { await stop(); } catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(output, 'packaged-app.log'), appLog);
}
