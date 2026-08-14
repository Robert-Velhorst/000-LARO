import { MAX_BOOTSTRAP_TOKEN_LENGTH } from "../signupPolicy";
import { resolveOutboundEmailConfiguration } from "../emailConfig";

/**
 * Environment configuration
 * Single source of truth for all env vars with safe defaults
 */
export class ConfigError extends Error {}

export const DEFAULT_AUDIT_RETENTION_DAYS = 365;
export const MIN_AUDIT_RETENTION_DAYS = 30;
export const MAX_AUDIT_RETENTION_DAYS = 3650;

export function parseAuditRetentionDays(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_AUDIT_RETENTION_DAYS;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_AUDIT_RETENTION_DAYS ||
    parsed > MAX_AUDIT_RETENTION_DAYS
  ) {
    throw new ConfigError(
      `AUDIT_RETENTION_DAYS must be a whole number between ${MIN_AUDIT_RETENTION_DAYS} and ${MAX_AUDIT_RETENTION_DAYS}.`
    );
  }
  return parsed;
}

export const ENV = {
  // Server
  PORT:             parseInt(process.env.PORT || '3000', 10),
  HOST:             process.env.HOST || '127.0.0.1',
  API_BODY_LIMIT:   process.env.API_BODY_LIMIT || '10mb',
  SERVER_ONLY:      process.env.SERVER_ONLY === 'true',
  STANDALONE_SIGNUP_TOKEN: process.env.STANDALONE_SIGNUP_TOKEN || '',
  NODE_ENV:         process.env.NODE_ENV || 'production',

  // Database
  DATABASE_URL:     process.env.DATABASE_URL || '',
  AUDIT_RETENTION_DAYS: parseAuditRetentionDays(process.env.AUDIT_RETENTION_DAYS),

  // Auth / Manus OAuth
  MANUS_API_URL:    process.env.MANUS_API_URL || 'https://api.manus.im',
  JWT_SECRET:       process.env.JWT_SECRET || 'change-this-secret',
  COOKIE_SECRET:    process.env.COOKIE_SECRET || 'change-this-cookie-secret',
  OWNER_ID:         process.env.OWNER_ID || '',

  // AI providers
  OPENAI_API_KEY:       process.env.OPENAI_API_KEY || '',
  ANTHROPIC_API_KEY:    process.env.ANTHROPIC_API_KEY || '',
  GOOGLE_GEMINI_API_KEY: process.env.GOOGLE_GEMINI_API_KEY || '',
  DEEPSEEK_API_KEY:     process.env.DEEPSEEK_API_KEY || '',
  GROQ_API_KEY:         process.env.GROQ_API_KEY || '',
  TOGETHER_API_KEY:     process.env.TOGETHER_API_KEY || '',

  // OAuth integrations
  GOOGLE_CLIENT_ID:       process.env.GOOGLE_CLIENT_ID || '',
  GOOGLE_CLIENT_SECRET:   process.env.GOOGLE_CLIENT_SECRET || '',
  MICROSOFT_CLIENT_ID:    process.env.MICROSOFT_CLIENT_ID || '',
  MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET || '',
  SLACK_CLIENT_ID:        process.env.SLACK_CLIENT_ID || '',
  SLACK_CLIENT_SECRET:    process.env.SLACK_CLIENT_SECRET || '',
  TRELLO_API_KEY:         process.env.TRELLO_API_KEY || '',
  TELEGRAM_BOT_TOKEN:     process.env.TELEGRAM_BOT_TOKEN || '',

  // Email
  SENDGRID_API_KEY:   process.env.SENDGRID_API_KEY || '',
  AWS_SES_ACCESS_KEY: process.env.AWS_SES_ACCESS_KEY || '',
  AWS_SES_SECRET_KEY: process.env.AWS_SES_SECRET_KEY || '',
  AWS_SES_REGION:     process.env.AWS_SES_REGION || 'eu-west-1',

  // Storage (S3)
  AWS_S3_BUCKET:          process.env.AWS_S3_BUCKET || '',
  AWS_S3_ACCESS_KEY:      process.env.AWS_S3_ACCESS_KEY || '',
  AWS_S3_SECRET_KEY:      process.env.AWS_S3_SECRET_KEY || '',
  AWS_S3_REGION:          process.env.AWS_S3_REGION || 'eu-west-1',

  // Frontend
  FRONTEND_URL: process.env.VITE_FRONTEND_URL || 'http://localhost:3000',

  // Forge (custom LLM endpoint)
  forgeApiUrl: process.env.FORGE_API_URL || '',
  forgeApiKey: process.env.FORGE_API_KEY || '',

  // Phase 037 — explicit demo mode. Never on in production.
  DEMO_MODE: process.env.DEMO_MODE === 'true',

  get ownerId() { return this.OWNER_ID; },
  get isDev()   { return this.NODE_ENV === 'development'; },
  get isProd()  { return this.NODE_ENV === 'production'; },
  get isDemo()  { return this.DEMO_MODE && !this.isProd; },
};

