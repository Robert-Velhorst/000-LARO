import { describe, expect, it, vi } from 'vitest';
import {
  OAuthStateStoreUnavailableError,
  createRedisOAuthStateStore,
} from '../../server/oauthStateStore';

describe('Redis OAuth state store', () => {
  it('records a state marker with a bounded one-time TTL', async () => {
    const set = vi.fn(async () => 'OK');
    const store = createRedisOAuthStateStore({ set, eval: vi.fn() });

    await expect(store.record('oauth-state-token', 600_000)).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledWith('laro:oauth-state:oauth-state-token', '1', { NX: true, PX: 600_000 });
  });

  it('consumes a state marker exactly once through an atomic script', async () => {
    const evalScript = vi.fn(async () => 1);
    const store = createRedisOAuthStateStore({ set: vi.fn(), eval: evalScript });

    await expect(store.consume('oauth-state-token')).resolves.toBe(true);
    expect(evalScript).toHaveBeenCalledWith(expect.any(String), {
      keys: ['laro:oauth-state:oauth-state-token'],
      arguments: [],
    });
  });

  it('reports replay or expiry without treating it as a valid state', async () => {
    const store = createRedisOAuthStateStore({ set: vi.fn(), eval: vi.fn(async () => 0) });

    await expect(store.consume('oauth-state-token')).resolves.toBe(false);
  });

  it('fails closed when Redis cannot record or consume state', async () => {
    const store = createRedisOAuthStateStore({
      set: vi.fn(async () => { throw new Error('connection refused'); }),
      eval: vi.fn(async () => { throw new Error('connection refused'); }),
    });

    await expect(store.record('oauth-state-token', 600_000)).rejects.toThrow(OAuthStateStoreUnavailableError);
    await expect(store.consume('oauth-state-token')).rejects.toThrow(OAuthStateStoreUnavailableError);
  });
});
