#!/usr/bin/env node
// Exercise the production build against disposable data, without provider keys
// or requests to a live deployment. Run after npm run build and rebuild:node.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, _electron as electron } from 'playwright';
import superjson from 'superjson';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(path.join(tmpdir(), 'laro-shared-verify-'));
const output = path.join(root, 'out', 'shared-verification');
mkdirSync(output, { recursive: true });
const probe = createServer();
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const dockerImage = process.argv.find((argument) => argument.startsWith('--image='))?.slice('--image='.length);
const setupCode = randomBytes(32).toString('hex');
const password = randomBytes(20).toString('hex');
const environment = {
  PATH: process.env.PATH,
  NODE_ENV: 'production', HOST: dockerImage ? '0.0.0.0' : '127.0.0.1', PORT: String(port),
  SERVER_ONLY: 'true', LARO_SERVE_WEB: 'true', LARO_RUNTIME_MODE: 'local',
  JWT_SECRET: randomBytes(32).toString('hex'), COOKIE_SECRET: randomBytes(32).toString('hex'),
  STANDALONE_SIGNUP_TOKEN: setupCode,
  DATABASE_URL: path.join(temporary, 'laro.sqlite'),
  LOCAL_STORAGE_DIR: path.join(temporary, 'uploads'),
  LARO_BACKUP_DIRECTORY: path.join(temporary, 'backups'),
  ALLOWED_ORIGINS: origin, OAUTH_REDIRECT_BASE_URL: origin,
};
let server;
let browser;
let desktop;
let serverLog = '';
const report = { origin, runtime: dockerImage || 'compiled Node build', databaseDirectory: temporary, checks: [], consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] };
const checked = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };

