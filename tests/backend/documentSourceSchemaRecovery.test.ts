import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

(sqliteAvailable ? describe : describe.skip)("source provenance migration recovery", () => {
  let app: TestApp;
  const owner = { id: "SOURCE_RECOVERY", email: "source-recovery@example.test", role: "user" };
  beforeAll(async () => { app = await bootTestApp(); await app.db.insert(app.schema.users).values(buildUser(owner)); });
  afterAll(() => app?.cleanup());
  it("keeps manual and trusted origins distinct across a real database reopen", async () => {
    const input = { fileName: "same.txt", sourcePath: "identical-source", mimeType: "text/plain", bytes: Buffer.from("The same source content.") };
    const { stageInboxDocument } = await import("../../server/documentInbox");
    const manual = await stageInboxDocument(owner.id, input);
    const trusted = await stageInboxDocument(owner.id, { ...input, provenance: { source: "local", objectId: "identical-source" } });
    expect(manual.id).not.toBe(trusted.id);
    const { closeDatabaseForMaintenance, getDb } = await import("../../server/db");
    closeDatabaseForMaintenance();
    const reopened = await getDb();
    expect((await reopened.select().from(app.schema.documentInbox)).map((item: any) => item.sourceType).sort()).toEqual(["local", "manual"]);
  });
});
