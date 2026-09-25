import { describe, expect, it, vi } from 'vitest';
import {
  OAuthStateStoreUnavailableError,
  createRedisOAuthStateStore,
  type StoredOAuthFlow,
} from '../../server/oauthStateStore';

const flow: StoredOAuthFlow = {
  flowId: 'flow-id-with-enough-entropy',
  userId: 'user-1',
  provider: 'gmail',
  initiatingSessionHash: 'c'.repeat(64),
  allowLoopbackHandoff: false,
  startTicketHash: 'a'.repeat(64),
  bindingHash: null,
  status: 'pending',
  expiresAt: Date.now() + 600_000,
};

describe('Redis OAuth flow store', () => {
  it('records a bounded flow without putting the state or proof in its key/value metadata', async () => {
    const set = vi.fn(async () => 'OK');
    const store = createRedisOAuthStateStore({ set, eval: vi.fn() });

    await expect(store.record('oauth-state-token', flow, 600_000)).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(/^laro:oauth-flow:[0-9a-f]{64}$/),
      JSON.stringify(flow),
      { NX: true, PX: 600_000 },
    );
    expect(set.mock.calls[0][0]).not.toContain('oauth-state-token');
  });

  it('atomically activates and then consumes a browser-bound flow', async () => {
    const started = { ...flow, status: 'started' as const, bindingHash: 'b'.repeat(64) };
    const evalScript = vi.fn()
      .mockResolvedValueOnce(JSON.stringify(started))
      .mockResolvedValueOnce(JSON.stringify(started));
    const store = createRedisOAuthStateStore({ set: vi.fn(), eval: evalScript });

    await expect(store.activate('oauth-state-token', {
      startTicketHash: flow.startTicketHash,
      bindingHash: started.bindingHash,
      provider: 'gmail',
      flowId: flow.flowId,
      now: Date.now(),
      initiatingSessionHash: flow.initiatingSessionHash,
      loopbackRequest: false,
    })).resolves.toEqual(started);
    await expect(store.consume('oauth-state-token', {
      bindingHash: started.bindingHash,
      provider: 'gmail',
      flowId: flow.flowId,
      now: Date.now(),
    })).resolves.toEqual(started);
    expect(evalScript).toHaveBeenCalledTimes(2);
  });

  it('reports replay, wrong proof, or expiry as invalid flow state', async () => {
    const store = createRedisOAuthStateStore({ set: vi.fn(), eval: vi.fn(async () => '') });
    await expect(store.consume('oauth-state-token', {
      bindingHash: 'b'.repeat(64),
      provider: 'gmail',
      flowId: flow.flowId,
      now: Date.now(),
    })).resolves.toBeNull();
  });

  it('fails closed when Redis cannot record, activate, or consume state', async () => {
    const unavailable = {
      set: vi.fn(async () => { throw new Error('connection refused'); }),
      eval: vi.fn(async () => { throw new Error('connection refused'); }),
    };
    const store = createRedisOAuthStateStore(unavailable);

    await expect(store.record('oauth-state-token', flow, 600_000)).rejects.toThrow(OAuthStateStoreUnavailableError);
    await expect(store.activate('oauth-state-token', {
      startTicketHash: flow.startTicketHash,
      bindingHash: 'b'.repeat(64),
      provider: 'gmail',
      flowId: flow.flowId,
      now: Date.now(),
      initiatingSessionHash: flow.initiatingSessionHash,
      loopbackRequest: false,
    })).rejects.toThrow(OAuthStateStoreUnavailableError);
  });
});
