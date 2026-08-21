import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCase, buildEvidence, buildUser } from "../factories";
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

  it("rejects Drive folder listings that exceed the global file budget", async () => {
    const { PROVIDER_LIMITS } = await import("../../server/providerLimits");
    googleMocks.listRequests.length = 0;
    googleMocks.listResponses.push({
      data: {
        files: Array.from(
          { length: PROVIDER_LIMITS.googleDrive.maxListedFiles + 1 },
          (_, index) => ({ id: `file-${index}`, name: `File ${index}.pdf`, mimeType: "application/pdf" }),
        ),
      },
    });
    const { getAllFilesInFolder } = await import("../../server/googleDriveService");

    await expect(getAllFilesInFolder(userId, "root", false, "GOOGLE_DRIVE_SECOND"))
      .rejects.toThrow("file limit");
    expect(googleMocks.listRequests).toHaveLength(1);
  });

  it("rejects Drive traversal after the global page budget", async () => {
    const { PROVIDER_LIMITS } = await import("../../server/providerLimits");
    googleMocks.listRequests.length = 0;
    googleMocks.listResponses.push(...Array.from(
      { length: PROVIDER_LIMITS.googleDrive.maxListPages },
      (_, index) => ({ data: { files: [], nextPageToken: `page-${index + 1}` } }),
    ));
    const { getAllFilesInFolder } = await import("../../server/googleDriveService");

    await expect(getAllFilesInFolder(userId, "root", false, "GOOGLE_DRIVE_SECOND"))
      .rejects.toThrow("page limit");
    expect(googleMocks.listRequests).toHaveLength(PROVIDER_LIMITS.googleDrive.maxListPages);
  });

  it("visits recursive Drive folders once when provider links form a cycle", async () => {
    googleMocks.listRequests.length = 0;
    googleMocks.listResponses.push(
      {
        data: {
          files: [{ id: "child-folder", name: "Child", mimeType: "application/vnd.google-apps.folder" }],
        },
      },
      {
        data: {
          files: [
            { id: "root", name: "Root", mimeType: "application/vnd.google-apps.folder" },
            { id: "cycle-file", name: "Evidence.pdf", mimeType: "application/pdf" },
          ],
        },
      },
    );
    const { getAllFilesInFolder } = await import("../../server/googleDriveService");

    const files = await getAllFilesInFolder(userId, "root", true, "GOOGLE_DRIVE_SECOND");

    expect(files.map((file) => file.id)).toEqual(["cycle-file"]);
    expect(googleMocks.listRequests).toHaveLength(2);
  });

  it("escapes folder IDs before placing them in Drive query literals", async () => {
    googleMocks.listRequests.length = 0;
    googleMocks.listResponses.push({ data: { files: [] } });
    const { getAllFilesInFolder } = await import("../../server/googleDriveService");

    await getAllFilesInFolder(userId, "folder' or trashed = true or 'x", false, "GOOGLE_DRIVE_SECOND");

    expect(googleMocks.listRequests[0].q).toBe(
      "'folder\\' or trashed = true or \\'x' in parents and trashed = false",
    );
  });

  it("rejects mismatched Drive import arrays before contacting the provider", async () => {
    const caller = app.makeCaller({ id: userId, role: "user" });

    await expect(caller.googleDrive.importFiles({
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION",
      accountId: "GOOGLE_DRIVE_SECOND",
      fileIds: ["file-one"],
      fileNames: ["One.pdf", "Two.pdf"],
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("allows large folder resyncs when every discovered file was already imported", async () => {
    const { PROVIDER_LIMITS } = await import("../../server/providerLimits");
    const count = PROVIDER_LIMITS.googleDrive.maxImportFiles + 1;
    const files = Array.from(
      { length: count },
      (_, index) => ({ id: `existing-drive-${index}`, name: `Existing ${index}.pdf`, mimeType: "application/pdf" }),
    );
    await app.db.insert(app.schema.evidence).values(files.map((file, index) => buildEvidence({
      id: `EXISTING_DRIVE_EVIDENCE_${index}`,
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION",
      userId,
      source: "google_drive",
      metadata: JSON.stringify({ driveFileId: file.id }),
    })));
    googleMocks.listRequests.length = 0;
    googleMocks.listResponses.push({ data: { files } });
    const caller = app.makeCaller({ id: userId, role: "user" });

    await expect(caller.googleDrive.importFolder({
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION",
      folderId: "incremental-folder",
      folderName: "Incremental folder",
      recursive: false,
      accountId: "GOOGLE_DRIVE_SECOND",
    })).resolves.toMatchObject({
      success: true,
      imported: 0,
      skipped: count,
    });
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
