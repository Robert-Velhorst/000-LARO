import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getLocalStorageDirectory } from "./storage";
import {
  EVIDENCE_INGESTION_LIMITS,
  type EvidenceIngestionLimitValues,
  type EvidenceIngestionReason,
  type EvidenceIngestionReasonCode,
  type EvidenceIngestionSource,
  type EvidenceIngestionSummary,
} from "../shared/evidenceIngestion";

export type EvidenceIngestionLimits = EvidenceIngestionLimitValues;

export class EvidenceIngestionLimitError extends Error {
  constructor(
    readonly source: EvidenceIngestionSource,
    readonly code: EvidenceIngestionReasonCode,
    message: string,
  ) {
    super(message);
    this.name = "EvidenceIngestionLimitError";
  }
}

async function nearestExistingDirectory(value: string): Promise<string> {
  let candidate = path.resolve(value);
  for (;;) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
      candidate = path.dirname(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export async function assertEvidenceStorageHeadroom(
  additionalBytes: number,
  minimumHeadroom = EVIDENCE_INGESTION_LIMITS.minLocalStorageHeadroomBytes,
): Promise<void> {
  if (process.env.AWS_S3_BUCKET) return;
  const directory = await nearestExistingDirectory(getLocalStorageDirectory());
  const stats = await fs.statfs(directory);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes - additionalBytes < minimumHeadroom) {
    throw new Error("Managed evidence storage does not have enough safe headroom for this ingestion");
  }
}

type Waiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export class EvidenceIngestionReservation {
  private settled = false;

  constructor(
    private readonly budget: EvidenceIngestionBudget,
    readonly source: EvidenceIngestionSource,
    readonly declaredBytes: number,
  ) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.budget.run(operation);
  }

  validateActualBytes(actualBytes: number): void {
    if (!Number.isSafeInteger(actualBytes) || actualBytes <= 0 || actualBytes > this.declaredBytes) {
      throw new EvidenceIngestionLimitError(
        this.source,
        actualBytes > this.declaredBytes ? "source_changed" : "read_failed",
        "The evidence bytes did not match the preflight metadata",
      );
    }
  }

  complete(actualBytes: number): void {
    if (this.settled) return;
    this.settled = true;
    this.budget.complete(this.source, this.declaredBytes, actualBytes);
  }

  skip(code: EvidenceIngestionReasonCode): void {
    if (this.settled) return;
    this.budget.skipReserved(this.source, code);
    this.settled = true;
  }
}

export class EvidenceIngestionBudget {
  private admittedItems = 0;
  private admittedBytes = 0;
  private processedItems = 0;
  private processedBytes = 0;
  private skippedItems = 0;
  private analysisItems = 0;
  private activeOperations = 0;
  private readonly waiters: Waiter[] = [];
  private readonly reasonCounts = new Map<string, EvidenceIngestionReason>();

  constructor(
    readonly signal?: AbortSignal,
    private readonly limits: EvidenceIngestionLimitValues = EVIDENCE_INGESTION_LIMITS,
  ) {}

  throwIfCancelled(source: EvidenceIngestionSource = "manual"): void {
    if (this.signal?.aborted) {
      throw new EvidenceIngestionLimitError(source, "cancelled", "Evidence ingestion was cancelled");
    }
  }

  private recordReason(source: EvidenceIngestionSource, code: EvidenceIngestionReasonCode): void {
    const key = `${source}:${code}`;
    const current = this.reasonCounts.get(key);
    if (current) current.count += 1;
    else this.reasonCounts.set(key, { source, code, count: 1 });
  }

  recordSkip(source: EvidenceIngestionSource, code: EvidenceIngestionReasonCode): void {
    this.skippedItems += 1;
    this.recordReason(source, code);
  }

  remainingItems(): number {
    return Math.max(0, this.limits.maxJobItems - this.admittedItems);
  }

  hasCapacity(minimumBytes = 1): boolean {
    return this.remainingItems() > 0 && this.admittedBytes + minimumBytes <= this.limits.maxJobBytes;
  }

  recordCapacityLimit(source: EvidenceIngestionSource): void {
    this.recordSkip(
      source,
      this.remainingItems() <= 0 ? "job_item_limit" : "job_byte_limit",
    );
  }

