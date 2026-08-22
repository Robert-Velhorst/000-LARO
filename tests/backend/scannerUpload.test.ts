import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("desktop evidence scanner upload contract", () => {
  let app: TestApp;
  const user = buildUser({ id: "USER_SCANNER", email: "scanner@example.com" });
  const otherUser = buildUser({ id: "USER_OTHER", email: "other@example.com" });
  const caseRow = buildCase({ id: "CASE_SCANNER", userId: user.id });

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([user, otherUser]);
    await app.db.insert(app.schema.cases).values(caseRow);
  });

  afterAll(() => app?.cleanup());

  it("does not expose reusable API or scanner tokens to authenticated clients", () => {
    const auth = app.makeCaller(user).auth;
    expect("getScannerToken" in auth).toBe(false);
    expect("getApiToken" in auth).toBe(false);
  });

  it("persists scanner bytes with provenance under the owned case", async () => {
    const bytes = Buffer.from("scanner evidence body", "utf8");
    const scanner = app.makeCaller(user, "session", true);
    const result = await scanner.evidenceFiles.upload({
      caseId: caseRow.id,
      title: "statement.txt",
      type: "document",
      fileName: "statement.txt",
      mimeType: "text/plain",
      source: "desktop_scanner",
      base64: bytes.toString("base64"),
    });

    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    expect(result.sha256).toBe(expectedHash);

    const row = (await app.makeCaller(user).evidenceFiles.get({ id: result.id })) as any;
    expect(row.caseId).toBe(caseRow.id);
    expect(row.userId).toBe(user.id);
    expect(row.source).toBe("desktop_scanner");
    expect(row.contentHash).toBe(expectedHash);

    const storageKey = JSON.parse(row.metadata).storageKey as string;
    const storedPath = join(app.tmpDir, "uploads", ...storageKey.split("/"));
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath)).toEqual(bytes);

    await expect(app.makeCaller(user).evidenceFiles.upload({
      caseId: caseRow.id,
      title: "spoofed.txt",
      type: "document",
      fileName: "spoofed.txt",
      mimeType: "text/plain",
      source: "desktop_scanner",
      base64: Buffer.from("spoofed").toString("base64"),
    })).rejects.toThrow("requires a scanner credential");
  });

  it("rejects unsupported types and cross-owner uploads", async () => {
    const payload = {
      caseId: caseRow.id,
      title: "unsafe.exe",
      type: "other" as const,
      fileName: "unsafe.exe",
      mimeType: "application/x-msdownload",
      base64: Buffer.from("MZ").toString("base64"),
    };
    await expect(app.makeCaller(user).evidenceFiles.upload(payload)).rejects.toThrow("not supported");
    await expect(app.makeCaller(otherUser).evidenceFiles.upload({
      ...payload,
      title: "note.txt",
      fileName: "note.txt",
      mimeType: "text/plain",
    })).rejects.toThrow();
  });
});
