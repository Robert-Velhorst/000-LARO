import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "path";
import { writeFileSync } from "fs";
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
});
