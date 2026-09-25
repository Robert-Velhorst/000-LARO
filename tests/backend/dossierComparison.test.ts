import { afterEach, describe, expect, it, vi } from "vitest";
const gateway = vi.hoisted(() => vi.fn());
vi.mock("../../server/llm", () => ({ invokeLLM: gateway }));
import { compareDossierSituations } from "../../server/dossierComparison";
const cases = [{ id: "a", title: "A", summary: "First concrete dispute", metadata: null },
  { id: "b", title: "B", summary: "Second concrete dispute", metadata: null }];
const run = () => compareDossierSituations({ ownerId: "DOSSIER_COMPARISON_TEST", sourceText: "An incoming source", cases, provider: "ollama",
  signal: new AbortController().signal, timeoutMs: 90_000 });
const valid = () => ({ singleSituation: true, relations: [
  { caseId: "a", relation: "same", reason: "Same concrete situation" },
  { caseId: "b", relation: "different", reason: "Another concrete situation" },
] });
const respond = (result: unknown) => gateway.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(result) } }] });
afterEach(() => gateway.mockReset());

describe("complete independent dossier comparison", () => {
  it.each([0, 2, 100])("allocates bounded answer space for %i complete dossier comparisons", async (count) => {
    const inventory = Array.from({ length: count }, (_, index) => ({
      id: `CASE-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      title: `Situation ${index}`, summary: `Distinct dispute ${index}`, metadata: null,
    }));
    const result = { singleSituation: true, relations: inventory.map(({ id }) => ({
      caseId: id, relation: "different", reason: "A different documented dispute with no established link to the incoming situation.",
    })) };
    gateway.mockImplementation(async (params) => {
      const batch = JSON.parse(params.messages[1].content).cases;
      return { choices: [{ message: { content: JSON.stringify({ singleSituation: true,
        relations: result.relations.filter(r => batch.some((c: any) => c.id === r.caseId)) }) } }] };
    });
    expect(await compareDossierSituations({ ownerId: "DOSSIER_COMPARISON_TEST", sourceText: "Incoming situation", cases: inventory, provider: "ollama",
      signal: new AbortController().signal, timeoutMs: 90_000 })).toEqual(result);
    expect(gateway.mock.calls[0][0].maxTokens).toBe(Math.min(32768, Math.max(2500, 512 + Math.min(count, 20) * 256)));
  });
  it("returns one explicit relation per supplied case without dropping source context", async () => {
    respond(valid());
    expect(await run()).toEqual(valid());
    const params = gateway.mock.calls[0][0];
    expect(params.signal).toBeInstanceOf(AbortSignal);
    expect(params.requestTimeoutMs).toBe(90_000);
    expect(JSON.parse(params.messages[1].content)).toEqual({ document: "An incoming source", cases: cases.map(({ id, title, summary }) => ({ id, title, context: summary })) });
  });
  it.each(["missing", "duplicate", "foreign"])("rejects %s case coverage", async (defect) => {
    const result = valid();
    if (defect === "missing") result.relations.pop();
    if (defect === "duplicate") result.relations[1].caseId = "a";
    if (defect === "foreign") result.relations[1].caseId = "foreign";
    respond(result);
    await expect(run()).rejects.toThrow(/inventory/);
  });

  it("compares a large inventory in complete bounded batches with one shared deadline", async () => {
    const inventory = Array.from({ length: 205 }, (_, i) => ({ id: `case-${i}`, title: `Matter ${i}`, summary: `Concrete situation ${i}.`, metadata: null }));
    gateway.mockImplementation(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      return { choices: [{ message: { content: JSON.stringify({ singleSituation: true, relations: packet.cases.map((item: any) => ({
        caseId: item.id, relation: item.id === "case-204" ? "same" : "different", reason: "Controlled comparison",
      })) }) } }] };
    });
    const signal = new AbortController().signal;
    const beforeDispatch = vi.fn().mockResolvedValue(true);
    const result = await compareDossierSituations({ ownerId: "DOSSIER_COMPARISON_TEST", sourceText: "Complete incoming source", cases: inventory, provider: "ollama", signal, timeoutMs: 90_000, beforeDispatch });
    expect(result.relations).toHaveLength(205);
    expect(result.relations.at(-1)).toMatchObject({ caseId: "case-204", relation: "same" });
    expect(gateway.mock.calls.length).toBeGreaterThan(1);
    expect(gateway.mock.calls.flatMap(([p]) => JSON.parse(p.messages[1].content).cases.map((c: any) => c.id))).toEqual(inventory.map(c => c.id));
    for (const [params] of gateway.mock.calls) {
      expect(params.signal).toBe(signal);
      expect(params.beforeDispatch).toBe(beforeDispatch);
      expect(params.messages[1].content.length).toBeLessThanOrEqual(32_000);
    }
  });

  it("rejects an oversized individual context before dispatch instead of truncating", async () => {
    await expect(compareDossierSituations({ ownerId: "DOSSIER_COMPARISON_TEST", sourceText: "Incoming source", cases: [{ ...cases[0], summary: "x".repeat(32_000) }],
      provider: "ollama", signal: new AbortController().signal, timeoutMs: 90_000 })).rejects.toThrow(/context/i);
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each(["missing-final-case", "aborted"])("never returns an early match after a later batch is %s", async (defect) => {
    const controller = new AbortController();
    const inventory = Array.from({ length: 21 }, (_, i) => ({ ...cases[0], id: `case-${i}` }));
    gateway.mockImplementation(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      if (defect === "aborted") controller.abort();
      return { choices: [{ message: { content: JSON.stringify({ singleSituation: true,
        relations: packet.cases.filter((c: any) => defect !== "missing-final-case" || c.id !== "case-20").map((c: any) => ({
          caseId: c.id, relation: c.id === "case-0" ? "same" : "different", reason: "Controlled comparison",
        })) }) } }] };
    });
    await expect(compareDossierSituations({ ownerId: "DOSSIER_COMPARISON_TEST", sourceText: "Incoming situation", cases: inventory, provider: "ollama", signal: controller.signal, timeoutMs: 90_000 })).rejects.toThrow();
    expect(gateway).toHaveBeenCalledTimes(defect === "aborted" ? 1 : 2);
  });
});
