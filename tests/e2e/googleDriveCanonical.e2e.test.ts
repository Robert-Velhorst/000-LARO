import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const googleMocks = vi.hoisted(() => ({
  credentials: [] as Array<Record<string, unknown>>,
  listRequests: [] as Array<Record<string, unknown>>,
  listResponses: [] as Array<Record<string, unknown> | Error>,
  getRequests: [] as Array<Record<string, unknown>>,
  getResponses: [] as Array<Record<string, unknown> | Error>,
}));

function nextResponse(queue: Array<Record<string, unknown> | Error>, fallback: Record<string, unknown>) {
  const response = queue.shift() ?? fallback;
  return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
}

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
          return nextResponse(googleMocks.listResponses, { data: { files: [] } });
        }),
        get: vi.fn().mockImplementation((request: Record<string, unknown>) => {
          googleMocks.getRequests.push(request);
          return nextResponse(googleMocks.getResponses, { data: {} });
        }),
      },
    }),
  },
}));

const suite = sqliteAvailable ? describe : describe.skip;

suite("canonical Google Drive ingestion", () => {
  let app: TestApp;
  const userId = "USER_CANONICAL_DRIVE";
  const caseId = "CASE_CANONICAL_DRIVE";
  const accountId = "ACCOUNT_CANONICAL_DRIVE";
  const fileId = "DRIVE_FILE_CANONICAL";
  const callerUser = { id: userId, role: "user" };

  beforeAll(async () => {
    app = await bootTestApp();
    const { encryptToken } = await import("../../server/emailOAuth");
    await app.db.insert(app.schema.users).values(buildUser({ id: userId }));
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId }));
    await app.db.insert(app.schema.emailAccounts).values({
      id: accountId,
      userId,
      provider: "gmail",
      email: "canonical-drive@example.com",
      accessToken: encryptToken("canonical-drive-access-token"),
      refreshToken: encryptToken("canonical-drive-refresh-token"),
      tokenExpiry: new Date(Date.now() + 3_600_000),
      status: "connected",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await app.makeCaller(callerUser).userPreferences.updateWorkflow({ autoAnalyzeImports: false });
  });

  afterAll(() => app?.cleanup());

  const queueListing = (version: string, size: number) => {
    googleMocks.listResponses.push({
      data: {
        files: [{
          id: fileId,
          name: "Canonical contract.txt",
          mimeType: "text/plain",
          size: String(size),
          modifiedTime: `2026-09-${version.padStart(2, "0")}T10:00:00.000Z`,
          version,
        }],
      },
    });
  };

  const queueDownload = (version: string, body: Buffer) => {
    googleMocks.getResponses.push(
      {
        data: {
          name: "Canonical contract.txt",
          mimeType: "text/plain",
          size: String(body.length),
          modifiedTime: `2026-09-${version.padStart(2, "0")}T10:00:00.000Z`,
          version,
        },
      },
      { data: Readable.from([body]) },
    );
  };

  const pullDrive = () => app.makeCaller(callerUser).autoCollection.pullByKeywords({
    caseId,
    keywords: ["contract"],
    matchMode: "any",
    driveAccountId: accountId,
    driveFolderIds: ["root"],
    includeGmail: false,
    includeDrive: true,
    includeLocal: false,
  });

  it("creates canonical evidence, skips unchanged revisions, versions changes, and preserves the prior revision on failure", async () => {
    const firstBody = Buffer.from("canonical Drive revision one");
    queueListing("1", firstBody.length);
    queueDownload("1", firstBody);

    const first = await pullDrive();
    expect(first).toMatchObject({
      success: true,
      outcome: "completed",
      result: { driveFiles: 1, errors: [] },
    });
    let rows = await app.db.select().from(app.schema.evidence);
    expect(rows).toHaveLength(1);
    const firstMetadata = JSON.parse(rows[0].metadata || "{}");
    expect(firstMetadata).toMatchObject({
      driveFileId: fileId,
      driveAccountId: accountId,
      sourceIdentity: JSON.stringify(["google_drive", accountId, fileId]),
      sourceRevision: "drive-version:1",
      revisionNumber: 1,
      isCurrent: true,
      previousVersionIds: [],
    });
    expect(typeof firstMetadata.contentHash).toBe("string");

    const getCountAfterFirst = googleMocks.getRequests.length;
    queueListing("1", firstBody.length);
    const unchanged = await pullDrive();
    expect(unchanged).toMatchObject({
      success: true,
      outcome: "completed",
      result: {
        driveFiles: 0,
        errors: [],
        ingestion: {
          reasons: [{ source: "google_drive", code: "duplicate", count: 1 }],
        },
      },
    });
    expect(googleMocks.getRequests).toHaveLength(getCountAfterFirst);
    expect(await app.db.select().from(app.schema.evidence)).toHaveLength(1);

    const secondBody = Buffer.from("canonical Drive revision two has changed");
    queueListing("2", secondBody.length);
    queueDownload("2", secondBody);
    const changed = await pullDrive();
    expect(changed).toMatchObject({
      success: true,
      outcome: "completed",
      result: { driveFiles: 1, errors: [] },
    });
    rows = await app.db.select().from(app.schema.evidence);
    expect(rows).toHaveLength(2);
    const secondRow = rows.find((row: { metadata: string | null }) => {
      const metadata = JSON.parse(row.metadata || "{}");
      return metadata.sourceRevision === "drive-version:2";
    });
    expect(secondRow).toBeTruthy();
    const secondMetadata = JSON.parse(secondRow!.metadata || "{}");
    expect(secondMetadata).toMatchObject({
      revisionNumber: 2,
      previousVersionIds: [rows.find((row: { id: string }) => row.id !== secondRow!.id)!.id],
    });
    expect(secondMetadata.contentHash).not.toBe(firstMetadata.contentHash);

    const failedBody = Buffer.from("unavailable Drive revision three");
    queueListing("3", failedBody.length);
    googleMocks.getResponses.push(
      {
        data: {
          name: "Canonical contract.txt",
          mimeType: "text/plain",
          size: String(failedBody.length),
          modifiedTime: "2026-09-03T10:00:00.000Z",
          version: "3",
        },
      },
      new Error("provider media unavailable"),
    );
    const failed = await pullDrive();
    expect(failed.success).toBe(false);
    expect(failed.outcome).toBe("partial");
    expect(failed.result.driveFiles).toBe(0);
    expect(failed.result.errors.join(" ")).toContain("provider media unavailable");
    expect(await app.db.select().from(app.schema.evidence)).toHaveLength(2);

    queueListing("4", 7 * 1024 * 1024 + 1);
    googleMocks.getResponses.push({
      data: {
        name: "Canonical contract.txt",
        mimeType: "text/plain",
        size: String(7 * 1024 * 1024 + 1),
        modifiedTime: "2026-09-04T10:00:00.000Z",
        version: "4",
      },
    });
    const partial = await pullDrive();
    expect(partial).toMatchObject({
      success: false,
      outcome: "partial",
      result: {
        driveFiles: 0,
        ingestion: {
          reasons: [{ source: "google_drive", code: "file_too_large", count: 1 }],
        },
      },
    });
    expect(await app.db.select().from(app.schema.evidence)).toHaveLength(2);
  });
});
