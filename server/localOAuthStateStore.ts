import { and, eq, like, lt } from 'drizzle-orm';
import { createHash } from 'crypto';
import { getDb } from './db';
import { systemConfig } from './schema';
import type { StoredOAuthFlow } from './oauthStateStore';
import { OAuthStateStoreUnavailableError } from './oauthStateStore';

const FLOW_PREFIX = 'oauth-flow:';
const FLOW_TTL_MS = 10 * 60 * 1_000;

function flowKey(state: string): string {
  return `${FLOW_PREFIX}${createHash('sha256').update(state).digest('hex')}`;
}

function parseFlow(value: string | null | undefined): StoredOAuthFlow | null {
  if (!value) return null;
  try {
    const flow = JSON.parse(value) as StoredOAuthFlow;
    if (!flow || typeof flow.flowId !== 'string' || typeof flow.userId !== 'string') return null;
    return flow;
  } catch {
    return null;
  }
}

async function database() {
  try {
    const db = await getDb();
    if (!db) throw new Error('database unavailable');
    return db;
  } catch {
    throw new OAuthStateStoreUnavailableError();
  }
}

/** Persistent one-time flow store used by the local and packaged runtimes. */
export function createLocalOAuthStateStore() {
  return {
    async record(state: string, flow: StoredOAuthFlow, _ttlMs = FLOW_TTL_MS): Promise<void> {
      const db = await database();
      try {
        db.transaction((tx) => {
          tx.delete(systemConfig).where(and(
            like(systemConfig.configKey, `${FLOW_PREFIX}%`),
            lt(systemConfig.updatedAt, new Date(Date.now() - FLOW_TTL_MS)),
          )).run();
          const inserted = tx.insert(systemConfig).values({
            configKey: flowKey(state),
            configValue: JSON.stringify(flow),
            updatedAt: new Date(),
          }).onConflictDoNothing().run();
          if (Number(inserted.changes || 0) !== 1) throw new Error('duplicate OAuth flow');
        });
      } catch {
        throw new OAuthStateStoreUnavailableError();
      }
    },

    async activate(
      state: string,
      input: { startTicketHash: string; bindingHash: string; provider: StoredOAuthFlow['provider']; flowId: string; now: number; initiatingSessionHash: string; loopbackRequest: boolean },
    ): Promise<StoredOAuthFlow | null> {
      const db = await database();
      try {
        return db.transaction((tx) => {
          const key = flowKey(state);
          const row = tx.select({ value: systemConfig.configValue }).from(systemConfig).where(eq(systemConfig.configKey, key)).get();
          const flow = parseFlow(row?.value);
          if (
            !flow || flow.status !== 'pending' || flow.expiresAt <= input.now ||
            flow.startTicketHash !== input.startTicketHash || flow.provider !== input.provider ||
            flow.flowId !== input.flowId ||
            (flow.initiatingSessionHash !== input.initiatingSessionHash &&
              !(flow.allowLoopbackHandoff && input.loopbackRequest))
          ) return null;
          const updated: StoredOAuthFlow = { ...flow, status: 'started', bindingHash: input.bindingHash };
          const result = tx.update(systemConfig).set({
            configValue: JSON.stringify(updated),
            updatedAt: new Date(),
          }).where(and(eq(systemConfig.configKey, key), eq(systemConfig.configValue, row!.value!))).run();
          return Number(result.changes || 0) === 1 ? updated : null;
        });
      } catch {
        throw new OAuthStateStoreUnavailableError();
      }
    },

    async consume(
      state: string,
      input: { bindingHash: string; provider: StoredOAuthFlow['provider']; flowId: string; now: number },
    ): Promise<StoredOAuthFlow | null> {
      const db = await database();
      try {
        return db.transaction((tx) => {
          const key = flowKey(state);
          const row = tx.select({ value: systemConfig.configValue }).from(systemConfig).where(eq(systemConfig.configKey, key)).get();
          const flow = parseFlow(row?.value);
          if (
            !flow || flow.status !== 'started' || flow.expiresAt <= input.now ||
            flow.bindingHash !== input.bindingHash || flow.provider !== input.provider ||
            flow.flowId !== input.flowId
          ) return null;
          const removed = tx.delete(systemConfig).where(and(
            eq(systemConfig.configKey, key),
            eq(systemConfig.configValue, row!.value!),
          )).run();
          return Number(removed.changes || 0) === 1 ? flow : null;
        });
      } catch {
        throw new OAuthStateStoreUnavailableError();
      }
    },
  };
}