  async reserve(
    source: EvidenceIngestionSource,
    declaredBytes: number | null | undefined,
  ): Promise<EvidenceIngestionReservation | null> {
    this.throwIfCancelled(source);
    const bytes = declaredBytes == null ? this.limits.maxFileBytes : declaredBytes;
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      this.recordSkip(source, "file_empty");
      return null;
    }
    if (bytes > this.limits.maxFileBytes) {
      this.recordSkip(source, "file_too_large");
      return null;
    }
    if (this.admittedItems >= this.limits.maxJobItems) {
      this.recordSkip(source, "job_item_limit");
      return null;
    }
    if (this.admittedBytes + bytes > this.limits.maxJobBytes) {
      this.recordSkip(source, "job_byte_limit");
      return null;
    }
    try {
      await assertEvidenceStorageHeadroom(bytes, this.limits.minLocalStorageHeadroomBytes);
    } catch {
      this.recordSkip(source, "storage_headroom");
      return null;
    }
    this.throwIfCancelled(source);
    // Re-check after the asynchronous disk probe so parallel sources cannot
    // race through the cumulative item/byte ceilings.
    if (this.admittedItems >= this.limits.maxJobItems) {
      this.recordSkip(source, "job_item_limit");
      return null;
    }
    if (this.admittedBytes + bytes > this.limits.maxJobBytes) {
      this.recordSkip(source, "job_byte_limit");
      return null;
    }
    this.admittedItems += 1;
    this.admittedBytes += bytes;
    return new EvidenceIngestionReservation(this, source, bytes);
  }

  claimAnalysis(source: EvidenceIngestionSource): boolean {
    this.throwIfCancelled(source);
    if (this.analysisItems >= this.limits.maxAnalysisItems) {
      this.recordReason(source, "analysis_limit");
      return false;
    }
    this.analysisItems += 1;
    return true;
  }

  complete(source: EvidenceIngestionSource, declaredBytes: number, actualBytes: number): void {
    if (!Number.isSafeInteger(actualBytes) || actualBytes <= 0 || actualBytes > declaredBytes) {
      this.recordSkip(source, actualBytes > declaredBytes ? "source_changed" : "read_failed");
      throw new EvidenceIngestionLimitError(
        source,
        actualBytes > declaredBytes ? "source_changed" : "read_failed",
        "The evidence bytes did not match the preflight metadata",
      );
    }
    this.processedItems += 1;
    this.processedBytes += actualBytes;
  }

  skipReserved(source: EvidenceIngestionSource, code: EvidenceIngestionReasonCode): void {
    this.recordSkip(source, code);
  }

  private acquire(): Promise<void> {
    this.throwIfCancelled();
    if (this.activeOperations < this.limits.maxConcurrentOperations) {
      this.activeOperations += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal: this.signal };
      if (this.signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new EvidenceIngestionLimitError("manual", "cancelled", "Evidence ingestion was cancelled"));
        };
        this.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    for (;;) {
      const next = this.waiters.shift();
      if (!next) {
        this.activeOperations -= 1;
        return;
      }
      if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.reject(new EvidenceIngestionLimitError("manual", "cancelled", "Evidence ingestion was cancelled"));
        continue;
      }
      next.resolve();
      return;
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      this.throwIfCancelled();
      return await operation();
    } finally {
      this.release();
    }
  }

  summary(): EvidenceIngestionSummary {
    const reasons = [...this.reasonCounts.values()]
      .sort((a, b) => a.source.localeCompare(b.source) || a.code.localeCompare(b.code));
    const cancelled = this.signal?.aborted || reasons.some((reason) => reason.code === "cancelled");
    if (cancelled && !reasons.some((reason) => reason.code === "cancelled")) {
      reasons.unshift({ source: "collection", code: "cancelled", count: 1 });
    }
    const limited = reasons.some((reason) => reason.code !== "duplicate");
    return {
      outcome: cancelled ? "cancelled" : limited
        ? "partial"
        : "completed",
      processedItems: this.processedItems,
      skippedItems: this.skippedItems,
      processedBytes: this.processedBytes,
      admittedBytes: this.admittedBytes,
      analysisItems: this.analysisItems,
      limits: { ...this.limits },
      reasons,
    };
  }
}

type RequestJobState = {
  bytes: number;
  items: Map<string, number>;
  expiresAt: number;
};

const REQUEST_JOB_TTL_MS = 24 * 60 * 60 * 1_000;
const requestJobs = new Map<string, RequestJobState>();
const activeRequestOperations = new Map<string, number>();

function requestJobKey(ownerId: string, jobId: string): string {
  return createHash("sha256").update(`${ownerId}\0${jobId}`).digest("hex");
}

