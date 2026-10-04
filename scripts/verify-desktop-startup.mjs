#!/usr/bin/env node
// Launch the delivered executable normally, with disposable clean/legacy data.
// Unlike the deeper unpacked smoke, this exercises the portable EXE launcher.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.resolve(process.argv.find(value => value.startsWith('--app='))?.slice(6) || 'missing');
const sourceMode = process.argv.includes('--source');
assert.ok(sourceMode || process.platform === 'win32', 'Portable verification requires Windows; --source is a local development check only');
assert.ok(existsSync(executable), 'Supply --app=<desktop executable>');
const temporary = mkdtempSync(path.join(tmpdir(), 'laro-startup-'));
const output = path.join(root, 'out', 'windows-verification', sourceMode ? 'source-startup' : 'portable-startup');
mkdirSync(output, { recursive: true });
const report = { passed: false, sourceMode, scenarios: [] };
const startupTimeout = 240_000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function seedInstalledProfile(profile, password) {
  mkdirSync(profile, { recursive: true });
  const db = new Database(path.join(profile, 'laro-server.sqlite'));
  try {
    // Journal and additive compatibility columns of the shipped 4334b38 build.
    const migrations = readMigrationFiles({ migrationsFolder: path.join(root, 'drizzle') }).slice(0, 19);
    db.transaction(() => {
      db.exec('CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)');
      for (const migration of migrations) {
        for (const statement of migration.sql) if (statement.trim()) db.exec(statement);
        db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis);
      }
      db.exec('ALTER TABLE users ADD COLUMN resetCodeHash text; ALTER TABLE users ADD COLUMN resetCodeExpiresAt text;');
      db.prepare('INSERT INTO users (id, name, email, password, role, loginMethod, stripeCustomerId) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run('upgrade-owner', 'Existing Desktop Owner', 'upgrade@example.test', bcrypt.hashSync(password, 4), 'user', 'email', 'cus_archived');
      db.exec(`
        INSERT INTO cases (id, userId, clientName) VALUES ('upgrade-case', 'upgrade-owner', 'Existing desktop case');
        INSERT INTO evidence (id, caseId, userId, type, title)
          VALUES ('upgrade-evidence', 'upgrade-case', 'upgrade-owner', 'document', 'Existing desktop evidence');
        INSERT INTO billing_periods (id, userId, totalCost) VALUES ('upgrade-billing', 'upgrade-owner', '12.50');
        CREATE TRIGGER laro_ri_billing_periods_userId_delete BEFORE DELETE ON users BEGIN
          DELETE FROM billing_periods WHERE userId = OLD.id;
        END;
        CREATE TRIGGER laro_ri_usage_limits_userId_delete BEFORE DELETE ON users BEGIN
          DELETE FROM usage_limits WHERE userId = OLD.id;
        END;
      `);
    })();
  } finally {
    db.close();
  }
  writeFileSync(path.join(profile, 'laro-secrets.json'), JSON.stringify({
    jwtSecret: randomBytes(32).toString('hex'), cookieSecret: randomBytes(32).toString('hex'),
  }), { mode: 0o600 });
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

for (const scenario of ['clean', 'upgrade']) {
  const result = { scenario, passed: false, pageErrors: [], consoleErrors: [], failedRequests: [], badResponses: [] };
  report.scenarios.push(result);
  const profile = path.join(temporary, scenario);
  const password = randomBytes(24).toString('hex');
  if (scenario === 'upgrade') seedInstalledProfile(profile, password);
  const secretsPath = path.join(profile, 'laro-secrets.json');
  const initialSecrets = scenario === 'upgrade' ? createHash('sha256').update(readFileSync(secretsPath)).digest('hex') : null;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|USERPROFILE|APPDATA|LOCALAPPDATA|DISPLAY|XAUTHORITY|HOME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i.test(key)));
  Object.assign(env, { NODE_ENV: 'production', LARO_LOCAL_TEST_ACCESS: 'false' });
  // Leave background jobs enabled, matching an ordinary desktop launch.
  const port = await freePort();
  const args = [...(sourceMode ? [root] : []), `--user-data-dir=${profile}`, '--local', '--disable-gpu', `--remote-debugging-port=${port}`];
  let child;
  let browser;
  let page;
  let appLog = '';
  try {
    child = spawn(executable, args, { cwd: temporary, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { appLog += chunk; });
    child.stderr.on('data', chunk => { appLog += chunk; });
    let launchError;
    child.on('error', error => { launchError = error; });
    const deadline = Date.now() + startupTimeout;
    let rendererReady = false;
    const debuggerOrigin = `http://127.0.0.1:${port}`;
    console.log(`Checking ${scenario} ${sourceMode ? 'source' : 'portable'} launch and renderer readiness`);
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      try {
        // Electron exposes its browser debugger before the first BrowserWindow
        // is initialized. Attaching Playwright in that interval can stall its
        // target initialization on Windows. Observe the real renderer and
        // backend first; this does not relaunch the app or skip UI assertions.
        const response = await fetch(`${debuggerOrigin}/json/list`, { signal: AbortSignal.timeout(1500) });
        if (response.ok) {
          const targets = await response.json();
          const renderer = targets.find(target => {
            // A URL can be advertised while its initial empty document still
            // exists. The application title confirms that index.html committed.
            if (target.type !== 'page' || target.title !== 'LARO | Legal Evidence Workspace') return false;
            try {
              const url = new URL(target.url);
              return url.protocol === 'http:' && url.hostname === '127.0.0.1';
            } catch { return false; }
          });
          if (renderer) {
            const readiness = await fetch(new URL('/api/ready', renderer.url), { signal: AbortSignal.timeout(1500) });
            if (readiness.ok) { rendererReady = true; break; }
          }
        }
      } catch { /* The portable launcher must finish extracting first. */ }
      await pause(250);
    }
    assert.ok(rendererReady, 'Desktop did not expose a local renderer with a ready backend');
    console.log(`PASS ${scenario} desktop renderer target and backend readiness before browser attachment`);
    browser = await chromium.connectOverCDP(debuggerOrigin, { timeout: startupTimeout });
    const context = browser.contexts()[0];
    page = context.pages()[0] || await context.waitForEvent('page', { timeout: startupTimeout });
    page.on('pageerror', error => result.pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
    page.on('requestfailed', request => {
      if (!request.failure()?.errorText.includes('ERR_ABORTED')) result.failedRequests.push(request.url());
    });
    page.on('response', response => { if (response.status() >= 400) result.badResponses.push({ url: response.url(), status: response.status() }); });
    page.setDefaultTimeout(30_000);
    await page.waitForURL(url => url.protocol === 'http:' && url.hostname === '127.0.0.1', { timeout: startupTimeout });
    const response = await page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(response.status(), 200);
    assert.equal((await page.request.get(new URL('/api/ready', page.url()).href)).status(), 200);
    await page.getByLabel('Email Address').waitFor();
    if (scenario === 'upgrade') {
      await page.getByLabel('Email Address').fill('upgrade@example.test');
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      const onboarding = page.getByRole('dialog', { name: 'Set up your LARO workspace' });
      await onboarding.waitFor();
      await onboarding.getByRole('button', { name: 'Skip setup', exact: true }).click();
      await onboarding.waitFor({ state: 'hidden' });
      await page.goto(new URL('/cases', page.url()).href);
      await page.getByRole('button', { name: 'Existing desktop case', exact: true }).waitFor();
      assert.equal(createHash('sha256').update(readFileSync(secretsPath)).digest('hex'), initialSecrets);
      assert.ok(readdirSync(path.join(profile, 'db-backups')).some(name => name.includes('.pre-migration-')));
      const db = new Database(path.join(profile, 'laro-server.sqlite'), { readonly: true });
      try {
        assert.equal(db.prepare("SELECT title FROM evidence WHERE id = 'upgrade-evidence'").get().title, 'Existing desktop evidence');
        assert.equal(JSON.parse(db.prepare("SELECT payload FROM legacy_billing_archive WHERE sourceId = 'upgrade-billing'").get().payload).totalCost, '12.50');
        assert.deepEqual(db.pragma('foreign_key_check'), []);
      } finally { db.close(); }
    }
    await page.screenshot({ path: path.join(output, `${scenario}.png`) });
    for (const key of ['pageErrors', 'consoleErrors', 'failedRequests', 'badResponses']) assert.deepEqual(result[key], []);
    result.passed = true;
    console.log(`PASS ${sourceMode ? 'source' : 'portable EXE'} ${scenario} startup, rendered page, HTTP readiness${scenario === 'upgrade' ? ', existing login/data/keys and recovery backup' : ''}`);
  } catch (error) {
    result.error = error instanceof Error ? error.stack : String(error);
    console.error(result.error);
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: path.join(output, `${scenario}-failure.png`), timeout: 5000 }); } catch { /* Preserve the startup error. */ }
    }
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    if (process.platform === 'win32') {
      // Stop only processes carrying this test's unique disposable profile.
      spawnSync('powershell.exe', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "LARO Desktop.exe" -and $_.CommandLine -and $_.CommandLine.Contains($env:LARO_STARTUP_TEST_PROFILE) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }'],
      { env: { ...process.env, LARO_STARTUP_TEST_PROFILE: profile }, windowsHide: true });
      if (child?.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else if (child?.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), pause(10_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    const logPath = path.join(profile, 'logs', 'main.log');
    if (existsSync(logPath)) appLog += '\n' + readFileSync(logPath, 'utf8');
    writeFileSync(path.join(output, `${scenario}.log`), appLog);
    report.passed = report.scenarios.length === 2 && report.scenarios.every(value => value.passed);
    writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  }
}
