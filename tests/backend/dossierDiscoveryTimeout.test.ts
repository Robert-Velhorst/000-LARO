import { afterEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => vi.fn());
vi.mock("../../server/llm", () => ({
  invokeLLM: gateway, isLLMProviderConfigured: () => true,
  isLocalLLMProvider: () => true, LLM_PROVIDERS: ["ollama"],
}));
import { discoverDossier, discoveryTimeoutMs } from "../../server/dossierDiscovery";
import type { DocumentAnalysisResult } from "../../server/documentIntelligence";
import type { WorkflowPreferences } from "../../server/workflowPreferences";

const source = "Een geschil over lekkage in een huurwoning.";
// Only the extraction fields consumed by discovery are relevant to this contract.
const analysis = { coverage: { complete: true }, extractionConfidence: null,
  summary: source, citations: [{ id: "source:1", quote: source }] } as DocumentAnalysisResult;
const preferences: WorkflowPreferences = { analysisMode: "local", analysisProvider: "ollama",
  autoAnalyzeImports: true, autoOrganizeDocuments: true, shareRawDocumentContent: false,
  outreachReviewMode: "each", messageApprovalMode: "each" };
const run = () => discoverDossier({ ownerId: "DOSSIER_TIMEOUT_TEST", analysis, sourceText: source, cases: [], preferences });

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); gateway.mockReset(); });

describe("bounded dossier discovery time budget", () => {
  it.each([undefined, "", "   "])("retains the 90-second default for %s", (value) => {
    vi.stubEnv("LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS", value);
    expect(discoveryTimeoutMs()).toBe(90_000);
  });

  it.each([["15", 15_000], ["450", 450_000], ["600", 600_000], [" 120 ", 120_000]])(
    "accepts the explicit bounded budget %s", (value, expected) => {
      vi.stubEnv("LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS", value);
      expect(discoveryTimeoutMs()).toBe(expected);
    });

  it.each(["14", "601", "-1", "0", "1.5", "Infinity", "oops", "1e2", "0x64"])(
    "rejects invalid configuration %s", (value) => {
      vi.stubEnv("LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS", value);
      expect(() => discoveryTimeoutMs()).toThrow(/15.*600/);
    });

  it("passes the configured abort signal to the actual discovery request", async () => {
    vi.stubEnv("LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS", "450");
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    gateway.mockRejectedValue(new Error("offline"));
    expect(await run()).toMatchObject({ action: "review" });
    expect(timeout).toHaveBeenCalledWith(450_000);
    expect(gateway).toHaveBeenCalledWith(expect.objectContaining({ signal, requestTimeoutMs: 450_000, maxTokens: 2500 }));
  });

  it("does not contact a provider when its time budget is invalid", async () => {
    vi.stubEnv("LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS", "9999");
    const result = await run();
    expect(result).toMatchObject({ action: "review", reason: expect.stringContaining("LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS") });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("reports an elapsed time budget separately from an invalid model decision", async () => {
    vi.stubEnv("LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS", "450");
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    gateway.mockImplementation(async () => {
      controller.abort(new DOMException("Timed out", "TimeoutError"));
      throw controller.signal.reason;
    });
    expect(await run()).toMatchObject({ action: "review", reason: expect.stringMatching(/450.second.*time limit/i) });
  });
});
