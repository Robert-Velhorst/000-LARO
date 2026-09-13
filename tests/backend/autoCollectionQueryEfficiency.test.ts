import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("auto-collection query efficiency", () => {
  let app: TestApp;
  const user = { id: "AUTO_COLLECTION_QUERY_OWNER", name: "Query owner", role: "user", email: "auto-collection-query@example.test" };
  let caseId: string;
  let previousScanRoots: string | undefined;

  beforeAll(async () => {
    app = await bootTestApp();
    previousScanRoots = process.env.LOCAL_SCAN_ROOTS;
    process.env.LOCAL_SCAN_ROOTS = app.tmpDir;
    await app.db.insert(app.schema.users).values(buildUser({ id: user.id, email: user.email }));
    const created = await app.makeCaller(user).cases.create({
      clientName: "Collection query client",
      clientEmail: "collection-query@example.test",
      caseType: "Contract",
      caseSummary: "Contract document collection",
      urgency: "Medium",
    });
    caseId = created.id;
  });

  afterAll(() => {
    if (previousScanRoots === undefined) delete process.env.LOCAL_SCAN_ROOTS;
    else process.env.LOCAL_SCAN_ROOTS = previousScanRoots;
    app?.cleanup();
  });

  it("loads existing local evidence once before ingesting matching files", async () => {
    for (let index = 1; index <= 3; index += 1) {
      writeFileSync(join(app.tmpDir, `contract-evidence-${index}.bin`), `document ${index}`);
    }

    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let evidenceReads = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement) && /\bfrom\s+["`]evidence["`]/i.test(statement)) {
        evidenceReads += 1;
      }
      return originalPrepare(statement, ...args);
    };

    try {
      const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
      const result = await pullEvidenceByKeywords({
        caseId,
        userId: user.id,
        keywords: ["contract"],
        includeGmail: false,
        includeDrive: false,
        includeLocal: true,
        localFolderPaths: [app.tmpDir],
      });
      expect(result.localFiles).toBe(3);
    } finally {
      sqlite.prepare = originalPrepare;
    }

    expect(evidenceReads).toBe(1);
  });

  it("issues one Gmail search request for a keyword pull", async () => {
    const { encryptToken } = await import("../../server/emailOAuth");
    await app.db.insert(app.schema.emailAccounts).values({
      id: "AUTO_COLLECTION_QUERY_GMAIL",
      userId: user.id,
      provider: "gmail",
      email: user.email,
      accessToken: encryptToken("test-access-token"),
      tokenExpiry: new Date(Date.now() + 60 * 60 * 1000),
      status: "connected",
      connectedAt: new Date(),
    });
    const requestedUrls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    try {
      const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
      const result = await pullEvidenceByKeywords({
        caseId,
        userId: user.id,
        keywords: ["contract"],
        includeGmail: true,
        includeDrive: false,
        includeLocal: false,
      });
      expect(result.gmailMessages).toBe(0);
      expect(result.errors).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("/messages?");
    expect(requestedUrls[0]).toContain("q=%28contract%29");
  });

  it("does not ingest its own stored copies when scanning a parent directory again", async () => {
    const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
    const result = await pullEvidenceByKeywords({
      caseId, userId: user.id, keywords: ["contract-evidence"],
      includeGmail: false, includeDrive: false, includeLocal: true,
      localFolderPaths: [app.tmpDir],
    });
    expect(result.errors).toEqual([]);
    expect(result.localFiles).toBe(0);
  });

  it("preserves changed local files as new versions and leaves unchanged versions alone", async () => {
    await app.makeCaller(user).userPreferences.updateWorkflow({ autoAnalyzeImports: false });
    const directory = join(app.tmpDir, "versions");
    mkdirSync(directory);
    const source = join(directory, "contract-version.txt");
    writeFileSync(source, "Original contract statement");
    const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
    const pull = () => pullEvidenceByKeywords({
      caseId, userId: user.id, keywords: ["contract-version"],
      includeGmail: false, includeDrive: false, includeLocal: true,
      localFolderPaths: [directory, directory],
    });
    expect((await pull()).localFiles).toBe(1);
    expect((await pull()).localFiles).toBe(0);
    writeFileSync(source, "Corrected contract statement");
    expect((await pull()).localFiles).toBe(1);
    expect((await pull()).localFiles).toBe(0);
    const rows = (await app.makeCaller(user).evidenceFiles.byCase({ caseId }))
      .filter((row: any) => row.title === "contract-version.txt");
    expect(rows).toHaveLength(2);
    const { storageRead } = await import("../../server/storage");
    const texts = await Promise.all(rows.map(async (row: any) =>
      (await storageRead(JSON.parse(row.metadata).storageKey)).toString("utf8")));
    expect(texts.sort()).toEqual(["Corrected contract statement", "Original contract statement"]);
  });

  it("reports a partial scan when files are below the depth limit", async () => {
    const root = join(app.tmpDir, "deep-scan");
    const nested = join(root, ...Array.from({ length: 8 }, (_, index) => `level-${index}`));
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "contract-hidden.txt"), "Source beyond depth limit");
    const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
    const result = await pullEvidenceByKeywords({
      caseId, userId: user.id, keywords: ["contract-hidden"],
      includeGmail: false, includeDrive: false, includeLocal: true,
      localFolderPaths: [root],
    });
    expect(result.localFiles).toBe(0);
    expect(result.errors.join(" ")).toMatch(/partial.*depth/i);
  });

  it("reads workflow preferences once for a multi-file pull", async () => {
    await app.makeCaller(user).userPreferences.updateWorkflow({ autoAnalyzeImports: false });
    const analysisDirectory = join(app.tmpDir, "preference-read");
    mkdirSync(analysisDirectory);
    for (let index = 1; index <= 3; index += 1) {
      writeFileSync(join(analysisDirectory, `contract-analysis-${index}.txt`), `contract evidence ${index}`);
    }
    const sqlite: any = app.db.$client;
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let preferenceReads = 0;
    sqlite.prepare = (statement: string, ...args: unknown[]) => {
      if (/^\s*select\b/i.test(statement) && /\bfrom\s+["`]user_preferences["`]/i.test(statement)) preferenceReads += 1;
      return originalPrepare(statement, ...args);
    };
    try {
      const { pullEvidenceByKeywords } = await import("../../server/autoCollectionService");
      const result = await pullEvidenceByKeywords({ caseId, userId: user.id, keywords: ["contract"], includeGmail: false, includeDrive: false, includeLocal: true, localFolderPaths: [analysisDirectory] });
      expect(result.localFiles).toBe(3);
    } finally {
      sqlite.prepare = originalPrepare;
    }
    expect(preferenceReads).toBe(1);
  });
});
