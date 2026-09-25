import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("review-gated media and organization outreach directory", () => {
  let app: TestApp;
  const owner = { id: "USR_TARGET_OWNER", name: "Owner", role: "user", email: "target-owner@example.com" };
  const other = { id: "USR_TARGET_OTHER", name: "Other", role: "user", email: "target-other@example.com" };
  const sensitiveSummary = "Client alleges a confidential dismissal by Example Employer";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: other.id, email: other.email }),
    ]);
    await app.db.insert(app.schema.cases).values([
      buildCase({
        id: "CASE_TARGET_OWNER",
        userId: owner.id,
        caseSummary: sensitiveSummary,
        legalAreas: JSON.stringify(["Employment Law"]),
      }),
      buildCase({
        id: "CASE_TARGET_OTHER",
        userId: other.id,
        legalAreas: JSON.stringify(["Employment Law"]),
      }),
      buildCase({
        id: "CASE_TARGET_OWNER_B",
        userId: owner.id,
        caseSummary: "A second employment matter used to verify discovery-run isolation",
        legalAreas: JSON.stringify(["Employment Law"]),
      }),
      buildCase({
        id: "CASE_TARGET_UNSUPPORTED",
        userId: owner.id,
        legalAreas: JSON.stringify(["Confidential custom dispute label"]),
      }),
    ]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => app?.cleanup());

  it("discovers only from legal-area queries, deduplicates, and requires review before matching", async () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Femployment-support%3Futm_source%3Dtest">Employment Support Foundation</a>
        <div class="result__snippet">Independent foundation offering employment advice and advocacy.</div>
      </div>`;
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }));

    const caller = app.makeCaller(owner);
    const report = await caller.outreachDirectory.discoverForCase({
      caseId: "CASE_TARGET_OWNER",
      targetType: "organization",
      maxQueries: 2,
      maxResults: 10,
    });

    expect(report).toMatchObject({
      rawCaseTextShared: false,
      completedQueries: 2,
      discoveredCandidates: 1,
      newCandidates: 1,
      status: "complete",
    });
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls.every((url) => url.includes("arbeidsrecht"))).toBe(true);
    expect(requestedUrls.every((url) => !decodeURIComponent(url).includes(sensitiveSummary))).toBe(true);

    const pending = await caller.outreachDirectory.list({ targetType: "organization", status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toBe("https://example.org/employment-support");
    expect(await caller.outreachDirectory.matches({
      caseId: "CASE_TARGET_OWNER",
      targetType: "organization",
    })).toHaveLength(0);
    expect(await app.makeCaller(other).outreachDirectory.list({ targetType: "organization" })).toHaveLength(0);

    const reviewed = await caller.outreachDirectory.review({
      id: pending[0].id,
      status: "approved",
      targetType: "organization",
      caseId: "CASE_TARGET_OWNER",
      reviewNotes: "Scope and public source reviewed.",
    });
    expect(reviewed.matches).toHaveLength(1);
    expect(reviewed.matches[0]).toMatchObject({
      targetType: "organization",
      status: "suggested",
      target: { id: pending[0].id, status: "approved" },
    });
    expect(reviewed.matches[0].matchScore).toBeGreaterThanOrEqual(60);
    expect(reviewed.matches[0].matchReasons).toContain("Legal-area fit: Employment Law");

    await expect(caller.outreachDirectory.review({
      id: pending[0].id,
      status: "approved",
      targetType: "media",
      caseId: "CASE_TARGET_OWNER",
    })).rejects.toThrow("Outreach target not found");

    await caller.outreachDirectory.review({
      id: pending[0].id,
      status: "rejected",
      targetType: "organization",
      caseId: "CASE_TARGET_OWNER",
    });
    expect(await caller.outreachDirectory.matches({
      caseId: "CASE_TARGET_OWNER",
      targetType: "organization",
    })).toHaveLength(0);

    await expect(app.makeCaller(other).outreachDirectory.review({
      id: pending[0].id,
      status: "rejected",
      targetType: "organization",
      caseId: "CASE_TARGET_OTHER",
    })).rejects.toThrow("Outreach target not found");
  });

  it("imports manual candidates as pending and keeps them tenant-scoped", async () => {
    const caller = app.makeCaller(owner);
    const created = await caller.outreachDirectory.createManual({
      targetType: "media",
      name: "Public-interest newsroom",
      url: "https://news.example.nl/investigations",
      description: "Investigative newsroom covering workplace disputes.",
      legalAreas: ["Employment Law"],
    });
    const pending = await caller.outreachDirectory.list({ targetType: "media", status: "pending" });
    expect(pending.some((target: { id: string }) => target.id === created.id)).toBe(true);
    expect(await app.makeCaller(other).outreachDirectory.list({ targetType: "media" })).toHaveLength(0);
  });

  it("does not send unsupported case labels to the public discovery provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(app.makeCaller(owner).outreachDirectory.discoverForCase({
      caseId: "CASE_TARGET_UNSUPPORTED",
      targetType: "media",
      maxQueries: 2,
      maxResults: 10,
    })).rejects.toThrow("supported legal area");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("supports one-action batch review", async () => {
    const caller = app.makeCaller(owner);
    const first = await caller.outreachDirectory.createManual({
      targetType: "organization",
      name: "Employment Rights One",
      url: "https://batch-one.example.org",
      legalAreas: ["Employment Law"],
    });
    const second = await caller.outreachDirectory.createManual({
      targetType: "organization",
      name: "Employment Rights Two",
      url: "https://batch-two.example.org",
      legalAreas: ["Employment Law"],
    });
    await expect(caller.outreachDirectory.reviewBatch({
      ids: [first.id, "TARGET_NOT_OWNED"],
      status: "approved",
      targetType: "organization",
      caseId: "CASE_TARGET_OWNER",
    })).rejects.toThrow("not found");
    const stillPending = await caller.outreachDirectory.list({ targetType: "organization", status: "pending" });
    expect(stillPending.map((target) => target.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    await expect(caller.outreachDirectory.reviewBatch({
      ids: [first.id, first.id],
      status: "approved",
      targetType: "organization",
    })).rejects.toThrow("Duplicate outreach target IDs");
    const batch = await caller.outreachDirectory.reviewBatch({
      ids: [first.id, second.id],
      status: "approved",
      targetType: "organization",
      caseId: "CASE_TARGET_OWNER",
    });
    expect(batch.reviewed).toBe(2);
    expect(batch.matches?.length).toBeGreaterThanOrEqual(2);
  });

  it("auto-reviews only active-run candidates and preserves manual, historical, and repeated records", async () => {
    const caller = app.makeCaller(owner);
    const manual = await caller.outreachDirectory.createManual({
      targetType: "media",
      name: "Manual employment newsroom",
      url: "https://manual-scope.example.nl/employment",
      legalAreas: ["Employment Law"],
    });

    await caller.userPreferences.updateWorkflow({ outreachReviewMode: "each" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <div class="result">
        <a class="result__a" href="https://historical-scope.example.nl/employment">Historical Employment Desk</a>
        <div class="result__snippet">Employment reporting discovered for the first case.</div>
      </div>`, { status: 200, headers: { "Content-Type": "text/html" } })));
    const historical = await caller.outreachDirectory.discoverForCase({
      caseId: "CASE_TARGET_OWNER",
      targetType: "media",
      maxQueries: 1,
      maxResults: 5,
    });
    expect(historical.createdTargetIds).toHaveLength(1);
    const historicalId = historical.createdTargetIds[0];
    expect(historical.leftPendingTargetIds).toContain(historicalId);

    await caller.userPreferences.updateWorkflow({ outreachReviewMode: "automatic" });
    try {
      const activeRunHtml = `
        <div class="result">
          <a class="result__a" href="https://manual-scope.example.nl/employment">Manual employment newsroom from search</a>
          <div class="result__snippet">The provider returned a URL that belongs to a manual record.</div>
        </div>
        <div class="result">
          <a class="result__a" href="https://automatic-scope.example.nl/employment-desk">Employment Desk News</a>
          <div class="result__snippet">Public-interest employment reporting and workplace support.</div>
        </div>`;
      vi.stubGlobal("fetch", vi.fn(async () => new Response(activeRunHtml, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })));

      const report = await caller.outreachDirectory.discoverForCase({
        caseId: "CASE_TARGET_OWNER_B",
        targetType: "media",
        maxQueries: 1,
        maxResults: 5,
      });
      expect(report.reviewMode).toBe("automatic");
      expect(report.status).toBe("complete");
      expect(report.runId).toMatch(/^DISCOVERY-/);
      expect(report.createdTargetIds).toHaveLength(1);
      expect(report.refreshedTargetIds).toEqual([]);
      const activeTargetId = report.createdTargetIds[0];
      expect(report.candidateTargetIds).toEqual(expect.arrayContaining([manual.id, activeTargetId]));
      expect(report.candidateTargetIds).not.toContain(historicalId);
      expect(report.autoReviewedTargetIds).toEqual([activeTargetId]);
      expect(report.autoReviewed).toBe(1);
      expect(report.automaticMatchedTargetIds).toEqual([activeTargetId]);
      expect(report.automaticMatches).toBe(1);
      expect(report.skippedTargets).toContainEqual({
        id: manual.id,
        status: "pending",
        reason: "manual_record_preserved",
      });
      expect(report.leftPendingTargetIds).toEqual([manual.id]);

      const pendingIds = (await caller.outreachDirectory.list({ targetType: "media", status: "pending" }))
        .map((target) => target.id);
      expect(pendingIds).toEqual(expect.arrayContaining([manual.id, historicalId]));
      expect(pendingIds).not.toContain(activeTargetId);

      const repeated = await caller.outreachDirectory.discoverForCase({
        caseId: "CASE_TARGET_OWNER_B",
        targetType: "media",
        maxQueries: 1,
        maxResults: 5,
      });
      expect(repeated.createdTargetIds).toEqual([]);
      expect(repeated.refreshedTargetIds).toEqual([activeTargetId]);
      expect(repeated.autoReviewedTargetIds).toEqual([]);
      expect(repeated.skippedTargets).toEqual(expect.arrayContaining([
        { id: manual.id, status: "pending", reason: "manual_record_preserved" },
        { id: activeTargetId, status: "approved", reason: "already_approved" },
      ]));
      expect(repeated.leftPendingTargetIds).toEqual([manual.id]);
      expect(repeated.automaticMatchedTargetIds).toEqual([activeTargetId]);
    } finally {
      await caller.userPreferences.updateWorkflow({ outreachReviewMode: "each" });
    }
  });

  it("reports a partial result when provider candidates exceed the supported bound", async () => {
    const html = Array.from({ length: 62 }, (_, index) => `
      <div class="result">
        <a class="result__a" href="https://provider-bound.example.org/target-${index}">Employment Support ${index}</a>
        <div class="result__snippet">Employment support and public advocacy ${index}.</div>
      </div>`).join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    })));

    const report = await app.makeCaller(owner).outreachDirectory.discoverForCase({
      caseId: "CASE_TARGET_OWNER",
      targetType: "organization",
      maxQueries: 1,
      maxResults: 60,
    });
    expect(report).toMatchObject({
      status: "partial",
      completedQueries: 1,
      failedQueries: 0,
      supportedCandidateBound: 60,
      candidateLimit: 60,
      candidateLimitReached: true,
      providerResultTruncated: true,
      truncatedQueries: 1,
      observedCandidates: 61,
      discoveredCandidates: 60,
      omittedCandidateCountAtLeast: 2,
    });
    expect(report.createdTargetIds).toHaveLength(60);
    expect(report.leftPendingTargetIds).toHaveLength(60);
    expect(report.partialReasons).toEqual(expect.arrayContaining([
      expect.stringContaining("candidate supported bound"),
      expect.stringContaining("persisted the first 60"),
    ]));
  });
});
