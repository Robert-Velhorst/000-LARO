import { existsSync } from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const ALLOWED_PROVIDER_ENVIRONMENT = new Set([
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'OAUTH_REDIRECT_BASE_URL',
  'EMAIL_PROVIDER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_STARTTLS',
]);

type ProviderEnvironment = Record<string, string>;
type SpawnResult = {
  status: number | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  error?: Error;
};

export interface ProtectedProviderConfigOptions {
  userDataPath: string;
  isPackaged: boolean;
  resourcesPath: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  spawn?: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => SpawnResult;
}

export interface ProtectedProviderConfigResult {
  loaded: boolean;
  configPath?: string;
  appliedKeys: string[];
}

function configuredPath(options: ProtectedProviderConfigOptions): string | undefined {
  const explicit = options.environment?.LARO_PROVIDER_CONFIG_PATH?.trim();
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (!existsSync(resolved)) {
      throw new Error('LARO_PROVIDER_CONFIG_PATH does not point to an existing file');
    }
    return resolved;
  }

  const candidates = [
    path.join(options.userDataPath, 'provider-config.json'),
    path.join(options.cwd || process.cwd(), '.laro-provider-config.json'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function validateProviderEnvironment(value: unknown): ProviderEnvironment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Protected provider configuration returned an invalid payload');
  }
  const result: ProviderEnvironment = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!ALLOWED_PROVIDER_ENVIRONMENT.has(key) || typeof rawValue !== 'string') {
      throw new Error('Protected provider configuration returned an unsupported field');
    }
    if (!rawValue || rawValue.length > 4_096 || /[\r\n\0]/.test(rawValue)) {
      throw new Error(`Protected provider configuration returned an invalid ${key} value`);
    }
    result[key] = rawValue;
  }
  if (result.EMAIL_PROVIDER && result.EMAIL_PROVIDER !== 'smtp') {
    throw new Error('Protected provider configuration returned an unsupported email provider');
  }
  if (result.OAUTH_REDIRECT_BASE_URL) {
    const redirect = new URL(result.OAUTH_REDIRECT_BASE_URL);
    if (
      redirect.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname.toLowerCase()) ||
      !redirect.port ||
      redirect.pathname !== '/' ||
      redirect.search ||
      redirect.hash ||
      redirect.username ||
      redirect.password
    ) {
      throw new Error('Protected provider configuration returned an invalid OAuth redirect origin');
    }
  }
  if (result.SMTP_PORT && !/^(?:[1-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/.test(result.SMTP_PORT)) {
    throw new Error('Protected provider configuration returned an invalid SMTP port');
  }
  return result;
}

export function loadProtectedProviderConfig(
  options: ProtectedProviderConfigOptions,
): ProtectedProviderConfigResult {
  if ((options.platform || process.platform) !== 'win32') {
    return { loaded: false, appliedKeys: [] };
  }
  const configPath = configuredPath(options);
  if (!configPath) return { loaded: false, appliedKeys: [] };

  const scriptPath = options.isPackaged
    ? path.join(options.resourcesPath, 'scripts', 'read-protected-provider-config.ps1')
    : path.join(options.cwd || process.cwd(), 'scripts', 'read-protected-provider-config.ps1');
  if (!existsSync(scriptPath)) {
    throw new Error('The protected provider configuration reader is missing');
  }

  const run = options.spawn || ((command, args, spawnOptions) =>
    spawnSync(command, args, spawnOptions as Parameters<typeof spawnSync>[2]) as SpawnResult);
  const result = run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-ConfigPath',
    configPath,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024,
    env: options.environment || process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Windows could not decrypt the protected provider configuration');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(String(result.stdout || '{}'));
  } catch {
    throw new Error('Protected provider configuration returned malformed JSON');
  }
  const providerEnvironment = validateProviderEnvironment(parsed);
  const target = options.environment || process.env;
  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(providerEnvironment)) {
    if (target[key]?.trim()) continue;
    target[key] = value;
    appliedKeys.push(key);
  }
  return { loaded: true, configPath, appliedKeys };
}
