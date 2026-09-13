import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildUser } from "../factories";

const gateway = vi.hoisted(() => vi.fn());
const comparisonGateway = vi.hoisted(() => vi.fn());
vi.mock("../../server/llm", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../server/llm")>();
  return { ...original, invokeLLM: (params: any) => params.response_format?.json_schema?.name === "laro_dossier_comparison_v1" ? comparisonGateway(params) : gateway(params), isLLMProviderConfigured: () => true };
});

(sqliteAvailable ? describe : describe.skip)("semantic dossier discovery", () => {
  let app: TestApp;
  const owner = { id: "SEMANTIC_OWNER", email: "semantic@example.test", role: "user" };
  const other = { id: "SEMANTIC_OTHER", email: "other-semantic@example.test", role: "user" };
  const source = "Woningstichting Rivieren verhuurt de woning aan de Parkstraat aan de bewoner.\n\nEr is een geschil over langdurige lekkage in deze woning en uitblijvend herstel.";
  let sequence = 0;
  const staged = async (text = source) => {
    const caller = app.makeCaller(owner);
    const item = await caller.documentInbox.upload({ fileName: `semantic-${++sequence}.txt`, mimeType: "text/plain", base64: Buffer.from(text).toString("base64") });
    const { analyzeDocumentBytes } = await import("../../server/documentIntelligence");
    const analysis = await analyzeDocumentBytes({ bytes: Buffer.from(text), mimeType: "text/plain", deepAnalysis: false });
    await app.db.update(app.schema.documentInbox).set({ analysis: JSON.stringify(analysis), sourceText: text }).where(eq(app.schema.documentInbox.id, item.id));
    return { ...item, analysis };
  };
  const response = (packet: any, action = "create", caseId: string | null = null) => {
    const party = packet.document.passages.find((item: any) => item.quote.includes("Woningstichting"));
    const situation = packet.document.passages.find((item: any) => item.quote.includes("geschil over"));
    const candidate = packet.cases.find((item: any) => item.id === caseId);
    return {
      action, confidence: "high", caseId, title: "Parkstraat: lekkage en herstel", summary: source,
      reason: "Dezelfde verhuurder, woning en hetzelfde geschil over lekkage en herstel.",
      support: {
        participantOrContinuity: { kind: "participant", documentPassageId: party.id,
          casePassageId: candidate?.passages.find((p: any) => p.quote === party.quote)?.id ?? null },
        situation: { documentPassageId: situation.id,
          casePassageId: candidate?.passages.find((p: any) => p.quote === situation.quote)?.id ?? null },
      },
    };
  };
  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(other)]);
  });
  beforeEach(async () => {
    gateway.mockReset();
    compareAgainst(() => false);
    await app.makeCaller(owner).userPreferences.updateWorkflow({ analysisProvider: "ollama", autoOrganizeDocuments: true, shareRawDocumentContent: false });
  });
  afterAll(() => app?.cleanup());

  function compareAgainst(match: (candidate: any) => boolean) {
    comparisonGateway.mockReset();
    comparisonGateway.mockImplementation(async (params) => ({ choices: [{ message: { content: JSON.stringify({ singleSituation: true,
      relations: JSON.parse(params.messages[1].content).cases.map((candidate: any) => ({ caseId: candidate.id,
        relation: match(candidate) ? "same" : "different", reason: "Controlled comparison fixture" })),
    }) } }] }));
  }

  it("creates a provisional dossier without a reference and files a semantically related follow-up", async () => {
    compareAgainst((candidate) => candidate.title === "Parkstraat: lekkage en herstel");
    const first = await staged();
    gateway.mockImplementation(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      const prior = packet.cases.find((item: any) => item.title === "Parkstraat: lekkage en herstel");
      return { choices: [{ message: { content: JSON.stringify(response(packet, prior ? "assign" : "create", prior?.id ?? null)) } }] };
    });
    const created = await app.makeCaller(owner).documentInbox.process({ id: first.id });
    expect(created.decision).toBe("created");
    const second = await staged(source + "\n\nDe verhuurder heeft nog niet gereageerd op het verzoek om herstel.");
    const assigned = await app.makeCaller(owner).documentInbox.process({ id: second.id });
    expect(assigned).toMatchObject({ decision: "assigned", caseId: created.caseId });
    expect(await app.makeCaller(owner).evidenceFiles.byCase({ caseId: created.caseId })).toHaveLength(2);
    const logs = (await app.db.select().from(app.schema.auditLogs)).filter((row: any) => row.action === "inbox.organized" && row.entityId === second.id);
    expect(JSON.parse(logs[0].details)).toMatchObject({ method: "semantic_provider", discovery: { provider: "ollama", basis: expect.any(Array) } });
    expect(gateway).toHaveBeenCalledTimes(2);
    expect(gateway.mock.calls[0][0].provider).toBe("ollama");
    const details = await app.makeCaller(owner).documentInbox.get({ id: second.id });
    expect(details.discovery).toMatchObject({ action: "assign", provider: "ollama", caseId: created.caseId, basis: expect.any(Array) });
  });

  it("rejects fabricated source quotes and foreign case IDs without creating or linking anything", async () => {
    const foreign = await app.makeCaller(other).cases.create({ clientName: "Private foreign case", clientEmail: other.email,
      caseType: "Other", caseSummary: "Confidential unrelated matter", urgency: "Low" });
    for (const defect of ["quote", "case"]) {
      const item = await staged();
      gateway.mockImplementation(async (params) => {
        const packet = JSON.parse(params.messages[1].content);
        expect(JSON.stringify(packet)).not.toContain("Confidential unrelated matter");
        const result = response(packet);
        if (defect === "quote") Object.assign(result.support.situation, { quote: "This sentence does not exist in the source." });
        else { result.action = "assign"; result.caseId = foreign.id; }
        return { choices: [{ message: { content: JSON.stringify(result) } }] };
      });
      expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review", evidenceId: null });
      expect(gateway).toHaveBeenCalled();
      gateway.mockClear();
    }
  });

  it("does not send content externally when sharing or automatic organization is disabled", async () => {
    const caller = app.makeCaller(owner);
    await caller.userPreferences.updateWorkflow({ analysisProvider: "openai", shareRawDocumentContent: false });
    const privateItem = await staged();
    expect(await caller.documentInbox.process({ id: privateItem.id })).toMatchObject({ decision: "needs_review" });
    await caller.userPreferences.updateWorkflow({ analysisProvider: "ollama", autoOrganizeDocuments: false });
    const manualItem = await staged();
    expect(await caller.documentInbox.process({ id: manualItem.id })).toMatchObject({ decision: "needs_review" });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("retains a readable original on provider failure and permits a later retry", async () => {
    const item = await staged();
    gateway.mockRejectedValueOnce(new Error("Unavailable"));
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review" });
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(Buffer.from((await app.makeCaller(owner).documentInbox.download({ id: item.id })).base64, "base64").toString()).toBe(source);
    gateway.mockImplementation(async (params) => ({ choices: [{ message: { content: JSON.stringify(response(JSON.parse(params.messages[1].content))) } }] }));
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "created" });
  });

  it("rejects a match supported only by the same participant in the candidate case", async () => {
    const item = await staged();
    const candidate = await app.makeCaller(owner).cases.create({ clientName: "Same participant, different situation", clientEmail: owner.email,
      caseType: "Other", caseSummary: source.split("\n\n")[0] + "\n\nDit dossier gaat over een andere situatie.", urgency: "Low" });
    compareAgainst((item) => item.id === candidate.id);
    gateway.mockImplementation(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      const result = response(packet, "assign", candidate.id);
      result.support.situation.casePassageId = result.support.participantOrContinuity.casePassageId;
      return { choices: [{ message: { content: JSON.stringify(result) } }] };
    });
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review", evidenceId: null });
  });

  it("serializes same-owner imports so the second discovery sees the newly created dossier", async () => {
    compareAgainst((candidate) => candidate.title === "Parallel dossier");
    const first = await staged(source + "\n\nEerste parallelle bron.");
    const second = await staged(source + "\n\nTweede parallelle bron.");
    let discoveredCaseId: string | null = null;
    gateway.mockImplementation(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      const existing = packet.cases.find((item: any) => item.title === "Parallel dossier");
      const result = response(packet, existing ? "assign" : "create", existing?.id ?? null);
      result.title = "Parallel dossier";
      if (existing) discoveredCaseId = existing.id;
      return { choices: [{ message: { content: JSON.stringify(result) } }] };
    });
    const results = await Promise.all([first, second].map((item) => app.makeCaller(owner).documentInbox.process({ id: item.id })));
    expect(results.map((item) => item.decision).sort()).toEqual(["assigned", "created"]);
    expect(results[0].caseId).toBe(results[1].caseId);
    expect(discoveredCaseId).toBe(results[0].caseId);
  });

  it("does not apply a model decision after organization preferences change", async () => {
    const item = await staged();
    gateway.mockImplementation(async (params) => {
      await app.makeCaller(owner).userPreferences.updateWorkflow({ autoOrganizeDocuments: false });
      return { choices: [{ message: { content: JSON.stringify(response(JSON.parse(params.messages[1].content))) } }] };
    });
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review", evidenceId: null });
    const details = await app.makeCaller(owner).documentInbox.get({ id: item.id });
    expect(details.reason).toContain("settings changed");
    expect(details.discovery).toMatchObject({ action: "review", caseId: null, reason: details.reason });
  });

  it("does not send a second model request when settings change during comparison", async () => {
    const item = await staged();
    comparisonGateway.mockImplementationOnce(async (params) => {
      await app.makeCaller(owner).userPreferences.updateWorkflow({ autoOrganizeDocuments: false });
      return { choices: [{ message: { content: JSON.stringify({ singleSituation: true,
        relations: JSON.parse(params.messages[1].content).cases.map((candidate: any) => ({ caseId: candidate.id, relation: "different", reason: "Controlled fixture" })),
      }) } }] };
    });
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review", evidenceId: null });
    expect(comparisonGateway).toHaveBeenCalledTimes(1);
    expect(gateway).not.toHaveBeenCalled();
    expect((await app.makeCaller(owner).documentInbox.get({ id: item.id })).reason).toContain("settings changed");
  });

  it("does not send a second model request when an owned case changes during comparison", async () => {
    const item = await staged();
    comparisonGateway.mockImplementationOnce(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      await app.db.update(app.schema.cases).set({ caseSummary: "Updated context during comparison" }).where(eq(app.schema.cases.id, packet.cases[0].id));
      return { choices: [{ message: { content: JSON.stringify({ singleSituation: true,
        relations: packet.cases.map((candidate: any) => ({ caseId: candidate.id, relation: "different", reason: "Controlled fixture" })),
      }) } }] };
    });
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review", evidenceId: null });
    expect(comparisonGateway).toHaveBeenCalledTimes(1);
    expect(gateway).not.toHaveBeenCalled();
    expect((await app.makeCaller(owner).documentInbox.get({ id: item.id })).reason).toContain("inventory changed");
  });

  it("fails visibly instead of silently truncating the discovery context", async () => {
    const item = await staged(source + "\n\n" + "Extra inhoud zonder kenmerk. ".repeat(1300));
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review" });
    expect((await app.makeCaller(owner).documentInbox.get({ id: item.id })).reason).toContain("context limit");
    expect(gateway).not.toHaveBeenCalled();
  });

  it("rejects a decision when the case inventory changes during the model call", async () => {
    const item = await staged();
    gateway.mockImplementation(async (params) => {
      const packet = JSON.parse(params.messages[1].content);
      await app.makeCaller(owner).cases.create({ clientName: "Newly discovered elsewhere", clientEmail: owner.email,
        caseType: "Other", caseSummary: source, urgency: "Low" });
      return { choices: [{ message: { content: JSON.stringify(response(packet)) } }] };
    });
    expect(await app.makeCaller(owner).documentInbox.process({ id: item.id })).toMatchObject({ decision: "needs_review", evidenceId: null });
    const details = await app.makeCaller(owner).documentInbox.get({ id: item.id });
    expect(details.reason).toContain("inventory changed");
    expect(details.discovery.action).toBe("review");
  });

  it("handles damaged saved decision data without exposing it as a valid explanation", async () => {
    const item = await staged();
    await app.db.update(app.schema.documentInbox).set({ discovery: '{"action":"assign","provider":"invented"}' }).where(eq(app.schema.documentInbox.id, item.id));
    expect((await app.makeCaller(owner).documentInbox.get({ id: item.id })).discovery).toBeNull();
  });
});
