#!/usr/bin/env node
// Windows-only rendered smoke check of the packaged app, using disposable data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
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
let application;
let page;
let appLog = '';
const checked = name => { report.checks.push(name); console.log(`PASS ${name}`); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch() {
  application = await electron.launch({
    executablePath: executable,
    args: [`--user-data-dir=${profile}`, '--local', '--disable-gpu'],
    cwd: temporary,
    env,
    timeout: 120_000,
  });
  child = application.process();
  child.stdout.on('data', chunk => { appLog += chunk; });
  child.stderr.on('data', chunk => { appLog += chunk; });
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  page = await application.firstWindow({ timeout: 90_000 });
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

async function stop({ force = false } = {}) {
  if (child?.pid && child.exitCode === null) {
    if (force) {
      // Only this test's process tree is stopped, never other LARO profiles.
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      // Playwright's Electron close calls app.quit() through the test-only main
      // inspector and waits for exit. This exercises the real shutdown handler,
      // including cookie persistence, without depending on a visible OS window.
      let closeTimer;
      try {
        await Promise.race([
          application.close(),
          new Promise((_, reject) => {
            closeTimer = setTimeout(() => reject(new Error('Normal packaged shutdown exceeded 30 seconds')), 30_000);
          }),
        ]);
      } finally {
        clearTimeout(closeTimer);
      }
    }
    const deadline = Date.now() + 30_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await pause(100);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned packaged process did not stop');
    if (!force) assert.equal(child.exitCode, 0, 'Normal packaged shutdown failed');
  }
  application = undefined;
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
  checked('normal Windows close and restart preserves account, session, evidence, and encryption keys');
  // Also crash the restarted process. The established session has already been
  // persisted by the normal close; committed evidence must survive either exit.
  await stop({ force: true });
  origin = await launch();
  await page.getByRole('button', { name: 'Open account menu' }).waitFor();
  assert.equal((await rpc('auth.me')).email, 'windows-verification@example.test');
  assert.equal((await rpc('evidenceFiles.get', { id: uploaded.id })).contentHash, uploaded.sha256);
  const recovered = await rpc('documentInbox.download', { id: item.id }, true);
  assert.deepEqual(Buffer.from(recovered.base64, 'base64'), content);
  assert.equal(createHash('sha256').update(readFileSync(path.join(profile, 'laro-secrets.json'))).digest('hex'), secretHash);
  await page.goto(origin + '/evidence');
  await page.getByRole('heading', { name: 'windows-inbox.txt', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'windows-restarted.png') });
  checked('forced-crash recovery preserves committed evidence, persisted session, and encryption keys');
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
  try { await stop({ force: true }); } catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(output, 'packaged-app.log'), appLog);
}
