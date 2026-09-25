import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentAnalysisResult } from "../../server/documentIntelligence";
import type { WorkflowPreferences } from "../../server/workflowPreferences";

const gateway = vi.hoisted(() => vi.fn());
vi.mock("../../server/llm", () => ({ invokeLLM: gateway, isLLMProviderConfigured: () => true,
  isLocalLLMProvider: () => true, LLM_PROVIDERS: ["ollama"] }));
import { discoverDossier, parseStoredDiscovery } from "../../server/dossierDiscovery";

const party = "Jan huurt een woning van Woningstichting Rivieren.";
const situation = "Er is langdurige lekkage en de verhuurder heeft niets hersteld.";
const source = `${party}\n\n${situation}`;
const analysis = { coverage: { complete: true }, extractionConfidence: null, summary: source,
  citations: [{ id: "src-1", quote: party }, { id: "src-2", quote: situation }] } as DocumentAnalysisResult;
const preferences: WorkflowPreferences = { analysisMode: "local", analysisProvider: "ollama", autoAnalyzeImports: true,
  autoOrganizeDocuments: true, shareRawDocumentContent: false, externalDocumentSharingConsent: null,
  outreachReviewMode: "each", messageApprovalMode: "each" };
const cases = [{ id: "owned-housing", title: "Lekkage", summary: `${party} ${situation}`, metadata: null },
  { id: "owned-benefits", title: "Bijstand", summary: "Jan heeft bijstand aangevraagd. De gemeente heeft de aanvraag afgewezen.", metadata: null }];
