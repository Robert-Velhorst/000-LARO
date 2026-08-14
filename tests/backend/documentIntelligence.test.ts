import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { analyzeDocumentBytes, extractDocumentText, findingHasLiteralSourceSupport } from "../../server/documentIntelligence";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;
const OCR_FIXTURE = readFileSync(join(__dirname, "..", "fixtures", "ocr-dutch-decision.png"));

function imageOnlyPdf(png: Buffer): Buffer {
  let offset = 8;
  const idat: Buffer[] = [];
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const image = Buffer.concat(idat);
  const draw = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${width} >> /Length ${image.length} >>\nstream\n`),
      image,
      Buffer.from("\nendstream"),
    ]),
    Buffer.concat([Buffer.from(`<< /Length ${draw.length} >>\nstream\n`), draw, Buffer.from("\nendstream")]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const objectOffsets = [0];
  let bytes = parts[0].length;
  objects.forEach((object, index) => {
    objectOffsets.push(bytes);
    const wrapped = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    parts.push(wrapped);
    bytes += wrapped.length;
  });
  const xrefOffset = bytes;
  const xref = ["xref", `0 ${objects.length + 1}`, "0000000000 65535 f ", ...objectOffsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n `)].join("\n");
  parts.push(Buffer.from(`${xref}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

describe("document intelligence units", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("extracts clean HTML text without executable content", async () => {
    const extracted = await extractDocumentText(
      Buffer.from("<p>Decision dated 2026-07-14.</p><script>steal()</script><p>Amount EUR 250.</p>"),
      "text/html"
    );
    expect(extracted.method).toBe("html");
    expect(extracted.text).toContain("Decision dated 2026-07-14.");
    expect(extracted.text).toContain("Amount EUR 250.");
    expect(extracted.text).not.toContain("steal()");
  });

  it("produces deterministic findings whose citations resolve to source spans", async () => {
    const analysis = await analyzeDocumentBytes({
      bytes: Buffer.from([
        "Van: Gemeente Utrecht",
        "Aan: Jan de Vries",
        "Besluit van 14 juli 2026.",
        "De gemeente stelt dat EUR 1.250,00 verschuldigd is.",
        "U moet binnen 6 weken bezwaar maken.",
      ].join("\n")),
      mimeType: "text/plain",
      deepAnalysis: false,
    });
    const citationIds = new Set(analysis.citations.map((citation) => citation.id));
    expect(analysis.documentType).toBe("administrative decision");
    expect(analysis.dates.length).toBeGreaterThan(0);
    expect(analysis.amounts.length).toBeGreaterThan(0);
    expect(analysis.claims.length).toBeGreaterThan(0);
    expect(analysis.obligations.length).toBeGreaterThan(0);
    expect(analysis.analyzedWords).toBeGreaterThan(0);
    expect(analysis.timelineEvents.length).toBeGreaterThan(0);
    expect(analysis.timelineEvents[0].date).toBe("2026-07-14");
    for (const finding of [
      ...analysis.parties,
      ...analysis.dates,
      ...analysis.amounts,
      ...analysis.claims,
      ...analysis.obligations,
      ...analysis.legalIssues,
      ...analysis.riskFlags,
      ...analysis.timelineEvents,
    ]) {
      expect(finding.citations.length).toBeGreaterThan(0);
      expect(finding.citations.every((id) => citationIds.has(id))).toBe(true);
    }
  });

  it("extracts Dutch image text locally and keeps OCR findings source-linked", async () => {
    const analysis = await analyzeDocumentBytes({
      bytes: OCR_FIXTURE,
      mimeType: "image/png",
      deepAnalysis: false,
    });

    expect(analysis.extractionMethod).toBe("ocr_text");
    expect(analysis.extractionConfidence).toBeGreaterThan(80);
    expect(analysis.summary).toContain("Besluit 14 juli 2026 EUR 1250");
    expect(analysis.dates[0]?.normalized).toBe("2026-07-14");
    expect(analysis.amounts.length).toBeGreaterThan(0);
    expect(analysis.timelineEvents[0]?.citations.length).toBeGreaterThan(0);
  }, 60_000);

  it("renders and OCRs image-only PDF pages without manual conversion", async () => {
    const extracted = await extractDocumentText(imageOnlyPdf(OCR_FIXTURE), "application/pdf");
    expect(extracted.method).toBe("pdf_ocr");
    expect(extracted.confidence).toBeGreaterThan(75);
    expect(extracted.text).toContain("[PDF page 1]");
    expect(extracted.text).toMatch(/14 juli 2026/i);
    expect(extracted.text).toMatch(/1250/);
  }, 120_000);

  it("rejects a real citation when the finding invents a material date or amount", () => {
    const citation = {
      id: "src-1",
      quote: "Het besluit is genomen op 14 juli 2026 en vermeldt EUR 1.250,00.",
      start: 0,
      end: 66,
      lineStart: 1,
      lineEnd: 1,
    };
    const citationMap = new Map([[citation.id, citation]]);
    expect(findingHasLiteralSourceSupport({
      text: "Het besluit is genomen op 14 juli 2026 en vermeldt EUR 1.250,00.",
      citations: [citation.id],
      evidenceQuotes: [citation.quote],
    }, citationMap)).toBe(true);
    expect(findingHasLiteralSourceSupport({
      text: "Het besluit is genomen op 18 juli 2026 en vermeldt EUR 9.000,00.",
      citations: [citation.id],
      evidenceQuotes: [citation.quote],
    }, citationMap)).toBe(false);
  });

  it("analyzes every source chunk instead of truncating provider input", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const source = String(body.messages[1].content);
      const match = source.match(/\[(src-\d+)\] ([^\n]+)/);
      if (!match) throw new Error("Missing cited source in provider request");
      const evidenceQuote = match[2].slice(0, 180);
      return new Response(JSON.stringify({
        id: "chunk-result",
        created: 1,
        model: "test-model",
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: JSON.stringify({
            summary: evidenceQuote,
            summaryCitations: [match[1]],
            summaryEvidenceQuotes: [evidenceQuote],
            documentType: "legal document",
            legalIssues: [], parties: [], claims: [], obligations: [], riskFlags: [], timelineEvents: [], contradictions: [],
          }) },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const source = Array.from({ length: 180 }, (_, index) =>
      `Section ${index + 1}: ${"supporting legal evidence ".repeat(35)}.`).join("\n");

    const analysis = await analyzeDocumentBytes({
      bytes: Buffer.from(source),
      mimeType: "text/plain",
      deepAnalysis: true,
      provider: "openai",
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(analysis.providerStatus).toBe("complete");
    expect(analysis.truncated).toBe(false);
    expect(analysis.coverage).toMatchObject({
      sourceChars: source.length,
      analyzedChars: source.length,
      sourceChunks: fetchMock.mock.calls.length,
      analyzedChunks: fetchMock.mock.calls.length,
      complete: true,
    });
  });
});

suite("persisted document analysis and source-linked timeline", () => {
  let app: TestApp;
  const owner = { id: "USR_DOC_OWNER", name: "Owner", role: "user", email: "owner-doc@example.com" };
  const other = { id: "USR_DOC_OTHER", name: "Other", role: "user", email: "other-doc@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: other.id, email: other.email }),
    ]);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_DOC_ANALYSIS",
      userId: owner.id,
      caseType: "Administrative Law",
    }));
  });

  afterAll(() => app?.cleanup());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("stores source bytes, persists one versioned analysis, caches it, and generates linked events", async () => {
    const sourceText = [
      "Van: Gemeente Utrecht",
      "Aan: Jan de Vries",
      "Besluit van 14 juli 2026.",
      "De gemeente stelt dat EUR 1.250,00 verschuldigd is.",
      "U moet binnen 6 weken bezwaar maken.",
    ].join("\n");
    const caller = app.makeCaller(owner);
    const uploaded = await caller.evidenceFiles.upload({
      caseId: "CASE_DOC_ANALYSIS",
      title: "Besluit gemeente.txt",
      type: "document",
      fileName: "besluit-gemeente.txt",
      mimeType: "text/plain",
      source: "manual",
      base64: Buffer.from(sourceText).toString("base64"),
    });

    const first = await caller.documentAnalysis.analyzeEvidence({
      evidenceId: uploaded.id,
      deepAnalysis: false,
      force: false,
    });
    expect(first.cached).toBe(false);
    expect(first.result.providerStatus).toBe("not_requested");
    expect(first.result.summary).toContain("Gemeente Utrecht");

    const persisted = await app.db
      .select()
      .from(app.schema.documentAnalyses)
      .where(eq(app.schema.documentAnalyses.evidenceId, uploaded.id));
    expect(persisted).toHaveLength(1);
    expect(persisted[0].contentHash).toBe(uploaded.sha256);

    const second = await caller.documentAnalysis.analyzeEvidence({
      evidenceId: uploaded.id,
      deepAnalysis: false,
      force: false,
    });
    expect(second.cached).toBe(true);
    expect(second.id).toBe(first.id);

    const timeline = await caller.documentAnalysis.generateCaseTimeline({ caseId: "CASE_DOC_ANALYSIS" });
    expect(timeline.events.length).toBeGreaterThan(0);
    expect(timeline.events[0].source.evidenceId).toBe(uploaded.id);
    expect(timeline.events[0].date).toBe("2026-07-14");
    expect(timeline.events[0].source.title).toBe("Besluit gemeente.txt");
    expect(timeline.events[0].source.citation?.quote).toContain("14 juli 2026");
    expect(timeline.reconstruction.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: uploaded.id, title: "Besluit gemeente.txt", analysisStatus: "complete" }),
    ]));
    expect(timeline.reconstruction.nodes[0].summary).toContain("Gemeente Utrecht");
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai" });
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    const correctionFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
      id: "timeline-correction-response",
      created: 1,
      model: "test-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: JSON.stringify({
            operation: "update",
            targetEventId: "E1",
            sourceDocumentId: null,
            date: "2026-07-15",
            title: "Corrected decision date",
            description: "The decision date was corrected by the owner.",
            actor: "Gemeente Utrecht",
            category: "legal",
            reason: "The owner requested a corrected decision date.",
          }),
        },
        finish_reason: "stop",
      }],
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "timeline-correction-response-2",
        created: 2,
        model: "test-model",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              operation: "update",
              targetEventId: "E1",
              sourceDocumentId: null,
              date: "2026-07-16",
              title: "Final corrected decision date",
              description: "The owner corrected the decision date a second time.",
              actor: "Gemeente Utrecht",
              category: "legal",
              reason: "The owner supplied a second correction.",
            }),
          },
          finish_reason: "stop",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", correctionFetch);
    const correction = await caller.documentAnalysis.correctCaseTimeline({
      caseId: "CASE_DOC_ANALYSIS",
      instruction: "Change the decision date to 15 July 2026 and keep the same source.",
    });
    expect(correction).toMatchObject({ operation: "update", before: { date: "2026-07-14" }, after: { date: "2026-07-15" } });
    const correctedTimeline = await caller.documentAnalysis.generateCaseTimeline({ caseId: "CASE_DOC_ANALYSIS" });
    expect(correctedTimeline.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        date: "2026-07-15",
        title: "Corrected decision date",
        source: expect.objectContaining({ evidenceId: uploaded.id }),
      }),
    ]));
    expect(correctedTimeline.events.some((event) => event.date === "2026-07-14" && event.title === timeline.events[0].title)).toBe(false);
    expect(correctedTimeline.corrections).toHaveLength(1);
    const secondCorrection = await caller.documentAnalysis.correctCaseTimeline({
      caseId: "CASE_DOC_ANALYSIS",
      instruction: "Change the corrected decision date to 16 July 2026.",
    });
    expect(secondCorrection).toMatchObject({
      operation: "update",
      before: { date: "2026-07-15", title: "Corrected decision date" },
      after: { date: "2026-07-16", title: "Final corrected decision date" },
    });
    const twiceCorrectedTimeline = await caller.documentAnalysis.generateCaseTimeline({ caseId: "CASE_DOC_ANALYSIS" });
    expect(twiceCorrectedTimeline.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ date: "2026-07-16", title: "Final corrected decision date" }),
    ]));
    expect(twiceCorrectedTimeline.events.some((event) => (
      event.date === "2026-07-15" && event.title === "Corrected decision date"
    ))).toBe(false);
    expect(twiceCorrectedTimeline.corrections).toHaveLength(2);
    const correctionAudit = await caller.audit.list({ limit: 100 });
    expect(correctionAudit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "timeline.ai_correction_applied", entityId: correction.id }),
    ]));
    await caller.userPreferences.updateWorkflow({ analysisProvider: "local" });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    const caseAnalyses = await caller.documentAnalysis.byCase({ caseId: "CASE_DOC_ANALYSIS" });
    expect(caseAnalyses).toEqual([
      expect.objectContaining({ evidenceId: uploaded.id, documentType: first.result.documentType }),
    ]);

    await expect(app.makeCaller(other).documentAnalysis.analyzeEvidence({
      evidenceId: uploaded.id,
      deepAnalysis: false,
      force: false,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(app.makeCaller(other).documentAnalysis.byCase({ caseId: "CASE_DOC_ANALYSIS" }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });

    const [uploadedRow] = await app.db.select().from(app.schema.evidence).where(eq(app.schema.evidence.id, uploaded.id));
    const storageKey = JSON.parse(uploadedRow.metadata).storageKey;
    const { storageRead } = await import("../../server/storage");
    await expect(storageRead(storageKey)).resolves.toEqual(Buffer.from(sourceText));
    expect((await caller.evidenceFiles.delete({ id: uploaded.id })).success).toBe(true);
    await expect(storageRead(storageKey)).rejects.toThrow("not found");
    expect(await caller.documentAnalysis.byEvidence({ evidenceId: uploaded.id })).toBeNull();
  });

  it("invalidates analysis caches when the selected provider changes or cached JSON is corrupt", async () => {
    const caller = app.makeCaller(owner);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_PROVIDER_CACHE",
      userId: owner.id,
      caseType: "Administrative Law",
    }));
    const uploaded = await caller.evidenceFiles.upload({
      caseId: "CASE_PROVIDER_CACHE",
      title: "Provider cache decision.txt",
      type: "document",
      fileName: "provider-cache-decision.txt",
      mimeType: "text/plain",
      source: "manual",
      base64: Buffer.from("Besluit van 14 juli 2026. U moet binnen zes weken bezwaar maken.").toString("base64"),
    });
    const providerFinding = {
      summary: "Besluit van 14 juli 2026.",
      summaryCitations: ["src-1"],
      summaryEvidenceQuotes: ["Besluit van 14 juli 2026."],
      documentType: "administrative decision",
      legalIssues: [{ text: "Besluit", citations: ["src-1"], evidenceQuotes: ["Besluit van 14 juli 2026."] }],
      parties: [],
      claims: [],
      obligations: [{ text: "U moet binnen zes weken bezwaar maken.", citations: ["src-1"], evidenceQuotes: ["U moet binnen zes weken bezwaar maken."] }],
      riskFlags: [],
      timelineEvents: [{
        text: "Besluit van 14 juli 2026.",
        citations: ["src-1"],
        evidenceQuotes: ["Besluit van 14 juli 2026."],
        date: "2026-07-14",
        title: "Decision",
        actor: null,
        importance: "high",
        category: "legal",
      }],
      contradictions: [],
    };
    const providerResponse = () => new Response(JSON.stringify({
      id: "provider-analysis",
      created: 1,
      model: "provider-test-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: JSON.stringify(providerFinding) },
        finish_reason: "stop",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const fetchMock = vi.fn(() => Promise.resolve(providerResponse()));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
    vi.stubEnv("TOGETHER_API_KEY", "test-together-key");
    vi.stubEnv("LARO_OPENAI_MODEL", "provider-test-model-v1");

    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: true });
    const openai = await caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: true });
    expect(openai).toMatchObject({ cached: false, result: { analysisProvider: "openai", providerStatus: "complete" } });
    await expect(caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: true }))
      .resolves.toMatchObject({ cached: true, result: { analysisProvider: "openai" } });

    vi.stubEnv("LARO_OPENAI_MODEL", "provider-test-model-v2");
    await expect(caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: true }))
      .resolves.toMatchObject({ cached: false, result: { analysisProvider: "openai", providerModel: "provider-test-model-v2" } });

    await caller.userPreferences.updateWorkflow({ analysisProvider: "together" });
    const together = await caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: true });
    expect(together).toMatchObject({ cached: false, result: { analysisProvider: "together", providerStatus: "complete" } });

    await caller.userPreferences.updateWorkflow({ analysisProvider: "local" });
    const local = await caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: true });
    expect(local).toMatchObject({
      cached: false,
      result: { analysisProvider: "local", providerModel: null, providerStatus: "not_requested" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await app.db.update(app.schema.documentAnalyses)
      .set({ result: "{not-valid-json" })
      .where(eq(app.schema.documentAnalyses.evidenceId, uploaded.id));
    await expect(caller.documentAnalysis.analyzeEvidence({ evidenceId: uploaded.id, deepAnalysis: true }))
      .resolves.toMatchObject({ cached: false, result: { analysisProvider: "local" } });
    const rows = await app.db.select().from(app.schema.documentAnalyses)
      .where(eq(app.schema.documentAnalyses.evidenceId, uploaded.id));
    expect(rows).toHaveLength(1);
  });
});
