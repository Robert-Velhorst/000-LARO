import { createClient } from 'redis';
import { ENV } from './_core/env';
import type { RedisScriptClient } from './rateLimitStore';

type HostedRedisClient = RedisScriptClient & {
  isOpen: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: 'error', listener: (error: unknown) => void): unknown;
};

let client: HostedRedisClient | null = null;
let connecting: Promise<HostedRedisClient> | null = null;

/** Lazily connect the hosted shared-state client. Local mode never opens Redis. */
export async function getHostedRedisScriptClient(): Promise<RedisScriptClient> {
  if (!ENV.isHosted || !ENV.REDIS_URL) {
    throw new Error('Hosted Redis is not configured.');
  }
  if (client?.isOpen) return client;
  if (!connecting) {
    const next = createClient({ url: ENV.REDIS_URL }) as unknown as HostedRedisClient;
    next.on('error', (error) => {
      console.error('[HostedRedis] Connection error', error instanceof Error ? error.message : error);
    });
    connecting = next.connect().then(() => {
      client = next;
      return next;
    }).finally(() => {
      connecting = null;
    });
  }
  return await connecting;
}

export async function closeHostedRedis(): Promise<void> {
  const active = client;
  client = null;
  connecting = null;
  if (active?.isOpen) await active.quit();
}
