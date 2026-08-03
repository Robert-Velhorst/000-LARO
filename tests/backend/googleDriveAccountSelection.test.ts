import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const googleMocks = vi.hoisted(() => ({
  credentials: [] as Array<Record<string, unknown>>,
}));

vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: vi.fn(function OAuth2() {
        return {
          setCredentials: (credentials: Record<string, unknown>) => googleMocks.credentials.push(credentials),
        };
      }),
    },
    drive: vi.fn().mockReturnValue({
      files: {
        list: vi.fn().mockResolvedValue({ data: { files: [{ id: "folder", name: "Folder" }] } }),
      },
    }),
  },
}));

const suite = sqliteAvailable ? describe : describe.skip;

suite("Google Drive account selection", () => {
  let app: TestApp;
  const userId = "USER_DRIVE_ACCOUNT_SELECTION";
  const now = new Date();

  beforeAll(async () => {
    app = await bootTestApp();
    const { encryptToken } = await import("../../server/emailOAuth");
    await app.db.insert(app.schema.users).values([
      buildUser({ id: userId }),
      buildUser({ id: "USER_OTHER_DRIVE_ACCOUNT" }),
    ]);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_DRIVE_ACCOUNT_SELECTION",
      userId,
    }));
    await app.db.insert(app.schema.emailAccounts).values([
      {
        id: "GOOGLE_DRIVE_FIRST",
        userId,
        provider: "gmail",
        email: "first@example.com",
        accessToken: encryptToken("first-access-token"),
        refreshToken: encryptToken("first-refresh-token"),
        tokenExpiry: new Date(now.getTime() + 3_600_000),
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "GOOGLE_DRIVE_SECOND",
        userId,
        provider: "gmail",
        email: "second@example.com",
        accessToken: encryptToken("second-access-token"),
        refreshToken: encryptToken("second-refresh-token"),
        tokenExpiry: new Date(now.getTime() + 3_600_000),
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "GOOGLE_DRIVE_OTHER_OWNER",
        userId: "USER_OTHER_DRIVE_ACCOUNT",
        provider: "gmail",
        email: "other@example.com",
        accessToken: encryptToken("other-access-token"),
        refreshToken: encryptToken("other-refresh-token"),
        tokenExpiry: new Date(now.getTime() + 3_600_000),
        status: "connected",
        createdAt: now,
        updatedAt: now,
      },
    ]);
  });

  afterAll(() => app?.cleanup());

  it("uses the explicitly selected owner's token", async () => {
    googleMocks.credentials.length = 0;
    const { listGoogleDriveFolders } = await import("../../server/googleDriveService");
    const folders = await listGoogleDriveFolders(userId, undefined, "GOOGLE_DRIVE_SECOND");

    expect(folders).toHaveLength(1);
    expect(googleMocks.credentials).toEqual([{ access_token: "second-access-token" }]);
  });

  it("fails closed when multiple accounts exist without a selection", async () => {
    const { listGoogleDriveFolders } = await import("../../server/googleDriveService");
    await expect(listGoogleDriveFolders(userId)).rejects.toThrow(
      "Multiple Google accounts are connected",
    );
  });

  it("cannot select another owner's Google account", async () => {
    const { listGoogleDriveFolders } = await import("../../server/googleDriveService");
    await expect(
      listGoogleDriveFolders(userId, undefined, "GOOGLE_DRIVE_OTHER_OWNER"),
    ).rejects.toThrow("Selected Google account is not connected");
  });

  it("persists the selected Drive account and folders with auto-collection settings", async () => {
    const caller = app.makeCaller({ id: userId, role: "user" });
    await expect(caller.autoCollection.upsertSettings({
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION",
      keywords: ["contract"],
      keywordMatchMode: "any",
      emailAccountIds: [],
      googleDriveAccountId: "GOOGLE_DRIVE_SECOND",
      googleDriveFolderIds: ["folder-two"],
      autoDownloadAttachments: false,
      autoDownloadGoogleDriveFiles: false,
    })).resolves.toMatchObject({ success: true });

    const result = await caller.autoCollection.getSettings({ caseId: "CASE_DRIVE_ACCOUNT_SELECTION" });
    expect(JSON.parse(result.settings.metadata)).toMatchObject({
      googleDriveAccountId: "GOOGLE_DRIVE_SECOND",
    });
    expect(JSON.parse(result.settings.googleDriveFolderIds)).toEqual(["folder-two"]);
  });

  it("rejects a Drive account owned by another user in saved settings", async () => {
    const caller = app.makeCaller({ id: userId, role: "user" });
    await expect(caller.autoCollection.upsertSettings({
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION",
      keywords: ["contract"],
      keywordMatchMode: "any",
      emailAccountIds: [],
      googleDriveAccountId: "GOOGLE_DRIVE_OTHER_OWNER",
      googleDriveFolderIds: [],
      autoDownloadAttachments: false,
      autoDownloadGoogleDriveFiles: false,
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
