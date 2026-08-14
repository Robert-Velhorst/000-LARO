import { describe, expect, it } from "vitest";
import { legalDocumentGeneratorService } from "../../server/legalDocumentGenerator";

const caseData = {
  caseId: "CASE_DRAFT",
  clientName: "Client Example",
  opponentName: "Other Party",
  gaps: [{ type: "no_response", description: "No response is present in the workspace", durationDays: 30 }],
  missingDocuments: [{ type: "decision record" }],
  suspiciousPatterns: [{ pattern: "record unavailable", evidence: "evidence-1" }],
};

describe("legal document generator safety", () => {
  it("produces review drafts without invented authorities or findings of misconduct", () => {
    const documents = [
      legalDocumentGeneratorService.generateDiscoveryRequest(caseData),
      legalDocumentGeneratorService.generatePreservationNotice(caseData),
      legalDocumentGeneratorService.generateSpoliationWarning(caseData),
      legalDocumentGeneratorService.generateDemandLetter(caseData, 2500),
    ];

    for (const document of documents) {
      expect(document.content).toContain("DRAFT FOR FACTUAL AND LEGAL REVIEW");
      expect(document.legalBasis).toEqual([]);
      expect(JSON.stringify(document)).not.toMatch(/ECLI:|bad faith|kwade trouw|criminal|strafbaar|establish(?:es|ed)? destruction/i);
    }
  });
});
