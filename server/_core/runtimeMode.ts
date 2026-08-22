export type RuntimeMode = 'local' | 'hosted';

export class RuntimeModeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeModeConfigError';
  }
}

export type RuntimeModeConfig = {
  mode: RuntimeMode;
  databaseUrl?: string;
  redisUrl?: string;
  objectStorage?: {
    bucket: string;
    accessKeyConfigured: boolean;
    secretKeyConfigured: boolean;
  };
};

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isRedisUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'redis:' || url.protocol === 'rediss:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function normalizedUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function resolveRuntimeMode(env: NodeJS.ProcessEnv = process.env): RuntimeMode {
  const value = (env.LARO_RUNTIME_MODE || 'local').trim().toLowerCase();
  if (value === 'local' || value === 'hosted') return value;
  throw new RuntimeModeConfigError('LARO_RUNTIME_MODE must be local or hosted.');
}

/**
 * Validates the dependencies that make public hosting safe across multiple API
 * processes. The function is pure so release tooling and tests can validate a
 * target environment before the application opens a database connection.
 */
export function assertRuntimeModeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeModeConfig {
  const mode = resolveRuntimeMode(env);
  if (mode === 'local') return { mode };

  const failures: string[] = [];
  const databaseUrl = (env.DATABASE_URL || '').trim();
  const redisUrl = (env.REDIS_URL || '').trim();
  const bucket = (env.AWS_S3_BUCKET || '').trim();
  const accessKey = (env.AWS_S3_ACCESS_KEY || '').trim();
  const secretKey = (env.AWS_S3_SECRET_KEY || '').trim();
  const encryptionKey = (env.LARO_HOSTED_ENCRYPTION_KEY || '').trim();
  const publicBaseUrl = (env.LARO_PUBLIC_BASE_URL || '').trim();
  const oauthRedirectBaseUrl = (env.OAUTH_REDIRECT_BASE_URL || '').trim();
  const allowedOrigins = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (env.SERVER_ONLY !== 'true') failures.push('Hosted mode requires SERVER_ONLY=true.');
  if (env.LARO_PUBLIC_DEPLOYMENT_REQUIRED !== 'true') {
    failures.push('Hosted mode requires LARO_PUBLIC_DEPLOYMENT_REQUIRED=true.');
  }
  if (!isPostgresUrl(databaseUrl)) failures.push('Hosted mode requires a PostgreSQL DATABASE_URL.');
  if (!isRedisUrl(redisUrl)) failures.push('Hosted mode requires a redis:// or rediss:// REDIS_URL.');
  if (!bucket) failures.push('Hosted mode requires AWS_S3_BUCKET for private evidence storage.');
  if (!accessKey) failures.push('Hosted mode requires AWS_S3_ACCESS_KEY for private evidence storage.');
  if (!secretKey) failures.push('Hosted mode requires AWS_S3_SECRET_KEY for private evidence storage.');
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey)) {
    failures.push('Hosted mode requires a 64-character hexadecimal LARO_HOSTED_ENCRYPTION_KEY.');
  }
  if (!isHttpsUrl(publicBaseUrl)) failures.push('Hosted mode requires an HTTPS LARO_PUBLIC_BASE_URL.');
  if (!isHttpsUrl(oauthRedirectBaseUrl)) failures.push('Hosted mode requires an HTTPS OAUTH_REDIRECT_BASE_URL.');
  if (isHttpsUrl(publicBaseUrl) && isHttpsUrl(oauthRedirectBaseUrl) && normalizedUrl(publicBaseUrl) !== normalizedUrl(oauthRedirectBaseUrl)) {
    failures.push('Hosted mode requires OAUTH_REDIRECT_BASE_URL to exactly match LARO_PUBLIC_BASE_URL.');
  }
  if (isHttpsUrl(publicBaseUrl) && !allowedOrigins.includes(new URL(publicBaseUrl).origin)) {
    failures.push('Hosted mode requires ALLOWED_ORIGINS to include the public origin.');
  }

  if (failures.length > 0) throw new RuntimeModeConfigError(failures.join('\n'));

  return {
    mode,
    databaseUrl,
    redisUrl,
    objectStorage: {
      bucket,
      accessKeyConfigured: true,
      secretKeyConfigured: true,
    },
  };
}
