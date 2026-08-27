import { describe, expect, it, vi } from 'vitest';

const hostedEnvironment = {
  LARO_RUNTIME_MODE: 'hosted',
  JWT_SECRET: 'j'.repeat(48),
  COOKIE_SECRET: 'c'.repeat(48),
};

async function loadCrypto(hostedKey: string) {
  process.env = {
    ...process.env,
    ...hostedEnvironment,
    LARO_HOSTED_ENCRYPTION_KEY: hostedKey,
  };
  vi.resetModules();
  return import('../../server/crypto');
}

describe('hosted token encryption', () => {
  it('uses the dedicated hosted encryption key instead of the session signing secret', async () => {
    const originalEnvironment = process.env;
    try {
      const first = await loadCrypto('a'.repeat(64));
      const encrypted = first.encryptSecret('hosted-provider-refresh-token');
      expect(first.decryptSecret(encrypted)).toBe('hosted-provider-refresh-token');

      const second = await loadCrypto('b'.repeat(64));
      expect(second.decryptSecret(encrypted, { logFailure: false })).toBe('');
    } finally {
      process.env = originalEnvironment;
      vi.resetModules();
    }
  });
});
