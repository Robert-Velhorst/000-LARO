import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("clarifications query efficiency", () => {
  let app: TestApp;
  const owner = { id: "CLARIFICATIONS_QUERY_OWNER", name: "Clarifications owner", role: "user", email: "clarifications-query@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: owner.id, email: owner.email }));
    await app.db.insert(app.schema.cases).values(Array.from({ length: 25 }, (_, index) => buildCase({
      id: `CLARIFICATIONS_QUERY_CASE_${index}`,
      userId: owner.id,
      clientEmail: null,
      legalAreas: JSON.stringify(["Employment law", "Administrative law"]),
    })));
  });

  afterAll(() => app?.cleanup());

  it("loads all unresolved case clarifications with a fixed two-read budget", async () => {
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let selects = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement)) selects += 1;
      return originalPrepare(statement, ...args);
    };

    try {
      const result = await app.makeCaller(owner).clarifications.pending();
      expect(result).toHaveLength(50);
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(selects).toBe(2);
  });
});