function purgeExpiredRequestJobs(now: number): void {
  for (const [key, state] of requestJobs) {
    if (state.expiresAt <= now) requestJobs.delete(key);
  }
}

/**
 * Admit one HTTP upload into a named owner/job budget. Item IDs make scanner
 * retries idempotent while preventing the same ID from being rebound to a
 * different byte length.
 */
export async function admitEvidenceIngestionRequest(input: {
  ownerId: string;
  jobId: string;
  itemId: string;
  source: EvidenceIngestionSource;
  bytes: number;
}): Promise<{ resumed: boolean; items: number; bytes: number }> {
  const ownerId = input.ownerId.trim();
  const jobId = input.jobId.trim();
  const itemId = input.itemId.trim();
  if (!ownerId || ownerId.length > 256 || !jobId || jobId.length > 200 || !itemId || itemId.length > 200) {
    throw new EvidenceIngestionLimitError(input.source, "read_failed", "Evidence ingestion job metadata is invalid");
  }
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) {
    throw new EvidenceIngestionLimitError(input.source, "file_empty", "Evidence files must not be empty");
  }
  if (input.bytes > EVIDENCE_INGESTION_LIMITS.maxFileBytes) {
    throw new EvidenceIngestionLimitError(input.source, "file_too_large", "Evidence file exceeds the 7 MB limit");
  }
  try {
    await assertEvidenceStorageHeadroom(input.bytes);
  } catch {
    throw new EvidenceIngestionLimitError(
      input.source,
      "storage_headroom",
      "Managed evidence storage does not have enough safe headroom for this ingestion",
    );
  }

  const now = Date.now();
  purgeExpiredRequestJobs(now);
  const key = requestJobKey(ownerId, jobId);
  const state = requestJobs.get(key) ?? {
    bytes: 0,
    items: new Map<string, number>(),
    expiresAt: now + REQUEST_JOB_TTL_MS,
  };
  const previousBytes = state.items.get(itemId);
  if (previousBytes !== undefined) {
    if (previousBytes !== input.bytes) {
      throw new EvidenceIngestionLimitError(
        input.source,
        "source_changed",
        "This ingestion item identifier is already bound to different bytes",
      );
    }
    return { resumed: true, items: state.items.size, bytes: state.bytes };
  }
  if (state.items.size >= EVIDENCE_INGESTION_LIMITS.maxJobItems) {
    throw new EvidenceIngestionLimitError(
      input.source,
      "job_item_limit",
      `Evidence ingestion jobs are limited to ${EVIDENCE_INGESTION_LIMITS.maxJobItems} items`,
    );
  }
  if (state.bytes + input.bytes > EVIDENCE_INGESTION_LIMITS.maxJobBytes) {
    throw new EvidenceIngestionLimitError(
      input.source,
      "job_byte_limit",
      `Evidence ingestion jobs are limited to ${EVIDENCE_INGESTION_LIMITS.maxJobBytes} bytes`,
    );
  }
  state.items.set(itemId, input.bytes);
  state.bytes += input.bytes;
  state.expiresAt = now + REQUEST_JOB_TTL_MS;
  requestJobs.set(key, state);
  return { resumed: false, items: state.items.size, bytes: state.bytes };
}

export function acquireEvidenceIngestionRequestOperation(input: {
  ownerId: string;
  jobId: string;
  source: EvidenceIngestionSource;
}): () => void {
  const key = requestJobKey(input.ownerId.trim(), input.jobId.trim());
  const active = activeRequestOperations.get(key) ?? 0;
  if (active >= EVIDENCE_INGESTION_LIMITS.maxConcurrentOperations) {
    throw new EvidenceIngestionLimitError(
      input.source,
      "concurrency_limit",
      `Evidence ingestion jobs allow at most ${EVIDENCE_INGESTION_LIMITS.maxConcurrentOperations} concurrent operations`,
    );
  }
  activeRequestOperations.set(key, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = activeRequestOperations.get(key) ?? 0;
    if (current <= 1) activeRequestOperations.delete(key);
    else activeRequestOperations.set(key, current - 1);
  };
}

export async function withEvidenceIngestionRequestOperation<T>(
  input: Parameters<typeof acquireEvidenceIngestionRequestOperation>[0],
  operation: () => Promise<T>,
): Promise<T> {
  const release = acquireEvidenceIngestionRequestOperation(input);
  try {
    return await operation();
  } finally {
    release();
  }
}

export function resetEvidenceIngestionRequestJobsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Evidence ingestion job reset is test-only");
  requestJobs.clear();
  activeRequestOperations.clear();
}
