import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { analyzeDocumentBytes } from "../../server/documentIntelligence";

type EvalCase = {
  id: string;
  text: string;
  expectedIssue: string;
  expectedDate: string;
  expectedAmount?: string;
  expectedObligationTerm: string;
};

const corpus = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "legal-analysis-eval.json"), "utf8")) as EvalCase[];

describe("legal analysis engineering evaluation corpus", () => {
  it.each(corpus)("extracts required source-linked facts for $id", async (entry) => {
    const result = await analyzeDocumentBytes({ bytes: Buffer.from(entry.text), mimeType: "text/plain", deepAnalysis: false });
    expect(result.coverage.complete).toBe(true);
    expect(result.legalIssues.map((finding) => finding.text)).toContain(entry.expectedIssue);
    expect(result.dates.map((finding) => finding.normalized)).toContain(entry.expectedDate);
    if (entry.expectedAmount) expect(result.amounts.map((finding) => finding.text)).toContain(entry.expectedAmount);
    expect(result.obligations.some((finding) => finding.text.toLocaleLowerCase("nl-NL").includes(entry.expectedObligationTerm))).toBe(true);
    const ids = new Set(result.citations.map((citation) => citation.id));
    for (const finding of [...result.legalIssues, ...result.dates, ...result.amounts, ...result.obligations]) {
      expect(finding.citations.length).toBeGreaterThan(0);
      expect(finding.citations.every((id) => ids.has(id))).toBe(true);
    }
  });
});
