import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("mutation truthfulness", () => {
  let app: TestApp;
  const owner = { id: "MUTATION_OWNER", name: "Owner", role: "user", email: "owner-mutation@example.com" };
  const other = { id: "MUTATION_OTHER", name: "Other", role: "user", email: "other-mutation@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
    await app.db.insert(app.schema.cases).values(buildCase({ id: "MUTATION_CASE", userId: owner.id }));
  });

  afterAll(() => app?.cleanup());

  it("does not report successful deletion for missing owner-scoped records", async () => {
    const caller = app.makeCaller(owner);
    await expect(caller.messages.delete({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.messageTemplates.delete({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.savedSearches.delete({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.notifications.markAsRead({ notificationId: "missing" }))
      .resolves.toEqual({ success: false });
  });

  it("rejects messages that reference another user's case", async () => {
    await expect(app.makeCaller(other).messages.send({ caseId: "MUTATION_CASE", body: "Not allowed" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
