import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const googleMocks = vi.hoisted(() => ({
  credentials: [] as Array<Record<string, unknown>>,
  listRequests: [] as Array<Record<string, unknown>>,
  listResponses: [] as Array<Record<string, unknown>>,
  getRequests: [] as Array<Record<string, unknown>>,
  getResponses: [] as Array<Record<string, unknown>>,
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
        list: vi.fn().mockImplementation((request: Record<string, unknown>) => {
          googleMocks.listRequests.push(request);
          return Promise.resolve(
            googleMocks.listResponses.shift() ?? { data: { files: [{ id: "folder", name: "Folder" }] } },
          );
        }),
        get: vi.fn().mockImplementation((request: Record<string, unknown>) => {
          googleMocks.getRequests.push(request);
          return Promise.resolve(googleMocks.getResponses.shift() ?? { data: {} });
        }),
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

  it("rejects oversized Drive files from metadata before downloading media", async () => {
    googleMocks.getRequests.length = 0;
    googleMocks.getResponses.push({
      data: {
        name: "oversized.pdf",
        mimeType: "application/pdf",
        size: String(7 * 1024 * 1024 + 1),
      },
    });
    const { downloadAndUploadGoogleDriveFile } = await import("../../server/googleDriveService");

    await expect(downloadAndUploadGoogleDriveFile(
      "OVERSIZED_FILE",
      "CASE_DRIVE_ACCOUNT_SELECTION",
      userId,
      "GOOGLE_DRIVE_FIRST",
    )).rejects.toThrow("Google Drive file exceeds the 7 MB evidence limit");
    expect(googleMocks.getRequests).toHaveLength(1);
    expect(googleMocks.getRequests[0]).not.toHaveProperty("alt", "media");
  });

  it("reads every Drive listing page before returning folder files", async () => {
    googleMocks.listRequests.length = 0;
    googleMocks.listResponses.push(
      {
        data: {
          files: [{ id: "file-page-one", name: "Page one.pdf", mimeType: "application/pdf" }],
          nextPageToken: "drive-page-two",
        },
      },
      {
        data: {
          files: [{ id: "file-page-two", name: "Page two.pdf", mimeType: "application/pdf" }],
        },
      },
    );
    const { getAllFilesInFolder } = await import("../../server/googleDriveService");
    const files = await getAllFilesInFolder(userId, "root", false, "GOOGLE_DRIVE_SECOND");

    expect(files.map((file) => file.id)).toEqual(["file-page-one", "file-page-two"]);
    expect(googleMocks.listRequests).toHaveLength(2);
    expect(googleMocks.listRequests[1]).toMatchObject({ pageToken: "drive-page-two" });
  });

  it("finds exact Drive names globally across every result page", async () => {
    googleMocks.listRequests.length = 0;
    googleMocks.listResponses.push(
      {
        data: {
          files: [{ id: "exact-page-one", name: "Court's file.pdf", mimeType: "application/pdf" }],
          nextPageToken: "exact-page-two",
        },
      },
      {
        data: {
          files: [{ id: "exact-page-two", name: "Court's file.pdf", mimeType: "application/pdf" }],
        },
      },
    );
    const { findGoogleDriveFilesByExactName } = await import("../../server/googleDriveService");
    const files = await findGoogleDriveFilesByExactName(
      userId,
      "Court's file.pdf",
      "GOOGLE_DRIVE_SECOND",
    );

    expect(files.map((file) => file.id)).toEqual(["exact-page-one", "exact-page-two"]);
    expect(googleMocks.listRequests[0].q).toContain("name = 'Court\\'s file.pdf'");
    expect(googleMocks.listRequests[1]).toMatchObject({ pageToken: "exact-page-two" });
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
