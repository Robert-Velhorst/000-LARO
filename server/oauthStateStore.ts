const MAX_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const MAX_OAUTH_STATE_LENGTH = 2_048;

export interface RedisOAuthStateClient {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export class OAuthStateStoreUnavailableError extends Error {
  constructor() {
    super('Shared OAuth state storage is unavailable.');
    this.name = 'OAuthStateStoreUnavailableError';
  }
}

const CONSUME_STATE_SCRIPT = `
if redis.call('GET', KEYS[1]) then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

function stateKey(state: string): string {
  if (!state || state.length > MAX_OAUTH_STATE_LENGTH) throw new OAuthStateStoreUnavailableError();
  return `laro:oauth-state:${state}`;
}

/**
 * Hosted OAuth replay protection. The encrypted OAuth payload remains in the
 * provider state parameter, while Redis holds a bounded opaque marker that can
 * be consumed only once across every API replica.
 */
export function createRedisOAuthStateStore(client: RedisOAuthStateClient): {
  record(state: string, ttlMs: number): Promise<void>;
  consume(state: string): Promise<boolean>;
} {
  return {
    async record(state: string, ttlMs: number): Promise<void> {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_OAUTH_STATE_TTL_MS) {
        throw new OAuthStateStoreUnavailableError();
      }
      try {
        const outcome = await client.set(stateKey(state), '1', { NX: true, PX: ttlMs });
        if (outcome !== 'OK') throw new OAuthStateStoreUnavailableError();
      } catch (error) {
        if (error instanceof OAuthStateStoreUnavailableError) throw error;
        throw new OAuthStateStoreUnavailableError();
      }
    },

    async consume(state: string): Promise<boolean> {
      try {
        const outcome = Number(await client.eval(CONSUME_STATE_SCRIPT, {
          keys: [stateKey(state)],
          arguments: [],
        }));
        if (outcome !== 0 && outcome !== 1) throw new OAuthStateStoreUnavailableError();
        return outcome === 1;
      } catch (error) {
        if (error instanceof OAuthStateStoreUnavailableError) throw error;
        throw new OAuthStateStoreUnavailableError();
      }
    },
  };
}
