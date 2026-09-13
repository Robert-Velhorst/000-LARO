import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("hybrid case search efficiency", () => {
  let app: TestApp;
  const owner = { id: "HYBRID_SEARCH_OWNER", name: "Search owner", role: "user", email: "hybrid-search@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: owner.id, email: owner.email }));
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "HYBRID_SEARCH_CASE",
      userId: owner.id,
      clientName: "Dismissal appeal",
      caseSummary: "Unfair dismissal appeal after employment termination",
    }));
  });

  afterAll(() => app?.cleanup());

  it("searches all heuristic terms in one case query plus preferences and the global fallback", async () => {
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let selects = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement)) selects += 1;
      return originalPrepare(statement, ...args);
    };

    try {
      const result = await app.makeCaller(owner).search.hybridCases({ query: "unfair dismissal appeal" });
      expect(result).toContain("HYBRID_SEARCH_CASE");
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(selects).toBe(3);
  });
});
