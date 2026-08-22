import { describe, expect, it } from 'vitest';
import {
  RuntimeModeConfigError,
  assertRuntimeModeConfig,
  resolveRuntimeMode,
} from '../../server/_core/runtimeMode';

function hostedEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    LARO_RUNTIME_MODE: 'hosted',
    SERVER_ONLY: 'true',
    LARO_PUBLIC_DEPLOYMENT_REQUIRED: 'true',
    LARO_PUBLIC_BASE_URL: 'https://app.example.test',
    OAUTH_REDIRECT_BASE_URL: 'https://app.example.test',
    ALLOWED_ORIGINS: 'https://app.example.test',
    DATABASE_URL: 'postgresql://laro:secret@postgres.example.test:5432/laro',
    REDIS_URL: 'rediss://redis.example.test:6379/0',
    AWS_S3_BUCKET: 'laro-evidence',
    AWS_S3_ACCESS_KEY: 'access-key',
    AWS_S3_SECRET_KEY: 'secret-key',
    LARO_HOSTED_ENCRYPTION_KEY: 'a'.repeat(64),
    ...overrides,
  };
}

describe('hosted runtime mode', () => {
  it('keeps local mode as the default', () => {
    expect(resolveRuntimeMode({})).toBe('local');
    expect(assertRuntimeModeConfig({}).mode).toBe('local');
  });

  it('rejects an unknown runtime mode', () => {
    expect(() => resolveRuntimeMode({ LARO_RUNTIME_MODE: 'anything' })).toThrow(RuntimeModeConfigError);
  });

  it('fails closed when a hosted deployment has no shared rate-limit store', () => {
    expect(() => assertRuntimeModeConfig(hostedEnvironment({ REDIS_URL: '' }))).toThrow(/REDIS_URL/);
  });

  it('fails closed when a hosted deployment has no private object storage contract', () => {
    expect(() => assertRuntimeModeConfig(hostedEnvironment({ AWS_S3_BUCKET: '' }))).toThrow(/AWS_S3_BUCKET/);
  });

  it('rejects a SQLite database for hosted mode', () => {
    expect(() => assertRuntimeModeConfig(hostedEnvironment({ DATABASE_URL: '/data/laro.sqlite' }))).toThrow(/PostgreSQL/);
  });

  it('accepts a complete hosted public deployment contract', () => {
    expect(assertRuntimeModeConfig(hostedEnvironment())).toEqual({
      mode: 'hosted',
      databaseUrl: 'postgresql://laro:secret@postgres.example.test:5432/laro',
      redisUrl: 'rediss://redis.example.test:6379/0',
      objectStorage: {
        bucket: 'laro-evidence',
        accessKeyConfigured: true,
        secretKeyConfigured: true,
      },
    });
  });
});
