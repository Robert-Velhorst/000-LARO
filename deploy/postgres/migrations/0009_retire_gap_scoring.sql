DELETE FROM "communication_gaps" AS derived
WHERE derived."caseId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "case_strength_analysis" AS coverage
  WHERE coverage."caseId" = derived."caseId"
    AND coverage."data" LIKE '%"contractVersion":"evidence-coverage-v1"%'
    AND coverage."data" LIKE '%"contractStatus":"current"%'
);

DELETE FROM "expected_documents" AS derived
WHERE derived."caseId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "case_strength_analysis" AS coverage
  WHERE coverage."caseId" = derived."caseId"
    AND coverage."data" LIKE '%"contractVersion":"evidence-coverage-v1"%'
    AND coverage."data" LIKE '%"contractStatus":"current"%'
);

DELETE FROM "suspicious_patterns" AS derived
WHERE derived."caseId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "case_strength_analysis" AS coverage
  WHERE coverage."caseId" = derived."caseId"
    AND coverage."data" LIKE '%"contractVersion":"evidence-coverage-v1"%'
    AND coverage."data" LIKE '%"contractStatus":"current"%'
);

DELETE FROM "legal_inferences" AS derived
WHERE derived."caseId" IS NULL OR NOT EXISTS (
  SELECT 1 FROM "case_strength_analysis" AS coverage
  WHERE coverage."caseId" = derived."caseId"
    AND coverage."data" LIKE '%"contractVersion":"evidence-coverage-v1"%'
    AND coverage."data" LIKE '%"contractStatus":"current"%'
);

UPDATE "case_strength_analysis"
SET "data" = json_build_object(
  'contractVersion', 'legacy-case-strength-v0',
  'contractStatus', 'retired',
  'retirementReason', 'This saved row was produced by the retired scoring contract. Re-run coverage review to create a source-revision inventory.',
  'retiredAt', '2026-09-19T00:00:00.000Z'
)::text
WHERE "data" IS NULL
  OR "data" NOT LIKE '%"contractVersion":"evidence-coverage-v1"%'
  OR "data" NOT LIKE '%"contractStatus":"current"%';
