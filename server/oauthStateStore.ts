import { createHash } from 'crypto';

const MAX_OAUTH_STATE_TTL_MS = 10 * 60 * 1_000;
const MAX_OAUTH_STATE_LENGTH = 2_048;

export type StoredOAuthFlow = {
  flowId: string;
  userId: string;
  provider: 'gmail' | 'outlook';
  initiatingSessionHash: string;
  allowLoopbackHandoff: boolean;
  startTicketHash: string;
  bindingHash: string | null;
  status: 'pending' | 'started';
  expiresAt: number;
};

export interface RedisOAuthStateClient {
  set(key: string, value: string, options: { NX: true; PX: number }): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export class OAuthStateStoreUnavailableError extends Error {
  constructor() {
    super('Shared OAuth flow storage is unavailable.');
    this.name = 'OAuthStateStoreUnavailableError';
  }
}

const ACTIVATE_FLOW_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local flow = cjson.decode(raw)
if flow.status ~= 'pending'
  or flow.startTicketHash ~= ARGV[1]
  or flow.provider ~= ARGV[3]
  or flow.flowId ~= ARGV[4]
  or tonumber(flow.expiresAt) <= tonumber(ARGV[5])
  or (flow.initiatingSessionHash ~= ARGV[6] and not (flow.allowLoopbackHandoff and ARGV[7] == 'true')) then
  return ''
end
flow.status = 'started'
flow.bindingHash = ARGV[2]
local updated = cjson.encode(flow)
redis.call('SET', KEYS[1], updated, 'KEEPTTL')
return updated
`;

const CONSUME_FLOW_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local flow = cjson.decode(raw)
if flow.status ~= 'started'
  or flow.bindingHash ~= ARGV[1]
  or flow.provider ~= ARGV[2]
  or flow.flowId ~= ARGV[3]
  or tonumber(flow.expiresAt) <= tonumber(ARGV[4]) then
  return ''
end
redis.call('DEL', KEYS[1])
return raw
`;

function stateKey(state: string): string {
  if (!state || state.length > MAX_OAUTH_STATE_LENGTH) throw new OAuthStateStoreUnavailableError();
  return `laro:oauth-flow:${createHash('sha256').update(state).digest('hex')}`;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function parseFlow(value: unknown): StoredOAuthFlow | null {
  if (value === '' || value === null || value === undefined || value === 0) return null;
  if (typeof value !== 'string') throw new OAuthStateStoreUnavailableError();
  try {
    const flow = JSON.parse(value) as StoredOAuthFlow;
    if (
      !flow ||
      typeof flow.flowId !== 'string' ||
      typeof flow.userId !== 'string' ||
      (flow.provider !== 'gmail' && flow.provider !== 'outlook') ||
      !validDigest(flow.initiatingSessionHash) ||
      typeof flow.allowLoopbackHandoff !== 'boolean' ||
      !validDigest(flow.startTicketHash) ||
      (flow.bindingHash !== null && !validDigest(flow.bindingHash)) ||
      (flow.status !== 'pending' && flow.status !== 'started') ||
      !Number.isSafeInteger(flow.expiresAt)
    ) throw new Error('invalid flow record');
    return flow;
  } catch (error) {
    if (error instanceof OAuthStateStoreUnavailableError) throw error;
    throw new OAuthStateStoreUnavailableError();
  }
}

/** Hosted flow state with atomic pending -> started -> consumed transitions. */
export function createRedisOAuthStateStore(client: RedisOAuthStateClient): {
  record(state: string, flow: StoredOAuthFlow, ttlMs: number): Promise<void>;
  activate(
    state: string,
    input: { startTicketHash: string; bindingHash: string; provider: StoredOAuthFlow['provider']; flowId: string; now: number; initiatingSessionHash: string; loopbackRequest: boolean },
  ): Promise<StoredOAuthFlow | null>;
  consume(
    state: string,
    input: { bindingHash: string; provider: StoredOAuthFlow['provider']; flowId: string; now: number },
  ): Promise<StoredOAuthFlow | null>;
} {
  return {
    async record(state, flow, ttlMs): Promise<void> {
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_OAUTH_STATE_TTL_MS) {
        throw new OAuthStateStoreUnavailableError();
      }
      if (!parseFlow(JSON.stringify(flow))) throw new OAuthStateStoreUnavailableError();
      try {
        const outcome = await client.set(stateKey(state), JSON.stringify(flow), { NX: true, PX: ttlMs });
        if (outcome !== 'OK') throw new OAuthStateStoreUnavailableError();
      } catch (error) {
        if (error instanceof OAuthStateStoreUnavailableError) throw error;
        throw new OAuthStateStoreUnavailableError();
      }
    },

    async activate(state, input): Promise<StoredOAuthFlow | null> {
      try {
        return parseFlow(await client.eval(ACTIVATE_FLOW_SCRIPT, {
          keys: [stateKey(state)],
          arguments: [
            input.startTicketHash,
            input.bindingHash,
            input.provider,
            input.flowId,
            String(input.now),
            input.initiatingSessionHash,
            String(input.loopbackRequest),
          ],
        }));
      } catch (error) {
        if (error instanceof OAuthStateStoreUnavailableError) throw error;
        throw new OAuthStateStoreUnavailableError();
      }
    },

    async consume(state, input): Promise<StoredOAuthFlow | null> {
      try {
        return parseFlow(await client.eval(CONSUME_FLOW_SCRIPT, {
          keys: [stateKey(state)],
          arguments: [input.bindingHash, input.provider, input.flowId, String(input.now)],
        }));
      } catch (error) {
        if (error instanceof OAuthStateStoreUnavailableError) throw error;
        throw new OAuthStateStoreUnavailableError();
      }
    },
  };
}
