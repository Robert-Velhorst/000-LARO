export const PROVIDER_LIMITS = {
  googleDrive: {
    maxListedFiles: 1_000,
    maxListPages: 50,
    maxFoldersScanned: 100,
    maxImportFiles: 14,
    maxExactNameMatches: 100,
  },
  trello: {
    maxJsonBytes: 2 * 1024 * 1024,
    maxMemberJsonBytes: 256 * 1024,
    maxBoards: 100,
    maxListsPerBoard: 250,
    maxCardsPerList: 500,
    maxCommentsPerCard: 500,
    maxAttachmentsPerCard: 100,
    maxSyncBoards: 25,
    maxSyncLists: 250,
    maxSyncCards: 1_000,
    maxSyncComments: 5_000,
    maxSyncAttachments: 14,
    maxSyncRequests: 300,
    maxSyncJsonBytes: 32 * 1024 * 1024,
  },
} as const;

export class ProviderBatchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderBatchLimitError";
  }
}

export class ProviderBatchBudget<K extends string> {
  private readonly consumed = new Map<K, number>();

  constructor(private readonly limits: Readonly<Record<K, number>>) {
    for (const [key, limit] of Object.entries(limits)) {
      if (!Number.isSafeInteger(limit) || Number(limit) < 0) {
        throw new Error(`Provider budget ${key} must be a non-negative safe integer`);
      }
    }
  }

  consume(kind: K, amount = 1, message?: string): number {
    if (!Object.prototype.hasOwnProperty.call(this.limits, kind)) {
      throw new Error(`Provider budget ${kind} is not configured`);
    }
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new Error("Provider budget consumption must be a non-negative safe integer");
    }
    const next = (this.consumed.get(kind) || 0) + amount;
    if (next > this.limits[kind]) {
      throw new ProviderBatchLimitError(message || `Provider ${kind} limit exceeded`);
    }
    this.consumed.set(kind, next);
    return next;
  }

  used(kind: K): number {
    return this.consumed.get(kind) || 0;
  }
}

export function assertProviderArrayLimit<T>(
  value: unknown,
  limit: number,
  label: string,
): asserts value is T[] {
  if (!Array.isArray(value)) throw new Error(`${label} response was not an array`);
  if (value.length > limit) throw new ProviderBatchLimitError(`${label} limit exceeded`);
}
