import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolated developer preview only. Never loads the owner's runtime or providers.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { ensureDesktopSecrets } = require('../dist/main/src-main/desktopSecrets.js');
const runtime = path.resolve(root, '.cache', 'product-preview');
const entry = path.join(root, 'dist', 'server', 'server', 'index.js');
if (!existsSync(entry)) throw new Error('Build the server first: npm run build:server');
for (const file of [path.join(runtime, '.env'), path.join(root, 'dist', '.env')]) {
  if (existsSync(file)) throw new Error(`Preview refuses dotenv configuration at ${file}`);
}
for (const port of [3022, 5183]) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
mkdirSync(runtime, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'].includes(key.toUpperCase())));
Object.assign(env, {
  NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3022', SERVER_ONLY: 'false',
  LARO_RUNTIME_MODE: 'local', DEMO_MODE: 'false', DATABASE_URL: path.join(runtime, 'preview.sqlite'),
  LOCAL_STORAGE_DIR: path.join(runtime, 'sources'), ALLOWED_ORIGINS: 'http://127.0.0.1:5183',
  LARO_SESSION_COOKIE_NAME: 'laro_product_preview_session', LARO_WORKSPACE_KIND: 'preview',
  LARO_BACKGROUND_JOBS: 'false',
  VITE_LARO_IGNORE_DOTENV: 'true', VITE_LARO_API_URL: 'http://127.0.0.1:3022',
});
ensureDesktopSecrets(runtime, env);
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  process.exitCode = code;
}
for (const [args, cwd] of [
  [[entry], runtime],
  [[path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', '5183', '--strictPort'], root],
]) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
console.log('Isolated DEVELOPMENT preview (not the owner workspace): http://127.0.0.1:5183/');
console.log('No Google account, paid AI provider or production data is connected.');
