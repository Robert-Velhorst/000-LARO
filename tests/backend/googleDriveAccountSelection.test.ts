import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
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

  it("does not request Drive media after the cumulative job budget rejects metadata", async () => {
    googleMocks.getRequests.length = 0;
    googleMocks.getResponses.push({
      data: { name: "budgeted.pdf", mimeType: "application/pdf", size: "2" },
    });
    const { EvidenceIngestionBudget } = await import("../../server/evidenceIngestionBudget");
    const { downloadAndUploadGoogleDriveFile } = await import("../../server/googleDriveService");
    const budget = new EvidenceIngestionBudget(undefined, {
      maxFileBytes: 7 * 1024 * 1024,
      maxJobBytes: 1,
      maxJobItems: 10,
      maxConcurrentOperations: 2,
      maxAnalysisItems: 2,
      minLocalStorageHeadroomBytes: 0,
    });

    await expect(downloadAndUploadGoogleDriveFile(
      "BUDGETED_FILE",
      "CASE_DRIVE_ACCOUNT_SELECTION",
      userId,
      "GOOGLE_DRIVE_FIRST",
      { budget },
    )).rejects.toThrow("ingestion reached");
    expect(googleMocks.getRequests).toHaveLength(1);
    expect(googleMocks.getRequests[0]).not.toHaveProperty("alt", "media");
    expect(budget.summary()).toMatchObject({
      outcome: "partial",
      processedItems: 0,
      reasons: [{ source: "google_drive", code: "job_byte_limit", count: 1 }],
    });
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

  it("returns bounded partial completion instead of downloading beyond the Drive import budget", async () => {
    const { PROVIDER_LIMITS } = await import("../../server/providerLimits");
    const count = PROVIDER_LIMITS.googleDrive.maxImportFiles + 1;
    googleMocks.getRequests.length = 0;
    googleMocks.getResponses.push(...Array.from({ length: PROVIDER_LIMITS.googleDrive.maxImportFiles }, (_, index) => [
      { data: { name: `bounded-${index}.mp4`, mimeType: "video/mp4", size: "1" } },
      { data: Readable.from([Buffer.from([index])]) },
    ]).flat());
    const caller = app.makeCaller({ id: userId, role: "user" });

    const result = await caller.googleDrive.importFiles({
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION",
      accountId: "GOOGLE_DRIVE_SECOND",
      fileIds: Array.from({ length: count }, (_, index) => `bounded-file-${index}`),
      fileNames: Array.from({ length: count }, (_, index) => `bounded-${index}.mp4`),
    });

    expect(result).toMatchObject({
      success: false,
      outcome: "partial",
      imported: PROVIDER_LIMITS.googleDrive.maxImportFiles,
      errors: [],
      ingestion: {
        processedItems: PROVIDER_LIMITS.googleDrive.maxImportFiles,
        skippedItems: 1,
        reasons: [{ source: "google_drive", code: "job_item_limit", count: 1 }],
      },
    });
    expect(googleMocks.getRequests).toHaveLength(PROVIDER_LIMITS.googleDrive.maxImportFiles * 2);
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

  it("stores and runs two Drive selections with their own folders and credentials", async () => {
    const caller = app.makeCaller({ id: userId, role: "user" });
    const sources = [
      { accountId: "GOOGLE_DRIVE_FIRST", folderIds: ["folder-a"], folderNames: ["Legal A"] },
      { accountId: "GOOGLE_DRIVE_SECOND", folderIds: ["folder-b"], folderNames: ["Legal B"] },
    ];
    googleMocks.credentials.length = 0;
    googleMocks.listRequests.length = 0;
    googleMocks.listResponses.splice(0, Infinity, { data: { files: [] } }, { data: { files: [] } });
    const saved = await caller.autoCollection.upsertSettings({
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION", keywords: ["contract"], keywordMatchMode: "any",
      emailAccountIds: [], googleDriveSources: sources,
      autoDownloadAttachments: false, autoDownloadGoogleDriveFiles: true,
    });
    expect(saved.runResult?.errors).toEqual([]);
    expect(googleMocks.credentials).toEqual([
      { access_token: "first-access-token" }, { access_token: "second-access-token" },
    ]);
    expect(googleMocks.listRequests.map((request) => request.q)).toEqual([
      "'folder-a' in parents and trashed = false", "'folder-b' in parents and trashed = false",
    ]);
    const result = await caller.autoCollection.getSettings({ caseId: "CASE_DRIVE_ACCOUNT_SELECTION" });
    expect(JSON.parse(result.settings.metadata).googleDriveSources).toEqual(sources);
    expect(result.settings.googleDriveFolderIds).toBeNull();
  });

  it("does not fall back to root or old folders when the selection is explicitly empty", async () => {
    googleMocks.credentials.length = 0;
    const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
    const result = await pullEvidenceByKeywords({
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION", userId, keywords: ["contract"],
      driveSources: [], includeGmail: false, includeLocal: false,
    });
    expect(result.errors).toEqual([]);
    expect(googleMocks.credentials).toEqual([]);
  });

  it("rejects a mixed-owner Drive selection before accessing any account", async () => {
    googleMocks.credentials.length = 0;
    const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
    await expect(pullEvidenceByKeywords({
      caseId: "CASE_DRIVE_ACCOUNT_SELECTION", userId, keywords: ["contract"],
      driveSources: [
        { accountId: "GOOGLE_DRIVE_FIRST", folderIds: ["folder-a"] },
        { accountId: "GOOGLE_DRIVE_OTHER_OWNER", folderIds: ["folder-b"] },
      ], includeGmail: false, includeLocal: false,
    })).rejects.toThrow("Selected Google Drive account is unavailable");
    expect(googleMocks.credentials).toEqual([]);
  });

  it("rejects empty-folder and duplicate-account multi-source selections", async () => {
    const { googleDriveSourcesSchema, savedGoogleDriveSources } = await import("../../shared/googleDriveSources");
    expect(googleDriveSourcesSchema.safeParse([{ accountId: "a", folderIds: [] }]).success).toBe(false);
    expect(googleDriveSourcesSchema.safeParse([
      { accountId: "a", folderIds: ["one"] }, { accountId: "a", folderIds: ["two"] },
    ]).success).toBe(false);
    expect(() => savedGoogleDriveSources('{"googleDriveSources":null}')).toThrow();
  });

  it("reconnecting the same email preserves its refresh grant and other accounts", async () => {
    const { saveEmailAccount } = await import("../../server/oauth2");
    const { decryptToken } = await import("../../server/emailOAuth");
    const id = await saveEmailAccount(userId, "gmail", {
      accessToken: "renewed-first", expiresIn: 3600, tokenType: "Bearer",
    }, { email: " FIRST@example.com " });
    expect(id).toBe("GOOGLE_DRIVE_FIRST");
    const accounts = await app.db.select().from(app.schema.emailAccounts);
    expect(decryptToken(accounts.find((account: any) => account.id === id).refreshToken)).toBe("first-refresh-token");
    expect(decryptToken(accounts.find((account: any) => account.id === "GOOGLE_DRIVE_SECOND").accessToken)).toBe("second-access-token");
  });

  it("adding a different email creates a separate account without replacing existing grants", async () => {
    const { saveEmailAccount } = await import("../../server/oauth2");
    const { decryptToken } = await import("../../server/emailOAuth");
    const id = await saveEmailAccount(userId, "gmail", {
      accessToken: "third-access", refreshToken: "third-refresh", expiresIn: 3600, tokenType: "Bearer",
    }, { email: "third@example.com" });
    const accounts = await app.db.select().from(app.schema.emailAccounts);
    expect(accounts.filter((account: any) => account.userId === userId)).toHaveLength(3);
    expect(decryptToken(accounts.find((account: any) => account.id === id).accessToken)).toBe("third-access");
    expect(decryptToken(accounts.find((account: any) => account.id === "GOOGLE_DRIVE_SECOND").accessToken)).toBe("second-access-token");
    const listed = await app.makeCaller({ id: userId, role: "user" }).emailAccounts.list();
    expect(listed).toHaveLength(3);
    expect(JSON.stringify(listed)).not.toContain("accessToken");
    expect(JSON.stringify(listed)).not.toContain("other@example.com");
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
