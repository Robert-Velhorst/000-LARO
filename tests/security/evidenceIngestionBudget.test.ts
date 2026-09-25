import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireEvidenceIngestionRequestOperation,
  admitEvidenceIngestionRequest,
  EvidenceIngestionBudget,
  EvidenceIngestionLimitError,
  resetEvidenceIngestionRequestJobsForTests,
  type EvidenceIngestionLimits,
} from "../../server/evidenceIngestionBudget";

const limits: EvidenceIngestionLimits = {
  maxFileBytes: 10,
  maxJobBytes: 12,
  maxJobItems: 2,
  maxConcurrentOperations: 2,
  maxAnalysisItems: 1,
  minLocalStorageHeadroomBytes: 0,
};

describe("evidence ingestion resource contract", () => {
  beforeEach(() => resetEvidenceIngestionRequestJobsForTests());
  afterEach(() => resetEvidenceIngestionRequestJobsForTests());

  it("enforces cumulative item and byte budgets across source changes", async () => {
    const budget = new EvidenceIngestionBudget(undefined, limits);
    const local = await budget.reserve("local", 6);
    const drive = await budget.reserve("google_drive", 6);
    expect(local).not.toBeNull();
    expect(drive).not.toBeNull();
    expect(await budget.reserve("gmail_attachment", 1)).toBeNull();

    local!.complete(6);
    drive!.complete(5);
    expect(budget.summary()).toMatchObject({
      outcome: "partial",
      processedItems: 2,
      skippedItems: 1,
      processedBytes: 11,
      admittedBytes: 12,
      reasons: [{ source: "gmail_attachment", code: "job_item_limit", count: 1 }],
    });
  });

  it("rejects files and cumulative bytes before running their read operation", async () => {
    const budget = new EvidenceIngestionBudget(undefined, { ...limits, maxJobItems: 5 });
    expect(await budget.reserve("local", 11)).toBeNull();
    const first = await budget.reserve("local", 8);
    expect(first).not.toBeNull();
    expect(await budget.reserve("google_drive", 5)).toBeNull();
    first!.complete(8);
    expect(budget.summary().reasons).toEqual([
      { source: "google_drive", code: "job_byte_limit", count: 1 },
      { source: "local", code: "file_too_large", count: 1 },
    ]);
  });

  it("runs no more than two selected ingestion operations concurrently", async () => {
    const budget = new EvidenceIngestionBudget(undefined, { ...limits, maxJobBytes: 20, maxJobItems: 3 });
    const reservations = await Promise.all([
      budget.reserve("local", 1),
      budget.reserve("google_drive", 1),
      budget.reserve("gmail_attachment", 1),
    ]);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const operations = reservations.map((reservation) => reservation!.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => { releases.push(resolve); });
      active -= 1;
    }));

    await viWaitFor(() => releases.length === 2);
    expect(peak).toBe(2);
    releases.splice(0).forEach((release) => release());
    await viWaitFor(() => releases.length === 1);
    releases.splice(0).forEach((release) => release());
    await Promise.all(operations);
    expect(peak).toBe(2);
  });

  it("cancels queued operations without starting them", async () => {
    const controller = new AbortController();
    const budget = new EvidenceIngestionBudget(controller.signal, {
      ...limits,
      maxConcurrentOperations: 1,
      maxJobBytes: 20,
    });
    const first = (await budget.reserve("local", 1))!;
    const second = (await budget.reserve("google_drive", 1))!;
    let releaseFirst!: () => void;
    const running = first.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    await viWaitFor(() => typeof releaseFirst === "function");
    let secondStarted = false;
    const queued = second.run(async () => { secondStarted = true; });
    const queuedRejection = expect(queued).rejects.toMatchObject({ code: "cancelled" });
    await Promise.resolve();
    controller.abort();
    releaseFirst();

    await running;
    await queuedRejection;
    expect(secondStarted).toBe(false);
    expect(budget.summary().outcome).toBe("cancelled");
  });

  it("defers analysis separately after the configured eligibility count", () => {
    const budget = new EvidenceIngestionBudget(undefined, limits);
    expect(budget.claimAnalysis("local")).toBe(true);
    expect(budget.claimAnalysis("google_drive")).toBe(false);
    expect(budget.summary()).toMatchObject({
      outcome: "partial",
      analysisItems: 1,
      reasons: [{ source: "google_drive", code: "analysis_limit", count: 1 }],
    });
  });

  it("makes named request jobs cumulative and scanner retries idempotent", async () => {
    const base = {
      ownerId: "evidence-budget-owner",
      jobId: "scanner-job-1",
      source: "desktop_scanner" as const,
    };
    const first = await admitEvidenceIngestionRequest({ ...base, itemId: "file-1", bytes: 7 * 1024 * 1024 });
    const retry = await admitEvidenceIngestionRequest({ ...base, itemId: "file-1", bytes: 7 * 1024 * 1024 });
    expect(first).toMatchObject({ resumed: false, items: 1 });
    expect(retry).toEqual({ resumed: true, items: 1, bytes: 7 * 1024 * 1024 });

    for (let index = 2; index <= 9; index += 1) {
      await admitEvidenceIngestionRequest({ ...base, itemId: `file-${index}`, bytes: 7 * 1024 * 1024 });
    }
    await expect(admitEvidenceIngestionRequest({
      ...base,
      itemId: "file-10",
      bytes: 7 * 1024 * 1024,
    })).rejects.toMatchObject({ code: "job_byte_limit" });
    await expect(admitEvidenceIngestionRequest({ ...base, itemId: "file-1", bytes: 1 }))
      .rejects.toMatchObject({ code: "source_changed" });
  });

  it("rejects a third concurrent request in the same owner job", () => {
    const input = { ownerId: "parallel-owner", jobId: "parallel-job", source: "manual" as const };
    const releaseFirst = acquireEvidenceIngestionRequestOperation(input);
    const releaseSecond = acquireEvidenceIngestionRequestOperation(input);
    let rejection: unknown;
    try { acquireEvidenceIngestionRequestOperation(input); } catch (error) { rejection = error; }
    expect(rejection).toMatchObject({ code: "concurrency_limit" });
    releaseFirst();
    const releaseThird = acquireEvidenceIngestionRequestOperation(input);
    releaseSecond();
    releaseThird();
  });

  it("reports storage headroom exhaustion as a bounded partial outcome", async () => {
    const budget = new EvidenceIngestionBudget(undefined, {
      ...limits,
      minLocalStorageHeadroomBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(await budget.reserve("manual", 1)).toBeNull();
    expect(budget.summary()).toMatchObject({
      outcome: "partial",
      processedItems: 0,
      skippedItems: 1,
      reasons: [{ source: "manual", code: "storage_headroom", count: 1 }],
    });
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => { setTimeout(resolve, 1); });
  }
  throw new EvidenceIngestionLimitError("manual", "read_failed", "Timed out waiting for ingestion test state");
}