async function start() {
  // A disposable working directory prevents loading an operator's root .env.
  server = dockerImage
    ? spawn('docker', [
      'run', '--rm', '--init', '--name', path.basename(temporary),
      '-p', `127.0.0.1:${port}:${port}`,
      '--mount', `type=bind,src=${temporary},dst=${temporary}`,
      ...Object.keys(environment).filter((key) => key !== 'PATH').flatMap((key) => ['--env', key]),
      dockerImage,
    ], { cwd: temporary, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, [path.join(root, 'dist/server/server/index.js')], { cwd: temporary, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}: ${serverLog.slice(-4000)}`);
    try {
      const response = await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Server did not become ready: ${serverLog.slice(-4000)}`);
}

async function stop() {
  if (!server || server.exitCode !== null) return;
  const stopped = new Promise((resolve) => server.once('exit', resolve));
  server.kill('SIGTERM');
  const timer = setTimeout(() => server?.kill('SIGKILL'), 15_000);
  await stopped;
  clearTimeout(timer);
}

function watch(page) {
  page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    if (!request.failure()?.errorText.includes('ERR_ABORTED')) report.failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText}`);
  });
  page.on('response', (response) => { if (response.status() >= 400) report.badResponses.push(`${response.status()} ${response.url()}`); });
}

async function rpc(page, procedure, input, mutation = false) {
  const serialized = superjson.serialize(input);
  const payload = await page.evaluate(async ({ procedure, serialized, mutation }) => {
    const response = await fetch(`/api/trpc/${procedure}${mutation ? '' : `?input=${encodeURIComponent(JSON.stringify(serialized))}`}`, {
      method: mutation ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(mutation ? { body: JSON.stringify(serialized) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }, { procedure, serialized, mutation });
  assert.equal(payload.status, 200, `${procedure}: ${JSON.stringify(payload.data)}`);
  assert.ok(payload.data.result, `${procedure}: ${JSON.stringify(payload.data)}`);
  return superjson.deserialize(payload.data.result.data);
}

async function login(page, navigate = true) {
  if (navigate) await page.goto(origin);
  await page.getByLabel('Email Address').fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByRole('button', { name: 'Open account menu' }).waitFor();
}

async function checkDesktop(caseId, evidenceId, contentHash) {
  // An isolated copy of dist/main + node_modules with an Electron SQLite binding
  // lets the server retain its Node binding. No installed desktop profile is used.
  const stage = process.env.LARO_ELECTRON_STAGE;
  if (!stage) return;
  const profile = path.join(temporary, 'desktop-profile');
  mkdirSync(profile);
  const entry = path.join(temporary, 'desktop-test-entry.cjs');
  writeFileSync(entry, `const { app } = require('electron');\napp.setPath('userData', ${JSON.stringify(profile)});\nrequire(${JSON.stringify(path.join(stage, 'dist/main/src-main/index.js'))});\n`);
  const launch = async (first) => {
    desktop = await electron.launch({
      executablePath: path.join(root, 'node_modules/electron/dist/electron'),
      args: ['--no-sandbox', entry, ...(first ? [`--server-url=${origin}`] : [])],
      cwd: temporary,
      env: { PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, NODE_ENV: 'production' },
      timeout: 90_000,
    });
    const page = await desktop.firstWindow({ timeout: 90_000 });
    watch(page);
    // The main process is already calling loadURL. Navigating again before it
    // finishes cancels that request and opens the app's network-error dialog.
    await page.waitForURL(origin + '/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    return page;
  };
  let page = await launch(true);
  await login(page, false);
  assert.equal(await page.evaluate(async () => (await window.electronAPI.getConfig()).apiUrl), origin);
  assert.equal(await page.evaluate(async () => (await window.electronAPI.getConfig()).localSourcesAvailable), false);
  assert.equal((await rpc(page, 'evidenceFiles.get', { id: evidenceId })).contentHash, contentHash);
  assert.equal(existsSync(path.join(profile, 'laro-server.sqlite')), false);
  assert.equal(existsSync(path.join(profile, 'laro-secrets.json')), false);
  checked('real Electron client signs in to the shared backend without a second case database');

  await page.goto(origin + '/evidence');
  await page.getByRole('button', { name: 'Add source', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Select local source', exact: true }).count(), 0);
  await page.getByText('To copy a folder from this computer, use Folder in the Document inbox below.', { exact: false }).waitFor();
  checked('connected desktop offers folder uploads without exposing server-local path intake');

  const folder = path.join(temporary, 'selected-desktop-documents');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'desktop-notice.txt'), 'A harmless desktop upload for shared-server verification.');
  // Automate only the OS folder selection; the real IPC, scan, review, uploader,
  // cookie authorization, HTTP endpoint, and persistent database remain in use.
  await desktop.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, folder);
  const scan = await page.evaluate(async ({ caseId }) => {
    const folders = await window.electronAPI.selectFolder();
    return window.electronAPI.startScan({ caseId, caseName: 'Verification case', folders, excludedFolders: [], autoUpload: false });
  }, { caseId });
  await page.waitForFunction(async (scanId) => (await window.electronAPI.getScanFiles(scanId)).files.length === 1, scan.scanId);
  const files = await page.evaluate(async (scanId) => (await window.electronAPI.getScanFiles(scanId)).files, scan.scanId);
  await page.evaluate(async ({ scanId, id }) => {
    await window.electronAPI.setScanFileSelection(scanId, [id]);
    await window.electronAPI.startUpload(scanId);
  }, { scanId: scan.scanId, id: files[0].id });
  await page.waitForFunction(async (scanId) => (await window.electronAPI.getScanFiles(scanId)).files[0]?.uploadStatus === 'completed', scan.scanId, { timeout: 60_000 });
  await page.goto(origin + '/evidence?view=items');
  await page.getByText('desktop-notice.txt', { exact: true }).first().waitFor();
  await page.screenshot({ path: path.join(output, 'electron-shared-evidence.png') });
  checked('native selected-folder scan and reviewed upload reach the shared evidence store');
  await desktop.close(); desktop = undefined;
  assert.equal(JSON.parse(readFileSync(path.join(profile, 'server-connection.json'), 'utf8')).serverUrl, origin);
  page = await launch(false);
  await page.getByRole('button', { name: 'Open account menu' }).waitFor();
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal((await rpc(page, 'evidenceFiles.get', { id: evidenceId })).contentHash, contentHash);
  checked('Electron restart remembers the server and signed-in shared account');
  await rpc(page, 'auth.logout', undefined, true);
  const denied = await page.evaluate(async (scanId) => {
    try { await window.electronAPI.startUpload(scanId); return false; }
    catch (error) { return String(error).includes('Sign in'); }
  }, scan.scanId);
  assert.equal(denied, true);
  checked('desktop logout removes native upload authorization');
  await desktop.close(); desktop = undefined;
}

try {
  await start();
  checked('production server and database readiness');
  browser = await chromium.launch({ channel: process.env.LARO_BROWSER_CHANNEL || 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  watch(page);
  const navigation = await page.goto(origin);
  assert.equal(navigation.status(), 200);
  await page.getByRole('button', { name: "Don't have an account? Sign up" }).click();
  await page.getByLabel('Setup code', { exact: true }).fill(setupCode);
  await page.getByLabel('Full Name').fill('Shared Server Verification');
  await page.getByLabel('Email Address').fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
  await page.getByRole('button', { name: 'Open account menu' }).waitFor();
  assert.deepEqual(await rpc(page, 'auth.enrollment'), { open: false, requiresSetupCode: true });
  checked('browser owner setup and enrollment closure');

  const created = await rpc(page, 'cases.create', {
    clientName: 'Shared verification case', clientEmail: 'owner@example.test',
    caseType: 'Employment', urgency: 'Medium',
    caseSummary: 'My employer ended my employment on 12 September 2026. I need to organize the written notice and review the dates in my employment contract.',
  }, true);
  const content = Buffer.from('Employment notice\nOn 12 September 2026 the employer delivered a written notice. The employee requests review of the employment contract.\n');
  const uploaded = await rpc(page, 'evidenceFiles.upload', {
    caseId: created.id, title: 'verification-notice.txt', type: 'document',
    fileName: 'verification-notice.txt', mimeType: 'text/plain', source: 'manual',
    base64: content.toString('base64'),
  }, true);
  assert.equal(uploaded.sha256, createHash('sha256').update(content).digest('hex'));
  checked('authenticated case creation and evidence byte integrity');

  await rpc(page, 'documentAnalysis.analyzeEvidence', { evidenceId: uploaded.id }, true);
  checked('local analysis of stored evidence');
  const exported = await rpc(page, 'evidenceExport.exportZIP', { caseId: created.id }, true);
  const zip = await context.request.get(origin + exported.url);
  assert.equal(zip.status(), 200);
  assert.equal((await zip.body()).subarray(0, 2).toString(), 'PK');
  checked('owner-authorized ZIP download over HTTP');

  for (const route of ['/', '/cases', '/evidence', '/settings']) {
    const response = await page.goto(origin + route);
    assert.equal(response.status(), 200);
    await page.getByRole('heading', { level: 1 }).waitFor();
  }
  await page.goto(origin + '/cases');
  await page.getByRole('button', { name: 'Shared verification case', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'browser-cases.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.screenshot({ path: path.join(output, 'browser-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page overflows horizontally');
  checked('rendered desktop/mobile pages and deep-route reloads');

  await rpc(page, 'userPreferences.updateWorkflow', { autoAnalyzeImports: false }, true);
  await page.goto(origin + '/evidence');
  await page.getByLabel('Upload documents', { exact: true }).setInputFiles({
    name: 'inbox-browser-upload.txt', mimeType: 'text/plain', buffer: content,
  });
  await page.getByRole('heading', { name: 'inbox-browser-upload.txt', exact: true }).waitFor();
  const inbox = await rpc(page, 'documentInbox.list', { view: 'all', offset: 0, limit: 20 });
  const inboxDocument = inbox.items.find((item) => item.fileName === 'inbox-browser-upload.txt');
  assert.ok(inboxDocument, 'Uploaded inbox document was not persisted');
  const original = await rpc(page, 'documentInbox.download', { id: inboxDocument.id }, true);
  assert.equal(Buffer.from(original.base64, 'base64').toString(), content.toString());
  checked('real browser file selection persists inbox originals without a preselected case');

  const secondContext = await browser.newContext({ locale: 'en-US' });
  let secondPage = await secondContext.newPage();
  watch(secondPage);
  await login(secondPage);
  const sameEvidence = await rpc(secondPage, 'evidenceFiles.get', { id: uploaded.id });
  assert.equal(sameEvidence.contentHash, uploaded.sha256);
  checked('independent client session sees the same case evidence');
  await checkDesktop(created.id, uploaded.id, uploaded.sha256);

  const anonymous = await browser.newContext();
  const forbidden = await anonymous.request.get(`${origin}/api/trpc/evidenceFiles.get?input=${encodeURIComponent(JSON.stringify(superjson.serialize({ id: uploaded.id })))}`);
  assert.equal(forbidden.status(), 401);
  assert.equal((await anonymous.request.get(origin + '/api/missing')).status(), 404);
  assert.equal((await anonymous.request.get(origin + '/assets/missing.js')).status(), 404);
  const csrf = await context.request.post(`${origin}/api/trpc/auth.logout`, { headers: { Origin: 'https://untrusted.example.test' }, data: superjson.serialize(undefined) });
  assert.equal(csrf.status(), 403);
  await anonymous.close();
  checked('unauthorized access, CSRF rejection, and unknown-route 404s');

  await page.close();
  await secondPage.close();
  await stop();
  await start();
  secondPage = await secondContext.newPage();
  watch(secondPage);
  await secondPage.goto(origin + '/cases');
  await secondPage.getByRole('button', { name: 'Shared verification case', exact: true }).waitFor();
  const persisted = await rpc(secondPage, 'evidenceFiles.get', { id: uploaded.id });
  assert.equal(persisted.contentHash, uploaded.sha256);
  checked('account, session, case, and evidence survive server restart');
  assert.deepEqual(report.pageErrors, [], 'Browser runtime errors');
  assert.deepEqual(report.consoleErrors, [], 'Browser console errors');
  assert.deepEqual(report.failedRequests, [], 'Browser network failures');
  assert.deepEqual(report.badResponses, [], 'Unexpected HTTP errors');
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  const lastPage = desktop?.windows().at(-1) || browser?.contexts().flatMap((context) => context.pages()).at(-1);
  if (lastPage && !lastPage.isClosed()) {
    report.lastPage = lastPage.url();
    try { await lastPage.screenshot({ path: path.join(output, 'failure.png'), timeout: 5000 }); } catch { /* Preserve the original failure. */ }
  }
  console.error(report.error);
  process.exitCode = 1;
} finally {
  await desktop?.close();
  await browser?.close();
  await stop();
  writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(path.join(output, 'server.log'), serverLog);
  console.log(`Verification report: ${path.join(output, 'result.json')}`);
}
