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

  it("supports one-action batch review and automatic shortlist preparation", async () => {
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

    await caller.userPreferences.updateWorkflow({ outreachReviewMode: "automatic" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`
      <div class="result">
        <a class="result__a" href="https://automatic.example.nl/employment-desk">Employment Desk News</a>
        <div class="result__snippet">Public-interest employment reporting.</div>
      </div>`, { status: 200, headers: { "Content-Type": "text/html" } })));
    const report = await caller.outreachDirectory.discoverForCase({
      caseId: "CASE_TARGET_OWNER",
      targetType: "media",
      maxQueries: 1,
      maxResults: 5,
    });
    expect(report.reviewMode).toBe("automatic");
    expect(report.autoReviewed).toBeGreaterThanOrEqual(1);
    expect(report.automaticMatches).toBeGreaterThanOrEqual(1);
    expect(await caller.outreachDirectory.list({ targetType: "media", status: "pending" })).toHaveLength(0);
    await caller.userPreferences.updateWorkflow({ outreachReviewMode: "each" });
  });
});
