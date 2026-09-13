import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { createRequire } from 'node:module';
import { startGoogleCallbackBridge } from './local-google-callback.mjs';

const { values } = parseArgs({ options: { config: { type: 'string' } } });
if (!values.config) throw new Error('Usage: node scripts/start-local-workspace.mjs --config PRIVATE/workspace.json');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = realpathSync(values.config);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const resolveExisting = key => {
  if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Missing ${key} in workspace configuration`);
  return realpathSync(path.resolve(path.dirname(configPath), config[key]));
};
const database = resolveExisting('database');
const storage = resolveExisting('storage');
const environment = resolveExisting('environment');
if (!statSync(database).isFile() || !statSync(storage).isDirectory()) throw new Error('Existing database and source directory required');
const port = config.port;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const runtime = path.dirname(database);
const entry = path.join(root, 'dist/server/server/index.js');
if (!existsSync(entry) || !existsSync(path.join(root, 'dist/renderer/index.html'))) throw new Error('Build the renderer and server first');
for (const file of [path.join(runtime, '.env'), path.join(root, 'dist/.env')]) {
  if (existsSync(file)) throw new Error('Workspace refuses implicit dotenv configuration');
}
const secrets = dotenv.parse(readFileSync(environment));
for (const key of ['JWT_SECRET', 'COOKIE_SECRET']) {
  if (!secrets[key] || secrets[key].length < 32 || secrets[key].startsWith('change-this')) throw new Error(`Existing strong ${key} required; keys will not be regenerated`);
}
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', reject);
  probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
const db = new Database(database, { readonly: true, fileMustExist: true });
try {
  const integrity = db.pragma('quick_check', { simple: true });
  if (integrity !== 'ok') throw new Error('Database integrity check failed');
  if (!db.prepare('SELECT count(*) AS total FROM users').get().total) throw new Error('No existing account; this launcher never creates one');
  // Preserve a consistent recovery point before the server can apply migrations.
  const checkpoint = `${database}.before-local-${Date.now()}.sqlite`;
  await db.backup(checkpoint);
  console.log('Private database checkpoint created. Keep the existing encryption environment for recovery.');
} finally { db.close(); }

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
Object.assign(env, {
  NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), SERVER_ONLY: 'false',
  LARO_RUNTIME_MODE: 'local', DEMO_MODE: 'false', DATABASE_URL: database,
  LOCAL_STORAGE_DIR: storage, ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
  JWT_SECRET: secrets.JWT_SECRET, COOKIE_SECRET: secrets.COOKIE_SECRET,
  LARO_SESSION_COOKIE_NAME: `laro_local_${createHash('sha256').update(database.toLowerCase()).digest('hex').slice(0, 16)}`,
  LARO_WORKSPACE_KIND: 'local', LARO_BACKGROUND_JOBS: 'false',
  LARO_LOCAL_TEST_ACCESS: config.testAccess === true ? 'true' : 'false',
});
let callbackBridge = null;
if (config.googleConnections === true) {
  if (!process.env.APPDATA) throw new Error('Windows provider configuration location is unavailable');
  const require = createRequire(import.meta.url);
  const { loadProtectedProviderConfig } = require('../dist/main/src-main/providerConfig.js');
  const providerEnv = { ...env, OS: process.env.OS };
  loadProtectedProviderConfig({
    userDataPath: path.join(process.env.APPDATA, 'LARO Desktop'), isPackaged: false,
    resourcesPath: root, cwd: root, environment: providerEnv,
  });
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_BASE_URL']) {
    if (!providerEnv[key]) throw new Error('Saved Google configuration is incomplete');
    env[key] = providerEnv[key];
  }
  callbackBridge = await startGoogleCallbackBridge(env.OAUTH_REDIRECT_BASE_URL, port);
}
// Other provider credentials and unattended jobs remain disabled.
const child = spawn(process.execPath, [entry], { cwd: runtime, env, stdio: 'inherit', windowsHide: true });
child.on('error', () => { callbackBridge?.close(); console.error('Could not start local workspace'); process.exitCode = 1; });
child.on('exit', code => { callbackBridge?.close(); process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill());
process.on('SIGTERM', () => child.kill());
console.log(`Local dossier workspace: http://127.0.0.1:${port}/ (use your existing LARO password)`);
console.log(config.googleConnections === true
  ? 'Saved Google configuration loaded. Background jobs and outbound email remain disabled. No external endpoint changed.'
  : 'Background jobs are disabled. No provider credentials are loaded. No external endpoint is changed.');
