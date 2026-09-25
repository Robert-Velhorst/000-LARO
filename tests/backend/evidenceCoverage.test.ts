import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEvidenceCoverage } from "../../server/evidenceCoverage";
import { buildCase, buildEvidence, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

function expectNoRetiredScoring(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/"(?:overallScore|directEvidenceScore|circumstantialScore|legalBasisScore|gapImpactScore|analysisNarrative|strengths|weaknesses|recommendations)"/);
  expect(serialized).not.toMatch(/Strong direct evidence|supporting your claims|No critical gaps detected/i);
}

suite("versioned evidence coverage", () => {
  let app: TestApp;
  const owner = {
    id: "USR_EVIDENCE_COVERAGE",
    name: "Coverage owner",
    role: "user",
    email: "coverage@example.test",
  };
  const cases = {
    sparse: "CASE_COVERAGE_SPARSE",
    duplicate: "CASE_COVERAGE_DUPLICATE",
    contradiction: "CASE_COVERAGE_CONTRADICTION",
    unavailable: "CASE_COVERAGE_UNAVAILABLE",
    documented: "CASE_COVERAGE_DOCUMENTED",
    retired: "CASE_COVERAGE_RETIRED",
  };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
    await app.db.insert(app.schema.cases).values(Object.values(cases).map((id) => buildCase({
      id,
      userId: owner.id,
      caseType: "General records review",
    })));
  });

  afterAll(() => app?.cleanup());

  it("reports sparse inputs and legal basis as unknown without deriving merit", async () => {
    const coverage = await buildEvidenceCoverage(cases.sparse, { gaps: [], expectedDocuments: [] });
    expect(coverage).toMatchObject({
      contractVersion: "evidence-coverage-v1",
      contractStatus: "current",
      counts: { inputRecords: 0 },
      legalBasis: { status: "unknown", reviewedSourceIds: [] },
    });
    expect(coverage.unknowns).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "no_inputs" }),
      expect.objectContaining({ code: "legal_basis_unknown" }),
    ]));
    expectNoRetiredScoring(coverage);
  });

  it("marks a saved score row retired without returning any legacy score fields", async () => {
    await app.db.insert(app.schema.evidenceCoverageAnalysis).values({
      id: "COVERAGE_RETIRED_ROW",
      caseId: cases.retired,
      data: JSON.stringify({
        overallScore: 88,
        directEvidenceScore: 95,
        analysisNarrative: "Unsupported legacy conclusion",
      }),
      createdAt: new Date(),
    });

    const caller = app.makeCaller(owner);
    const saved = await caller.gapAnalysis.getCoverage({ caseId: cases.retired });
    expect(saved).toMatchObject({
      contractVersion: "legacy-case-strength-v0",
      contractStatus: "retired",
      retirementReason: expect.stringContaining("retired scoring contract"),
    });
    expect(saved).not.toHaveProperty("overallScore");
    expect(saved).not.toHaveProperty("directEvidenceScore");
    expect(saved).not.toHaveProperty("analysisNarrative");
    await expect(caller.gapAnalysis.getSummary({ caseId: cases.retired })).resolves.toMatchObject({
      hasAnalysis: true,
      analysisStatus: "retired",
    });
  });

  it("labels only exact content identities as duplicates", async () => {
    const contentHash = "a".repeat(64);
    await app.db.insert(app.schema.evidence).values([
      buildEvidence({
        id: "COVERAGE_DUPLICATE_A",
        caseId: cases.duplicate,
        userId: owner.id,
        title: "First record",
        metadata: JSON.stringify({ contentHash }),
      }),
      buildEvidence({
        id: "COVERAGE_DUPLICATE_B",
        caseId: cases.duplicate,
        userId: owner.id,
        title: "Second record",
        metadata: JSON.stringify({ contentHash }),
      }),
    ]);

    const coverage = await buildEvidenceCoverage(cases.duplicate, { gaps: [], expectedDocuments: [] });
    expect(coverage.counts).toMatchObject({ inputRecords: 2, exactDuplicateRecords: 1 });
    expect(coverage.inputs.filter((input) => input.duplicateOf)).toEqual([
      expect.objectContaining({
        id: "COVERAGE_DUPLICATE_B",
        duplicateOf: "evidence_record:COVERAGE_DUPLICATE_A",
      }),
    ]);
    expectNoRetiredScoring(coverage);
  });

  it("exposes automated contradiction flags as human-review unknowns", async () => {
    const contentHash = "b".repeat(64);
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "COVERAGE_CONTRADICTION_RECORD",
      caseId: cases.contradiction,
      userId: owner.id,
      title: "Statement record",
      metadata: JSON.stringify({ contentHash, reviewStatus: "reviewed" }),
    }));
    await app.db.insert(app.schema.documentAnalyses).values({
      id: "COVERAGE_CONTRADICTION_ANALYSIS",
      evidenceId: "COVERAGE_CONTRADICTION_RECORD",
      caseId: cases.contradiction,
      userId: owner.id,
      analysisVersion: "coverage-test-v1",
      contentHash,
      status: "complete",
      extractionMethod: "plain_text",
      providerStatus: "not_requested",
      documentType: "statement",
      confidence: 60,
      summary: "Automated review fixture",
      result: JSON.stringify({
        contradictions: [{ statementA: "A", statementB: "B", explanation: "Review both passages" }],
      }),
      analyzedChars: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const coverage = await buildEvidenceCoverage(cases.contradiction, { gaps: [], expectedDocuments: [] });
    expect(coverage.counts).toMatchObject({ reviewed: 1, automatedContradictionFlags: 1 });
    expect(coverage.unknowns).toContainEqual(expect.objectContaining({
      code: "automated_contradiction_flags",
      inputIds: ["evidence_record:COVERAGE_CONTRADICTION_RECORD"],
      detail: expect.stringContaining("person must review"),
    }));
    expectNoRetiredScoring(coverage);
  });

  it("reports an unavailable managed source without treating metadata as source content", async () => {
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: "COVERAGE_UNAVAILABLE_RECORD",
      caseId: cases.unavailable,
      userId: owner.id,
      title: "Missing managed source",
      metadata: JSON.stringify({
        storageKey: "evidence/CASE_COVERAGE_UNAVAILABLE/not-present.txt",
        contentHash: "c".repeat(64),
      }),
    }));

    const coverage = await buildEvidenceCoverage(cases.unavailable, { gaps: [], expectedDocuments: [] });
    expect(coverage.counts).toMatchObject({ sourceUnavailable: 1, sourceAvailable: 0 });
    expect(coverage.inputs[0]).toMatchObject({ sourceAvailability: "unavailable" });
    expect(coverage.unknowns).toContainEqual(expect.objectContaining({ code: "source_unavailable" }));
    expectNoRetiredScoring(coverage);
  });

  it("keeps a well-documented snapshot descriptive and revision-bound", async () => {
    await app.db.insert(app.schema.timeline).values([0, 1, 2].map((index) => ({
      id: `COVERAGE_EVENT_${index}`,
      caseId: cases.documented,
      userId: owner.id,
      eventType: "recorded_event",
      title: `Recorded event ${index + 1}`,
      description: `Recorded detail ${index + 1}`,
      eventAt: new Date(Date.UTC(2026, 8, 10 + index)),
      metadata: JSON.stringify({ reviewStatus: "reviewed" }),
      createdAt: new Date(Date.UTC(2026, 8, 10 + index)),
    })));
    await app.db.insert(app.schema.evidence).values([0, 1].map((index) => buildEvidence({
      id: `COVERAGE_DOCUMENT_${index}`,
      caseId: cases.documented,
      userId: owner.id,
      title: `Document ${index + 1}`,
      metadata: JSON.stringify({ reviewStatus: "reviewed", contentHash: `${index + 4}`.repeat(64) }),
    })));

    const first = await buildEvidenceCoverage(cases.documented, { gaps: [], expectedDocuments: [] });
    const second = await buildEvidenceCoverage(cases.documented, { gaps: [], expectedDocuments: [] });
    expect(first.counts).toMatchObject({ inputRecords: 5, reviewed: 5, exactDuplicateRecords: 0 });
    expect(first.legalBasis.status).toBe("unknown");
    expect(second.sourceRevision).toBe(first.sourceRevision);
    expect(second.snapshotRevision).toBe(first.snapshotRevision);
    expectNoRetiredScoring(first);
  });

  it("keeps the renderer free of the retired client formula and conclusions", () => {
    const evidencePage = readFileSync("src/renderer/components/Evidence.tsx", "utf8");
    const dashboard = readFileSync("src/renderer/components/EvidenceGapAnalysisDashboard.tsx", "utf8");
    expect(evidencePage + dashboard).not.toMatch(/No critical gaps detected|getCaseStrength|Completeness Score|Evidence Completeness Analysis/);
    expect(dashboard).toContain('coverage.exactInputs');
    expect(dashboard).toContain('coverage.legalBasisUnknown');
  });
});
