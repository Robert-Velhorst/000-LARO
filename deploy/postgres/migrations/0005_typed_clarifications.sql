ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "kind" text;
ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "context" text;
ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "answeredBy" text;
ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "applied" boolean;
ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "outcome" text;
ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "reviewStatus" text;
ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "provenance" text;
ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "answeredAt" bigint;
ALTER TABLE "clarification_questions" ADD COLUMN IF NOT EXISTS "updatedAt" bigint;

CREATE INDEX IF NOT EXISTS "clarification_questions_owner_status_idx"
  ON "clarification_questions" ("userId", "status");
CREATE INDEX IF NOT EXISTS "clarification_questions_case_kind_idx"
  ON "clarification_questions" ("caseId", "kind");

INSERT INTO "clarification_questions"
  ("id", "caseId", "userId", "kind", "question", "status", "applied", "outcome", "reviewStatus", "provenance", "createdAt", "updatedAt")
SELECT
  c."id" || ':primary-area', c."id", c."userId", 'primary_legal_area',
  'Legacy primary legal-area clarification', 'answered', false,
  'legacy_resolution_without_answer', 'legacy',
  '{"source":"legacy_system_config","answerAvailable":false}',
  COALESCE(s."updatedAt", (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  COALESCE(s."updatedAt", (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint)
FROM "cases" c
JOIN "system_config" s
  ON s."configKey" = 'clarify:' || c."userId" || ':' || c."id" || ':primary-area'
 AND s."configValue" = 'true'
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "clarification_questions"
  ("id", "caseId", "userId", "kind", "question", "status", "applied", "outcome", "reviewStatus", "provenance", "createdAt", "updatedAt")
SELECT
  c."id" || ':contact', c."id", c."userId", 'contact_email',
  'Legacy contact clarification', 'answered', false,
  'legacy_resolution_without_answer', 'legacy',
  '{"source":"legacy_system_config","answerAvailable":false}',
  COALESCE(s."updatedAt", (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  COALESCE(s."updatedAt", (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint)
FROM "cases" c
JOIN "system_config" s
  ON s."configKey" = 'clarify:' || c."userId" || ':' || c."id" || ':contact'
 AND s."configValue" = 'true'
ON CONFLICT ("id") DO NOTHING;
