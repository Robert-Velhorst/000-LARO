import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomBytes } from "crypto";
import { buildCase, buildEvidence, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("evidence scoring and case export", () => {
  let app: TestApp;
  const owner = { id: "USR_SCORE_OWNER", name: "Owner", role: "user", email: "score-owner@example.com" };
  const other = { id: "USR_SCORE_OTHER", name: "Other", role: "user", email: "score-other@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: other.id, email: other.email }),
    ]);
    await app.db.insert(app.schema.cases).values([
      buildCase({
        id: "CASE_SCORE_OWNER",
        userId: owner.id,
        caseType: "Bestuursrecht",
        caseSummary: "Bezwaar tegen besluit van de gemeente over een uitkering",
        legalAreas: JSON.stringify(["Bestuursrecht"]),
      }),
      buildCase({ id: "CASE_SCORE_OTHER", userId: other.id }),
    ]);
  });

  afterAll(() => app?.cleanup());

  it("scores evidence against persisted case context and source-linked analysis", async () => {
    const caller = app.makeCaller(owner);
    const relevant = await caller.evidenceFiles.upload({
      caseId: "CASE_SCORE_OWNER",
      title: 'Besluit gemeente, "uitkering"',
      type: "document",
      fileName: "besluit.txt",
      mimeType: "text/plain",
      source: "manual",
      base64: Buffer.from([
        "Besluit van de gemeente Utrecht.",
        "De uitkering wordt beeindigd.",
        "U kunt binnen zes weken bezwaar maken.",
      ].join("\n")).toString("base64"),
    });
    const unrelated = await caller.evidenceFiles.upload({
      caseId: "CASE_SCORE_OWNER",
      title: "Vakantiefoto",
      type: "other",
      fileName: "vakantie.txt",
      mimeType: "text/plain",
      source: "manual",
      base64: Buffer.from("Zon zee strand en hotel.").toString("base64"),
    });
    await caller.documentAnalysis.analyzeEvidence({
      evidenceId: relevant.id,
      deepAnalysis: false,
      force: false,
    });

    const scored = await caller.relevanceScoring.batchScore({
      caseContext: { caseId: "CASE_SCORE_OWNER" },
      batchSize: 1,
    });
    expect(scored.totalScored).toBe(2);
    const relevantScore = scored.results.find((result: any) => result.itemId === relevant.id);
    const unrelatedScore = scored.results.find((result: any) => result.itemId === unrelated.id);
    expect(relevantScore.analysisAvailable).toBe(true);
    expect(relevantScore.keywords).toEqual(expect.arrayContaining(["besluit", "gemeente", "uitkering", "bezwaar"]));
    expect(relevantScore.relevanceScore).toBeGreaterThan(unrelatedScore.relevanceScore);

    const statistics = await caller.relevanceScoring.getStatistics({ caseId: "CASE_SCORE_OWNER" });
    expect(statistics.statistics.totalEvidence).toBe(2);
    expect(statistics.statistics.totalScored).toBe(2);
    expect(statistics.statistics.analyzedEvidence).toBe(1);
    expect(statistics.statistics.topKeywords.some((entry: any) => entry.keyword === "gemeente")).toBe(true);

    const [stored] = await app.db
      .select()
      .from(app.schema.evidence)
      .where(eq(app.schema.evidence.id, relevant.id));
    const metadata = JSON.parse(stored.metadata);
    expect(metadata.scoringMethod).toBe("case-context-v1");
    expect(metadata.relevanceScore).toBe(relevantScore.relevanceScore);
    const scoreAudit = await caller.audit.list({
      entityType: "case",
      entityId: "CASE_SCORE_OWNER",
      action: "evidence.scored",
    });
    expect(scoreAudit).toHaveLength(1);

    await expect(app.makeCaller(other).relevanceScoring.getStatistics({
      caseId: "CASE_SCORE_OWNER",
    })).rejects.toThrow();
  });

  it("commits relevance updates once per requested batch", async () => {
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_BATCH_SCORE_OWNER",
      userId: owner.id,
      caseSummary: "Bezwaar tegen een besluit over een uitkering",
    }));
    await app.db.insert(app.schema.evidence).values([
      buildEvidence({ id: "EVIDENCE_BATCH_SCORE_1", caseId: "CASE_BATCH_SCORE_OWNER", userId: owner.id, title: "Besluit uitkering bezwaar" }),
      buildEvidence({ id: "EVIDENCE_BATCH_SCORE_2", caseId: "CASE_BATCH_SCORE_OWNER", userId: owner.id, title: "Gemeente besluit" }),
      buildEvidence({ id: "EVIDENCE_BATCH_SCORE_3", caseId: "CASE_BATCH_SCORE_OWNER", userId: owner.id, title: "Bezwaar termijn" }),
    ]);

    const sqlite = app.db.$client as any;
    const originalTransaction = sqlite.transaction.bind(sqlite);
    let transactionCalls = 0;
    sqlite.transaction = (...args: unknown[]) => {
      transactionCalls += 1;
      return originalTransaction(...args);
    };

    try {
      const result = await app.makeCaller(owner).relevanceScoring.batchScore({
        caseContext: { caseId: "CASE_BATCH_SCORE_OWNER" },
        batchSize: 2,
      });
      expect(result.totalScored).toBe(3);
    } finally {
      sqlite.transaction = originalTransaction;
    }

    expect(transactionCalls).toBe(2);
  });

  it("exports only the selected owner's case and includes available source files", async () => {
    const caller = app.makeCaller(owner);
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "EVIDENCE_FORMULA_EXPORT",
      caseId: "CASE_SCORE_OWNER",
      userId: owner.id,
      title: '=HYPERLINK("https://attacker.invalid","Open")',
    }));
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_FORMULA_EXPORT",
      userId: owner.id,
      clientName: "=2+2",
    }));
    const csvDownload = await caller.evidenceExport.exportCSV({ caseId: "CASE_SCORE_OWNER" });
    const csv = Buffer.from(csvDownload.base64, "base64").toString("utf8");
    expect(csvDownload.filename).toBe("case-CASE_SCORE_OWNER-evidence.csv");
    expect(csv).toContain('"Besluit gemeente, ""uitkering"""');
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv).toContain("contentHash");
    expect(csv).not.toContain("CASE_SCORE_OTHER");
    const caseCsv = await caller.cases.exportCsv();
    expect(caseCsv.csv).toContain("CASE_FORMULA_EXPORT,'=2+2");

    const zipDownload = await caller.evidenceExport.exportZIP({ caseId: "CASE_SCORE_OWNER" });
    expect(zipDownload.url).toMatch(/^\/api\/case-export\/[A-Za-z0-9_-]{43}\.zip$/);
    const { createCaseZipStream } = await import("../../server/evidenceExport");
    const streamed = await createCaseZipStream(owner.id, "CASE_SCORE_OWNER");
    const chunks: Buffer[] = [];
    for await (const chunk of streamed.stream) chunks.push(Buffer.from(chunk));
    const result = await streamed.completion;
    const zip = Buffer.concat(chunks);
    const zipDirectory = zip.toString("latin1");
    expect(zip.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(zipDirectory).toContain("manifest.json");
    expect(zipDirectory).toContain("evidence.csv");
    expect(zipDirectory).toContain("analysis/");
    expect(zipDirectory).toContain("files/");
    expect(result.bytes).toBe(zip.length);
    const exportAudit = await caller.audit.list({
      entityType: "case",
      entityId: "CASE_SCORE_OWNER",
      action: "evidence.exported",
    });
    expect(exportAudit).toHaveLength(1);

    await expect(app.makeCaller(other).evidenceExport.exportZIP({
      caseId: "CASE_SCORE_OWNER",
    })).rejects.toThrow();
  });

  it("keeps ZIP output backpressure-bounded and rejects export queue overflow", async () => {
    const { storagePut } = await import("../../server/storage");
    const stored = await storagePut(
      "evidence/CASE_SCORE_OWNER/large.bin",
      randomBytes(4 * 1024 * 1024),
    );
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "EVIDENCE_LARGE_EXPORT",
      caseId: "CASE_SCORE_OWNER",
      userId: owner.id,
      title: "Large source",
      type: "document",
      fileName: "large.bin",
      mimeType: "application/octet-stream",
      source: "manual",
      fileSize: String(4 * 1024 * 1024),
      metadata: JSON.stringify({ storageKey: stored.key, contentHash: stored.sha256 }),
    }));
    const { createCaseZipStream } = await import("../../server/evidenceExport");
    const drain = async (item: Awaited<ReturnType<typeof createCaseZipStream>>) => {
      let bytes = 0;
      for await (const chunk of item.stream) bytes += Buffer.byteLength(chunk);
      const completed = await item.completion;
      expect(completed.bytes).toBe(bytes);
    };

    const first = await createCaseZipStream(owner.id, "CASE_SCORE_OWNER");
    let completed = false;
    void first.completion.then(() => { completed = true; });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
    expect(completed).toBe(false);
    expect(first.stream.readableLength).toBeLessThanOrEqual(128 * 1024);

    const secondPromise = createCaseZipStream(owner.id, "CASE_SCORE_OWNER");
    const thirdPromise = createCaseZipStream(owner.id, "CASE_SCORE_OWNER");
    await expect(createCaseZipStream(owner.id, "CASE_SCORE_OWNER"))
      .rejects.toThrow("Evidence export queue is full");
    await drain(first);
    await drain(await secondPromise);
    await drain(await thirdPromise);
  });

  it("binds ZIP tickets to one user and one use", async () => {
    const { consumeCaseZipDownloadTicket, issueCaseZipDownloadTicket } = await import("../../server/evidenceExport");
    const attacked = issueCaseZipDownloadTicket(owner.id, "CASE_SCORE_OWNER");
    expect(() => consumeCaseZipDownloadTicket(attacked, other.id)).toThrow("invalid or expired");
    expect(() => consumeCaseZipDownloadTicket(attacked, owner.id)).toThrow("invalid or expired");

    const valid = issueCaseZipDownloadTicket(owner.id, "CASE_SCORE_OWNER");
    expect(consumeCaseZipDownloadTicket(valid, owner.id)).toBe("CASE_SCORE_OWNER");
    expect(() => consumeCaseZipDownloadTicket(valid, owner.id)).toThrow("invalid or expired");
  });

  it("removes disconnected exports from the waiting queue", async () => {
    const { createCaseZipStream } = await import("../../server/evidenceExport");
    const active = await createCaseZipStream(owner.id, "CASE_SCORE_OWNER");
    const controller = new AbortController();
    const queued = createCaseZipStream(owner.id, "CASE_SCORE_OWNER", { signal: controller.signal });
    controller.abort();

    await expect(queued).rejects.toThrow("Evidence export was cancelled");
    for await (const _chunk of active.stream) { /* drain */ }
    await active.completion;
  });

  it("honors cancellation during immediate export admission", async () => {
    const { createCaseZipStream } = await import("../../server/evidenceExport");
    const controller = new AbortController();
    const exportPromise = createCaseZipStream(owner.id, "CASE_SCORE_OWNER", {
      signal: controller.signal,
    });
    controller.abort(new Error("Client disconnected during export admission"));

    await expect(exportPromise).rejects.toThrow("Client disconnected during export admission");
  });

  it("rejects highly compressible generated entries by uncompressed size", async () => {
    const evidenceId = "EVIDENCE_OVERSIZED_ANALYSIS";
    const analysisId = "ANALYSIS_OVERSIZED_EXPORT";
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: evidenceId,
      caseId: "CASE_SCORE_OWNER",
      userId: owner.id,
      title: "Oversized analysis fixture",
    }));
    await app.db.insert(app.schema.documentAnalyses).values({
      id: analysisId,
      evidenceId,
      caseId: "CASE_SCORE_OWNER",
      userId: owner.id,
      analysisVersion: "oversized-test",
      contentHash: "a".repeat(64),
      status: "complete",
      extractionMethod: "plain_text",
      providerStatus: "complete",
      documentType: "legal document",
      confidence: 100,
      summary: "Oversized fixture",
      result: "A".repeat(8 * 1024 * 1024 + 1),
      analyzedChars: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const { buildCaseCsv, createCaseZipStream } = await import("../../server/evidenceExport");
    try {
      await expect(buildCaseCsv(owner.id, "CASE_SCORE_OWNER")).resolves.toBeInstanceOf(Buffer);
      await expect(createCaseZipStream(owner.id, "CASE_SCORE_OWNER"))
        .rejects.toThrow("generated content exceeds the 64 MB processing limit");
    } finally {
      await app.db.delete(app.schema.documentAnalyses).where(eq(app.schema.documentAnalyses.id, analysisId));
      await app.db.delete(app.schema.evidence).where(eq(app.schema.evidence.id, evidenceId));
    }
  });
});