/**
 * Phase 006 — configuration validation and startup guards.
 *
 * Insecure placeholder values that must never be used to sign real sessions.
 * In a packaged desktop build the Electron main process generates per-install
 * random secrets before the server is imported (see src-main/index.ts), so
 * production normally never hits these. This guard is the fail-safe: if we are
 * in production and the secrets are still the shipped placeholders (or empty),
 * we refuse to start rather than silently signing forgeable tokens.
 */
export const INSECURE_JWT_DEFAULT = 'change-this-secret';
export const INSECURE_COOKIE_DEFAULT = 'change-this-cookie-secret';

const SUPPORTED_REQUIRED_LIVE_PROVIDERS = new Set(['google', 'outboundEmail']);

function requiredLiveProviders(): { providers: Set<string>; unknown: string[] } {
  const values = (process.env.LARO_REQUIRED_LIVE_PROVIDERS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return {
    providers: new Set(values.filter((value) => SUPPORTED_REQUIRED_LIVE_PROVIDERS.has(value))),
    unknown: values.filter((value) => !SUPPORTED_REQUIRED_LIVE_PROVIDERS.has(value)),
  };
}

function normalizeConfiguredUrl(value: string | undefined): URL | null {
  try {
    const url = new URL((value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    url.pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return url;
  } catch {
    return null;
  }
}

/**
 * Throws in production when security-critical secrets are missing or still set
 * to the insecure placeholder. Returns a list of non-fatal warnings (e.g.
 * unconfigured optional integrations) for the caller to log.
 */
export function assertSecurityConfig(): string[] {
  const warnings: string[] = [];
  const jwtInsecure = !ENV.JWT_SECRET || ENV.JWT_SECRET === INSECURE_JWT_DEFAULT;
  const cookieInsecure = !ENV.COOKIE_SECRET || ENV.COOKIE_SECRET === INSECURE_COOKIE_DEFAULT;

  if (ENV.isProd) {
    const failures: string[] = [];
    const requiredProviders = requiredLiveProviders();
    if (jwtInsecure) failures.push('JWT_SECRET is missing or set to the insecure default');
    if (cookieInsecure) failures.push('COOKIE_SECRET is missing or set to the insecure default');
    if (
      ENV.SERVER_ONLY &&
      ENV.STANDALONE_SIGNUP_TOKEN &&
      ENV.STANDALONE_SIGNUP_TOKEN.trim().length < 32
    ) {
      failures.push('STANDALONE_SIGNUP_TOKEN must contain at least 32 characters when configured');
    }
    if (
      ENV.SERVER_ONLY &&
      ENV.STANDALONE_SIGNUP_TOKEN.trim().length > MAX_BOOTSTRAP_TOKEN_LENGTH
    ) {
      failures.push(`STANDALONE_SIGNUP_TOKEN must contain at most ${MAX_BOOTSTRAP_TOKEN_LENGTH} characters`);
    }
    if (requiredProviders.unknown.length > 0) {
      failures.push(`LARO_REQUIRED_LIVE_PROVIDERS contains unsupported values: ${requiredProviders.unknown.join(', ')}`);
    }
    if (
      requiredProviders.providers.has('google') &&
      (!ENV.GOOGLE_CLIENT_ID || !ENV.GOOGLE_CLIENT_SECRET)
    ) {
      failures.push('Google is required for this deployment but GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET were not loaded');
    }
    if (
      requiredProviders.providers.has('outboundEmail') &&
      !resolveOutboundEmailConfiguration().configured
    ) {
      failures.push('Outbound email is required for this deployment but no complete SMTP or SendGrid configuration was loaded');
    }
    if (process.env.LARO_PUBLIC_DEPLOYMENT_REQUIRED === 'true') {
      const publicBaseUrl = normalizeConfiguredUrl(process.env.LARO_PUBLIC_BASE_URL);
      const oauthBaseUrl = normalizeConfiguredUrl(process.env.OAUTH_REDIRECT_BASE_URL);
      const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const expectedPrefix = publicBaseUrl?.pathname || '';
      const configuredPrefix = (process.env.PUBLIC_PATH_PREFIX || '').replace(/\/+$/, '');
      if (!ENV.SERVER_ONLY) failures.push('Public deployment contract requires SERVER_ONLY=true');
      if (!publicBaseUrl) failures.push('LARO_PUBLIC_BASE_URL must be a plain HTTPS URL for the public deployment');
      if (!oauthBaseUrl || oauthBaseUrl?.toString() !== publicBaseUrl?.toString()) {
        failures.push('OAUTH_REDIRECT_BASE_URL must exactly match LARO_PUBLIC_BASE_URL for the public deployment');
      }
      if (publicBaseUrl && !allowedOrigins.includes(publicBaseUrl.origin)) {
        failures.push('ALLOWED_ORIGINS must include the exact public deployment origin');
      }
      if (publicBaseUrl && configuredPrefix !== expectedPrefix) {
        failures.push('PUBLIC_PATH_PREFIX must match the path in LARO_PUBLIC_BASE_URL');
      }
    }
    if (failures.length > 0) {
      throw new ConfigError(
        `[config] Refusing to start in production with an invalid runtime contract:\n` +
          failures.map((f) => `  - ${f}`).join('\n') +
          `\nResolve every listed configuration failure before restarting. The desktop build ` +
          `generates local signing secrets automatically; public deployments must use the protected launcher.`
      );
    }
  } else {
    if (jwtInsecure) warnings.push('JWT_SECRET is using an insecure development default — do NOT use in production.');
    if (cookieInsecure) warnings.push('COOKIE_SECRET is using an insecure development default — do NOT use in production.');
  }

  // Truthful startup summary of optional integrations (Phase 006 / Phase 004
  // "dev/demo/test must be visibly labelled"): report what is NOT configured so
  // operators are not surprised when a provider-dependent feature is inert.
  if (!ENV.OPENAI_API_KEY && !ENV.ANTHROPIC_API_KEY && !ENV.forgeApiKey &&
      !ENV.GOOGLE_GEMINI_API_KEY && !ENV.DEEPSEEK_API_KEY && !ENV.GROQ_API_KEY &&
      !ENV.TOGETHER_API_KEY) {
    warnings.push('No Forge LLM key set — provider-backed AI analysis is unavailable.');
  }
  if (!ENV.AWS_S3_BUCKET) {
    warnings.push(`AWS_S3_BUCKET not set — evidence files use local storage at ${process.env.LOCAL_STORAGE_DIR || '<cwd>/laro-uploads'}.`);
  }
  if (!ENV.GOOGLE_CLIENT_ID && !ENV.GOOGLE_CLIENT_SECRET) {
    warnings.push('Google OAuth not configured — Gmail/Drive evidence collection is disabled.');
  }
  return warnings;
}
