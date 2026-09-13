import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

/** Only a deliberately configured server origin can receive desktop trust. */
export function normalizeDesktopServerUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use an HTTPS server address without a path, query, or credentials. HTTP is only allowed on loopback for local checks.');
  }
  return url.origin;
}

export function remoteScannerDatabaseName(serverUrl: string): string {
  const origin = normalizeDesktopServerUrl(serverUrl);
  return `laro-agent-${createHash('sha256').update(origin).digest('hex').slice(0, 24)}.db`;
}

export function resolveDesktopConnection(options: {
  userDataPath: string;
  argv: string[];
  serverUrl?: string;
}): string | null {
  const configPath = path.join(options.userDataPath, 'server-connection.json');
  const supplied = options.argv.filter((arg) => arg.startsWith('--server-url='));
  const local = options.argv.includes('--local');
  if (supplied.length > 1 || (local && supplied.length > 0)) {
    throw new Error('Choose one --server-url address or --local.');
  }
  if (local || supplied.length) {
    const serverUrl = local ? null : normalizeDesktopServerUrl(supplied[0].slice('--server-url='.length));
    writeFileSync(configPath, JSON.stringify({ serverUrl }, null, 2) + '\n', { mode: 0o600 });
    return serverUrl;
  }
  if (options.serverUrl) return normalizeDesktopServerUrl(options.serverUrl);
  if (!existsSync(configPath)) return null;
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { serverUrl?: unknown };
  if (config.serverUrl === null) return null;
  if (typeof config.serverUrl !== 'string') throw new Error('Invalid saved desktop server configuration. Launch with --server-url or --local to choose a connection.');
  return normalizeDesktopServerUrl(config.serverUrl);
}
