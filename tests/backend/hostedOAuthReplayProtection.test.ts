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

    const states = new Map<string, string>();
    vi.doMock('../../server/hostedRedis', () => ({
      getHostedRedisOAuthStateClient: async () => ({
        set: async (key: string, value: string) => {
          if (states.has(key)) return null;
          states.set(key, value);
          return 'OK';
        },
        eval: async (script: string, options: { keys: string[]; arguments: string[] }) => {
          const [key] = options.keys;
          const raw = states.get(key);
          if (!raw) return '';
          const flow = JSON.parse(raw);
          if (script.includes("flow.status ~= 'pending'")) {
            const [startTicketHash, bindingHash, provider, flowId, now, sessionHash, loopbackRequest] = options.arguments;
            if (flow.status !== 'pending' || flow.startTicketHash !== startTicketHash ||
                flow.provider !== provider || flow.flowId !== flowId || flow.expiresAt <= Number(now) ||
                (flow.initiatingSessionHash !== sessionHash && !(flow.allowLoopbackHandoff && loopbackRequest === 'true'))) return '';
            const started = JSON.stringify({ ...flow, status: 'started', bindingHash });
            states.set(key, started);
            return started;
          }
          const [bindingHash, provider, flowId, now] = options.arguments;
          if (flow.status !== 'started' || flow.bindingHash !== bindingHash ||
              flow.provider !== provider || flow.flowId !== flowId || flow.expiresAt <= Number(now)) return '';
          states.delete(key);
          return raw;
        },
      }),
    }));

    const {
      activateOAuthStateAsync,
      beginOAuthFlowAsync,
      consumeOAuthStateAsync,
      OAuthStateError,
    } = await import('../../server/oauth2');
    const startUrl = new URL(await beginOAuthFlowAsync('gmail', 'public-user', 'initiating-session-cookie'));
    const state = startUrl.searchParams.get('state');
    const ticket = startUrl.searchParams.get('ticket');
    expect(startUrl.pathname).toBe('/api/oauth/gmail/start');
    await expect(activateOAuthStateAsync(
      state!, 'gmail', ticket!, 'different-session-cookie', false,
    )).rejects.toBeInstanceOf(OAuthStateError);
    const activated = await activateOAuthStateAsync(
      state!, 'gmail', ticket!, 'initiating-session-cookie', false,
    );
    expect(new URL(activated.authorizationUrl).hostname).toBe('accounts.google.com');

    await expect(consumeOAuthStateAsync(state!, 'gmail', 'x'.repeat(43))).rejects.toBeInstanceOf(OAuthStateError);
    await expect(consumeOAuthStateAsync(state!, 'gmail', activated.bindingSecret)).resolves.toMatchObject({ userId: 'public-user' });
    await expect(consumeOAuthStateAsync(state!, 'gmail', activated.bindingSecret)).rejects.toBeInstanceOf(OAuthStateError);
  });
});
