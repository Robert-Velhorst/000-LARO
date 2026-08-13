import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildCaseAssistantRetrievalAnswer,
  rankCaseAssistantSources,
  tokenizeCaseAssistantQuestion,
  validateCaseAssistantProviderAnswer,
  type CaseAssistantSource,
} from "../../server/caseAssistant";
import type { DocumentAnalysisResult } from "../../server/documentIntelligence";
import { buildCase, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

function analysis(over: Partial<DocumentAnalysisResult> = {}): DocumentAnalysisResult {
  return {
    schemaVersion: 2,
    analysisVersion: "test",
    contentHash: "hash",
    status: "complete",
    extractionMethod: "plain_text",
    extractionConfidence: null,
    providerStatus: "not_requested",
    providerMessage: null,
    documentType: "administrative decision",
    confidence: 92,
    summary: "The municipality issued a decision requiring an objection within six weeks.",
    analyzedChars: 100,
    analyzedWords: 14,
    truncated: false,
    citations: [{ id: "S1", quote: "Bezwaar moet binnen zes weken worden ingediend.", start: 0, end: 48, lineStart: 1, lineEnd: 1 }],
    parties: [{ text: "Gemeente Utrecht", citations: ["S1"] }],
    dates: [],
    amounts: [],
    claims: [],
    obligations: [{ text: "Objection within six weeks", citations: ["S1"] }],
    legalIssues: [{ text: "administrative law", citations: ["S1"] }],
    riskFlags: [],
    timelineEvents: [{
      text: "Municipality issued the decision",
      citations: ["S1"],
      date: "2026-07-14",
      title: "Decision",
      actor: "Gemeente Utrecht",
      importance: "high",
      category: "legal",
    }],
    ...over,
  };
}

function source(id: string, over: Partial<CaseAssistantSource> = {}): CaseAssistantSource {
  const result = over.analysis ?? analysis();
  return {
    evidenceId: id,
    title: "Besluit gemeente.txt",
    documentType: result.documentType,
    confidence: result.confidence,
    summary: result.summary,
    analysis: result,
    updatedAt: new Date("2026-07-20T10:00:00Z"),
    ...over,
  };
}

describe("case assistant evidence retrieval", () => {
  it("tokenizes Dutch and English questions without generic workflow words", () => {
    expect(tokenizeCaseAssistantQuestion("Wat heeft Gemeente Utrecht over bezwaar gezegd?"))
      .toEqual(["gemeente", "utrecht", "bezwaar", "gezegd"]);
  });

  it("ranks source-derived content and does not return unrelated analyses", () => {
    const decision = source("decision");
    const invoice = source("invoice", {
      title: "Factuur.pdf",
      analysis: analysis({
        documentType: "invoice",
        summary: "Invoice for EUR 1,250.",
        citations: [{ id: "S2", quote: "Totaal EUR 1.250,00", start: 0, end: 20, lineStart: 1, lineEnd: 1 }],
        parties: [],
        obligations: [],
        legalIssues: [],
        timelineEvents: [],
      }),
      documentType: "invoice",
      summary: "Invoice for EUR 1,250.",
    });
    expect(rankCaseAssistantSources("What did Gemeente Utrecht say about the objection?", [invoice, decision]))
      .toEqual([
        expect.objectContaining({
          evidenceId: "decision",
          matchedTerms: expect.arrayContaining(["gemeente", "utrecht", "objection"]),
        }),
      ]);
  });

  it("uses analyzed documents for broad case-overview questions", () => {
    const ranked = rankCaseAssistantSources("What happened in this case?", [source("decision")]);
    expect(ranked).toHaveLength(1);
    const fallback = buildCaseAssistantRetrievalAnswer("What happened in this case?", ranked, false);
    expect(fallback).toMatchObject({
      grounded: true,
      mode: "retrieval",
      citations: [expect.objectContaining({ evidenceId: "decision" })],
    });
    expect(fallback.answer).toContain("[D1]");
    expect(fallback.notice).toContain("disabled or unavailable");
  });

  it("accepts only provider answers that retain supplied document IDs", () => {
    const validIds = new Set(["D1", "D2"]);
    expect(validateCaseAssistantProviderAnswer({
      answer: "The decision records an objection deadline.",
      citationIds: ["D1"],
    }, validIds)).toEqual({
      answer: "The decision records an objection deadline.",
      citationIds: ["D1"],
    });
    expect(validateCaseAssistantProviderAnswer({
      answer: "Unsupported answer.",
      citationIds: ["D9"],
    }, validIds)).toBeNull();
    expect(validateCaseAssistantProviderAnswer({
      answer: "Uncited answer.",
      citationIds: [],
    }, validIds)).toBeNull();
  });
});

const suite = sqliteAvailable ? describe : describe.skip;

suite("case assistant API boundaries", () => {
  let app: TestApp;
  const owner = { id: "USR_ASSISTANT_OWNER", name: "Owner", role: "user", email: "assistant-owner@example.com" };
  const other = { id: "USR_ASSISTANT_OTHER", name: "Other", role: "user", email: "assistant-other@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id, email: owner.email }),
      buildUser({ id: other.id, email: other.email }),
    ]);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "CASE_ASSISTANT",
      userId: owner.id,
    }));
  });

  afterAll(() => app?.cleanup());

  it("requires owned case access and refuses to treat metadata as analyzed evidence", async () => {
    const result = await app.makeCaller(owner).assistant.ask({
      caseId: "CASE_ASSISTANT",
      question: "What happened?",
    });
    expect(result).toMatchObject({
      grounded: false,
      mode: "no_sources",
      citations: [],
    });
    await expect(app.makeCaller(other).assistant.ask({
      caseId: "CASE_ASSISTANT",
      question: "What happened?",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
