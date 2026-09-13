export type RateLimitConsumeInput = {
  key: string;
  maxRequests: number;
  windowMs: number;
};

export type RateLimitConsumeResult = {
  allowed: boolean;
  count: number;
  resetAfterMs: number;
};

export interface RedisScriptClient {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export class RateLimitStoreUnavailableError extends Error {
  constructor() {
    super('Shared rate-limit storage is unavailable.');
    this.name = 'RateLimitStoreUnavailableError';
  }
}

const CONSUME_RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local remaining = redis.call('PTTL', KEYS[1])
return { current, remaining }
`;

function parseScriptResult(value: unknown): { count: number; resetAfterMs: number } {
  if (!Array.isArray(value) || value.length !== 2) throw new RateLimitStoreUnavailableError();
  const count = Number(value[0]);
  const resetAfterMs = Number(value[1]);
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(resetAfterMs) || resetAfterMs < 1) {
    throw new RateLimitStoreUnavailableError();
  }
  return { count, resetAfterMs };
}

/**
 * Redis-backed fixed-window limiter. `INCR` and `PEXPIRE` execute inside one
 * Lua script so multiple API replicas observe one count and one expiry.
 */
export function createRedisRateLimitStore(client: RedisScriptClient): {
  consume(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult>;
} {
  return {
    async consume(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult> {
      if (!Number.isSafeInteger(input.maxRequests) || input.maxRequests < 1 ||
          !Number.isSafeInteger(input.windowMs) || input.windowMs < 1 || !input.key.trim()) {
        throw new RateLimitStoreUnavailableError();
      }
      try {
        const result = parseScriptResult(await client.eval(CONSUME_RATE_LIMIT_SCRIPT, {
          keys: [input.key],
          arguments: [String(input.windowMs)],
        }));
        return {
          allowed: result.count <= input.maxRequests,
          count: result.count,
          resetAfterMs: result.resetAfterMs,
        };
      } catch (error) {
        if (error instanceof RateLimitStoreUnavailableError) throw error;
        throw new RateLimitStoreUnavailableError();
      }
    },
  };
}
