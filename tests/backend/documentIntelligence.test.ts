import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { analyzeDocumentBytes, extractDocumentText } from "../../server/documentIntelligence";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;
const OCR_FIXTURE = readFileSync(join(__dirname, "..", "fixtures", "ocr-dutch-decision.png"));

describe("document intelligence units", () => {
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
      summary: "A cited administrative decision.",
      summaryCitations: ["src-1"],
      documentType: "administrative decision",
      legalIssues: [{ text: "administrative law", citations: ["src-1"] }],
      parties: [],
      claims: [],
      obligations: [{ text: "Object within six weeks", citations: ["src-1"] }],
      riskFlags: [],
      timelineEvents: [{
        text: "Decision dated 14 July 2026",
        citations: ["src-1"],
        date: "2026-07-14",
        title: "Decision",
        actor: null,
        importance: "high",
        category: "legal",
      }],
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
