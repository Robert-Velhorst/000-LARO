import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("bulk evidence item operations", () => {
  let app: TestApp;
  const owner = { id: "BULK_ITEMS_OWNER", name: "Bulk owner", role: "user", email: "bulk-items-owner@example.test" };
  const other = { id: "BULK_ITEMS_OTHER", name: "Bulk other", role: "user", email: "bulk-items-other@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: other.id, email: other.email }),
    ]);
    await app.db.insert(app.schema.cases).values([
      buildCase({ id: "BULK_ITEMS_CASE_OWNER", userId: owner.id }),
      buildCase({ id: "BULK_ITEMS_CASE_OTHER", userId: other.id }),
    ]);
    await app.db.insert(app.schema.evidenceItems).values([
      { id: "BULK_ITEM_1", caseId: "BULK_ITEMS_CASE_OWNER", userId: owner.id, source: "test", sourceId: "1", sourceType: "document", title: "One" },
      { id: "BULK_ITEM_2", caseId: "BULK_ITEMS_CASE_OWNER", userId: owner.id, source: "test", sourceId: "2", sourceType: "document", title: "Two" },
      { id: "BULK_ITEM_OTHER", caseId: "BULK_ITEMS_CASE_OTHER", userId: other.id, source: "test", sourceId: "3", sourceType: "document", title: "Private" },
    ] as any);
  });

  afterAll(() => app?.cleanup());

  it("updates only owned items and counts unique affected rows", async () => {
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let updates = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*update\b/i.test(statement)) updates += 1;
      return originalPrepare(statement, ...args);
    };
    let result: { updated: number };
    try {
      result = await app.makeCaller(owner).bulkFileOperations.addTags({
        ids: ["BULK_ITEM_1", "BULK_ITEM_1", "BULK_ITEM_2", "BULK_ITEM_OTHER"],
        tags: ["important"],
      });
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(result.updated).toBe(2);
    expect(updates).toBe(1);
    const rows = await app.db.select().from(app.schema.evidenceItems);
    expect(rows.find((row: any) => row.id === "BULK_ITEM_1")?.tags).toBe(JSON.stringify(["important"]));
    expect(rows.find((row: any) => row.id === "BULK_ITEM_OTHER")?.tags).not.toBe(JSON.stringify(["important"]));
  });

  it("deletes only owned items and returns the affected row count", async () => {
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let deletes = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*delete\b/i.test(statement)) deletes += 1;
      return originalPrepare(statement, ...args);
    };
    let result: { deleted: number };
    try {
      result = await app.makeCaller(owner).bulkFileOperations.deleteItems({
        ids: ["BULK_ITEM_1", "BULK_ITEM_1", "BULK_ITEM_OTHER"],
      });
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(result.deleted).toBe(1);
    expect(deletes).toBe(1);
    const rows = await app.db.select().from(app.schema.evidenceItems);
    expect(rows.some((row: any) => row.id === "BULK_ITEM_1")).toBe(false);
    expect(rows.some((row: any) => row.id === "BULK_ITEM_OTHER")).toBe(true);
  });

  it("sets relevance scores in one owner-scoped update", async () => {
    await app.db.insert(app.schema.evidenceItems).values({
      id: "BULK_ITEM_SCORE",
      caseId: "BULK_ITEMS_CASE_OWNER",
      userId: owner.id,
      source: "test",
      sourceId: "4",
      sourceType: "document",
      title: "Score",
    } as any);
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let updates = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*update\b/i.test(statement)) updates += 1;
      return originalPrepare(statement, ...args);
    };

    let result: { updated: number };
    try {
      result = await app.makeCaller(owner).bulkFileOperations.setRelevanceScore({
        ids: ["BULK_ITEM_2", "BULK_ITEM_SCORE", "BULK_ITEM_SCORE", "BULK_ITEM_OTHER"],
        score: 85,
      });
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(result.updated).toBe(2);
    expect(updates).toBe(1);
    const rows = await app.db.select().from(app.schema.evidenceItems);
    expect(rows.find((row: any) => row.id === "BULK_ITEM_SCORE")?.relevanceScore).toBe(85);
    expect(rows.find((row: any) => row.id === "BULK_ITEM_OTHER")?.relevanceScore).not.toBe(85);
  });
});
