export const PROVIDER_LIMITS = {
  googleDrive: {
    maxListedFiles: 1_000,
    maxListPages: 50,
    maxFoldersScanned: 100,
    maxImportFiles: 14,
    maxExactNameMatches: 100,
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
