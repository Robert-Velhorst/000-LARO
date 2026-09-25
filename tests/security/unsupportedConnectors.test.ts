import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("retired connector surfaces", () => {
  let app: TestApp;
  const owner = { id: "UNSUPPORTED_CONNECTOR_OWNER", role: "user", email: "retired@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(() => app?.cleanup());

  it("does not mount Trello or Telegram procedures", async () => {
    const { appRouter } = await import("../../server/routers");
    const procedures = (appRouter as any)._def.procedures as Record<string, unknown>;
    const connectorProcedures = Object.keys(procedures)
      .filter((name) => /^(trello|trelloEnhanced|telegramEnhanced)\./.test(name));

    expect(connectorProcedures).toEqual([]);
  });

  it("reports both retired providers as unsupported, never configured", async () => {
    const checklist = await app.makeCaller(owner).system.providerChecklist();
    const retired = checklist.items.filter((item) => ["Trello", "Telegram"].includes(item.provider));

    expect(retired).toHaveLength(2);
    expect(retired).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "Trello", configured: false, requiredEnv: [] }),
      expect.objectContaining({ provider: "Telegram", configured: false, requiredEnv: [] }),
    ]));
    expect(retired.every((item) => item.note?.includes("Unsupported in this release"))).toBe(true);
  });
});
