import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("outreach directory query efficiency", () => {
  let app: TestApp;
  const owner = { id: "OUTREACH_DIRECTORY_QUERY_OWNER", name: "Query owner", role: "user", email: "outreach-directory-query@example.test" };
  const caseId = "OUTREACH_DIRECTORY_QUERY_CASE";

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: owner.id, email: owner.email }));
    await app.db.insert(app.schema.cases).values(buildCase({
      id: caseId,
      userId: owner.id,
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => app?.cleanup());

  it("loads existing directory targets once before persisting multiple discoveries", async () => {
    let responseIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      responseIndex += 1;
      return new Response(`
        <div class="result">
          <a class="result__a" href="https://example.test/outreach-${responseIndex}-a">Outreach ${responseIndex} A</a>
          <div class="result__snippet">Employment support and public advocacy.</div>
        </div>
        <div class="result">
          <a class="result__a" href="https://example.test/outreach-${responseIndex}-b">Outreach ${responseIndex} B</a>
          <div class="result__snippet">Employment advice and civil-society support.</div>
        </div>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }));

    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let targetReads = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement) && /\bfrom\s+["`]outreach_directory_targets["`]/i.test(statement)) {
        targetReads += 1;
      }
      return originalPrepare(statement, ...args);
    };

    try {
      const report = await app.makeCaller(owner).outreachDirectory.discoverForCase({
        caseId,
        targetType: "organization",
        maxQueries: 2,
        maxResults: 10,
      });
      expect(report).toMatchObject({
        completedQueries: 2,
        discoveredCandidates: 4,
        newCandidates: 4,
        existingCandidates: 0,
      });
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(targetReads).toBe(1);
    expect(await app.makeCaller(owner).outreachDirectory.list({ targetType: "organization", status: "pending" })).toHaveLength(4);
  });
});