const run = () => discoverDossier({ ownerId: "DOSSIER_PASSAGE_TEST", analysis, sourceText: source, cases, preferences });
function reply(packet: any) {
  return { action: "assign", confidence: "high", caseId: cases[0].id, title: "", summary: "", reason: "Dezelfde verhuurder en hetzelfde lekkagegeschil.",
    support: {
      participantOrContinuity: { kind: "participant", documentPassageId: packet.document.passages.find((p: any) => p.quote === party).id,
        casePassageId: packet.cases[0].passages.find((p: any) => p.quote === party).id },
      situation: { documentPassageId: packet.document.passages.find((p: any) => p.quote === situation).id,
        casePassageId: packet.cases[0].passages.find((p: any) => p.quote === situation).id },
    } };
}
function comparisonReply(packet: any) {
  return { choices: [{ message: { content: JSON.stringify({ singleSituation: true,
    relations: packet.cases.map((candidate: any) => ({ caseId: candidate.id, relation: candidate.id === cases[0].id ? "same" : "different", reason: "Controlled fixture" })),
  }) } }] };
}
function model(mutator?: (result: ReturnType<typeof reply>, packet: any) => void) {
  gateway.mockImplementation(async (params) => {
    const packet = JSON.parse(params.messages[1].content);
    if (params.response_format.json_schema.name === "laro_dossier_comparison_v1") return comparisonReply(packet);
    const result = reply(packet);
    mutator?.(result, packet);
    return { choices: [{ message: { content: JSON.stringify(result) } }] };
  });
}
afterEach(() => { gateway.mockReset(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("canonical discovery passage selection", () => {
  it.each(["multiple", "uncertain", "competing"])("stops before passage selection for %s comparisons", async (condition) => {
    const comparison = { singleSituation: condition !== "multiple", relations: cases.map((candidate, index) => ({ caseId: candidate.id,
      relation: condition === "competing" ? "same" : index === 0 && condition === "uncertain" ? "uncertain" : "different", reason: "Controlled ambiguity" })) };
    gateway.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(comparison) } }] });
    const result = await run();
    expect(result).toMatchObject({ action: "review", comparison });
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("rechecks authorization before the second provider call", async () => {
    model();
    const canContinue = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await discoverDossier({ ownerId: "DOSSIER_PASSAGE_TEST", analysis, sourceText: source, cases, preferences, canContinue }))
      .toMatchObject({ action: "review", reason: expect.stringContaining("changed") });
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(canContinue).toHaveBeenCalledTimes(2);
  });

  it("forwards current authorization to the transport in both stages", async () => {
    model();
    const canContinue = vi.fn().mockResolvedValue(true);
    expect(await discoverDossier({ ownerId: "DOSSIER_PASSAGE_TEST", analysis, sourceText: source, cases, preferences, canContinue }))
      .toMatchObject({ action: "assign" });
    expect(gateway).toHaveBeenCalledTimes(2);
    for (const [params] of gateway.mock.calls) expect(params.beforeDispatch).toBe(canContinue);
    expect(gateway.mock.calls[0][0].signal).toBe(gateway.mock.calls[1][0].signal);
  });

  it.each([1, 2])("bounds a stalled preflight authorization at stage %i", async (stage) => {
    model();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let release: (allowed: boolean) => void = () => {};
    let count = 0;
    const canContinue = vi.fn(async () => {
      if (++count !== stage) return true;
      controller.abort(new DOMException("Timed out", "TimeoutError"));
      return new Promise<boolean>((resolve) => { release = resolve; });
    });
    let finished = false;
    const pending = discoverDossier({ ownerId: "DOSSIER_PASSAGE_TEST", analysis, sourceText: source, cases, preferences, canContinue })
      .then((result) => { finished = true; return result; });
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 500 });
      expect(await pending).toMatchObject({ action: "review", reason: expect.stringContaining("time limit") });
      expect(gateway).toHaveBeenCalledTimes(stage - 1);
    } finally {
      release(true);
      await pending;
    }
  });

  it("retains the complete large comparison without repeating it in the selection packet", async () => {
    const inventory = Array.from({ length: 80 }, (_, i) => ({ id: `case-${i}`, title: "Brief matter", summary: "Some distinct situation.", metadata: null }));
    gateway.mockImplementation(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      const result = params.response_format.json_schema.name === "laro_dossier_comparison_v1"
        ? { singleSituation: true, relations: packet.cases.map((candidate: any) => ({ caseId: candidate.id, relation: "different", reason: "x".repeat(500) })) }
        : { action: "review", confidence: "low", caseId: null, title: "", summary: "", reason: "Needs more information", support: null };
      return { choices: [{ message: { content: JSON.stringify(result) } }] };
    });
    const result = await discoverDossier({ ownerId: "DOSSIER_PASSAGE_TEST", analysis, sourceText: source, cases: inventory, preferences });
    expect(result).toMatchObject({ action: "review", reason: "Needs more information" });
    expect(result.comparison?.relations).toHaveLength(80);
    expect(gateway).toHaveBeenCalledTimes(5);
    const selected = JSON.parse(gateway.mock.calls.at(-1)![0].messages[1].content);
    expect(selected.comparison).toEqual({ singleSituation: true, comparedCases: 80, differentCases: 80, selectedRelation: null });
    expect(JSON.stringify(selected).length).toBeLessThan(32_000);
  });

  it("checks the context ceiling before sentence segmentation", async () => {
    const segment = vi.spyOn(Intl.Segmenter.prototype, "segment");
    const result = await discoverDossier({ ownerId: "DOSSIER_PASSAGE_TEST", analysis, sourceText: source + "\n".repeat(32_000), cases, preferences });
    expect(result).toMatchObject({ action: "review", reason: expect.stringContaining("context limit") });
    expect(segment).not.toHaveBeenCalled();
    expect(gateway).not.toHaveBeenCalled();
  });
  it("resolves selected passages to the existing literal-quotation audit contract", async () => {
    model();
    const result = await run();
    expect(result).toMatchObject({ action: "assign", caseId: cases[0].id, basis: [
      { kind: "participant", citationId: "src-1", quote: party, caseCitationId: "case:owned-housing:context", caseQuote: party },
      { kind: "situation", citationId: "src-2", quote: situation, caseCitationId: "case:owned-housing:context", caseQuote: situation },
    ] });
    expect(parseStoredDiscovery(JSON.stringify(result))).toEqual(result);
    const format = gateway.mock.calls[1][0].response_format.json_schema;
    expect(format.name).toBe("laro_dossier_discovery_v3");
    expect(format.schema.properties).not.toHaveProperty("basis");
    expect(result.comparison?.relations).toHaveLength(2);
  });

  it("keeps the complete source and case context visible alongside bounded exact passages", async () => {
    model();
    await run();
    const compared = JSON.parse(gateway.mock.calls[0][0].messages[1].content);
    expect(compared.cases).toHaveLength(2);
    const packet = JSON.parse(gateway.mock.calls[1][0].messages[1].content);
    expect(packet.document.sourceText).toBe(source);
    for (const candidate of packet.cases) {
      expect(candidate.context).toBe(cases.find(c => c.id === candidate.id)!.summary);
      for (const passage of candidate.passages) expect(candidate.context).toContain(passage.quote);
    }
  });

  it.each(["unknown-source", "other-case", "repeated-source", "repeated-case", "fabricated-quote"])("rejects %s selections", async (defect) => {
    let mutated = false;
    model((result) => {
      mutated = true;
      if (defect === "unknown-source") result.support.participantOrContinuity.documentPassageId = "invented";
      if (defect === "other-case") result.support.situation.casePassageId = "c2p1";
      if (defect === "repeated-source") result.support.situation.documentPassageId = result.support.participantOrContinuity.documentPassageId;
      if (defect === "repeated-case") result.support.situation.casePassageId = result.support.participantOrContinuity.casePassageId;
      if (defect === "fabricated-quote") Object.assign(result.support.participantOrContinuity, { quote: "Invented words" });
    });
    expect(await run()).toMatchObject({ action: "review", caseId: null, basis: [] });
    expect(mutated).toBe(true);
  });

  it("creates a source-grounded dossier without requiring case-context references", async () => {
    gateway.mockImplementation(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      if (params.response_format.json_schema.name === "laro_dossier_comparison_v1") return comparisonReply(packet);
      return { choices: [{ message: { content: JSON.stringify({ action: "create", confidence: "high", caseId: null,
        title: "Lekkage", summary: source, reason: "Nieuwe situatie zonder bestaand dossier.", support: {
          participantOrContinuity: { kind: "participant", documentPassageId: packet.document.passages[0].id, casePassageId: null },
          situation: { documentPassageId: packet.document.passages[1].id, casePassageId: null },
        } }) } }] };
    });
    expect(await discoverDossier({ ownerId: "DOSSIER_PASSAGE_TEST", analysis, sourceText: source, cases: [], preferences })).toMatchObject({ action: "create", caseId: null, basis: [
      { citationId: "src-1", quote: party, caseCitationId: null, caseQuote: null },
      { citationId: "src-2", quote: situation, caseCitationId: null, caseQuote: null },
    ] });
  });
});
