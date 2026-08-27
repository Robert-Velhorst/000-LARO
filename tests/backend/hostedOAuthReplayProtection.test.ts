import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../../server/hostedRedis');
  process.env = { ...originalEnv };
});

describe('hosted OAuth replay protection', () => {
  it('accepts an OAuth state only once across hosted callback handlers', async () => {
    process.env.LARO_RUNTIME_MODE = 'hosted';
    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.LARO_HOSTED_ENCRYPTION_KEY = 'a'.repeat(64);

    const states = new Set<string>();
    vi.doMock('../../server/hostedRedis', () => ({
      getHostedRedisOAuthStateClient: async () => ({
        set: async (key: string) => {
          if (states.has(key)) return null;
          states.add(key);
          return 'OK';
        },
        eval: async (_script: string, options: { keys: string[] }) => {
          const [key] = options.keys;
          if (!states.has(key)) return 0;
          states.delete(key);
          return 1;
        },
      }),
    }));

    const { beginOAuthFlowAsync, consumeOAuthStateAsync, OAuthStateError } = await import('../../server/oauth2');
    const url = new URL(await beginOAuthFlowAsync('gmail', 'public-user'));
    const state = url.searchParams.get('state');

    await expect(consumeOAuthStateAsync(state!, 'gmail')).resolves.toMatchObject({ userId: 'public-user' });
    await expect(consumeOAuthStateAsync(state!, 'gmail')).rejects.toBeInstanceOf(OAuthStateError);
  });
});
