import { describe, expect, it, vi } from 'vitest';
import {
  RateLimitStoreUnavailableError,
  createRedisRateLimitStore,
} from '../../server/rateLimitStore';
import { enforceSharedRateLimit } from '../../server/rateLimit';

describe('Redis rate-limit store', () => {
  it('uses one atomic script result to allow the first request and report its reset time', async () => {
    const evalScript = vi.fn(async () => [1, 60_000]);
    const store = createRedisRateLimitStore({ eval: evalScript });

    await expect(store.consume({ key: 'laro:ratelimit:hash', maxRequests: 2, windowMs: 60_000 }))
      .resolves.toEqual({ allowed: true, count: 1, resetAfterMs: 60_000 });
    expect(evalScript).toHaveBeenCalledWith(expect.any(String), {
      keys: ['laro:ratelimit:hash'],
      arguments: ['60000'],
    });
  });

  it('rejects a request after the shared limit has been exceeded', async () => {
    const store = createRedisRateLimitStore({ eval: vi.fn(async () => [3, 42_000]) });

    await expect(store.consume({ key: 'laro:ratelimit:hash', maxRequests: 2, windowMs: 60_000 }))
      .resolves.toEqual({ allowed: false, count: 3, resetAfterMs: 42_000 });
  });

  it('fails closed when Redis cannot perform the atomic operation', async () => {
    const store = createRedisRateLimitStore({ eval: vi.fn(async () => { throw new Error('connection refused'); }) });

    await expect(store.consume({ key: 'laro:ratelimit:hash', maxRequests: 2, windowMs: 60_000 }))
      .rejects.toThrow(RateLimitStoreUnavailableError);
  });

  it('turns a shared-limit denial into the existing tRPC error contract', async () => {
    await expect(enforceSharedRateLimit({
      store: { consume: async () => ({ allowed: false, count: 4, resetAfterMs: 12_000 }) },
      key: 'laro:ratelimit:hash',
      config: { maxRequests: 3, windowMs: 60_000, message: 'Too many imports.' },
    })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS', message: 'Too many imports.' });
  });
});
