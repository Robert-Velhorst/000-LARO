CREATE TABLE IF NOT EXISTS "legal_draft_recipients" (
  "id" text PRIMARY KEY NOT NULL,
  "recipientId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "caseId" text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "name" text NOT NULL,
  "address" text NOT NULL,
  "provenanceType" text NOT NULL CHECK ("provenanceType" IN ('owner_entered', 'evidence_derived')),
  "evidenceId" text REFERENCES "evidence"("id") ON DELETE SET NULL,
  "sourceReference" text NOT NULL CHECK ("sourceReference"::jsonb IS NOT NULL),
  "revisionHash" text NOT NULL CHECK (length("revisionHash") = 64),
  "reviewedBy" text NOT NULL,
  "reviewedAt" bigint NOT NULL,
  "createdAt" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "legal_draft_recipients_revision_unique"
  ON "legal_draft_recipients" ("recipientId", "revision");
CREATE INDEX IF NOT EXISTS "legal_draft_recipients_owner_case_revision_idx"
  ON "legal_draft_recipients" ("userId", "caseId", "revision");

CREATE TABLE IF NOT EXISTS "legal_draft_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "caseId" text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "documentType" text NOT NULL CHECK ("documentType" IN ('discovery_request', 'preservation_notice', 'spoliation_warning', 'demand_letter')),
  "version" integer NOT NULL CHECK ("version" >= 1),
  "status" text DEFAULT 'pending_review' NOT NULL CHECK ("status" IN ('pending_review', 'reviewed')),
  "generationRevision" text NOT NULL CHECK (length("generationRevision") = 64),
  "inputRevision" text NOT NULL CHECK (length("inputRevision") = 64),
  "sourceRevision" text NOT NULL CHECK (length("sourceRevision") = 64),
  "caseRevision" text NOT NULL CHECK (length("caseRevision") = 64),
  "analysisRevision" text NOT NULL CHECK (length("analysisRevision") = 64),
  "coverageAnalysisId" text NOT NULL,
  "recipientRevisionId" text NOT NULL,
  "recipientRevision" integer NOT NULL CHECK ("recipientRevision" >= 1),
  "recipientRevisionHash" text NOT NULL CHECK (length("recipientRevisionHash") = 64),
  "recipientSnapshot" text NOT NULL CHECK ("recipientSnapshot"::jsonb IS NOT NULL),
  "ownerInputRevision" text NOT NULL CHECK (length("ownerInputRevision") = 64),
  "provenance" text NOT NULL CHECK ("provenance"::jsonb IS NOT NULL),
  "previewJson" text NOT NULL CHECK ("previewJson"::jsonb IS NOT NULL),
  "contentBase64" text NOT NULL,
  "contentHash" text NOT NULL CHECK (length("contentHash") = 64),
  "byteLength" integer NOT NULL CHECK ("byteLength" > 0),
  "fileName" text NOT NULL,
  "reviewedBy" text,
  "reviewedAt" bigint,
  "createdAt" bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "legal_draft_snapshots_generation_unique"
  ON "legal_draft_snapshots" ("userId", "caseId", "documentType", "generationRevision");
CREATE UNIQUE INDEX IF NOT EXISTS "legal_draft_snapshots_owner_case_type_version_unique"
  ON "legal_draft_snapshots" ("userId", "caseId", "documentType", "version");
CREATE INDEX IF NOT EXISTS "legal_draft_snapshots_owner_case_created_idx"
  ON "legal_draft_snapshots" ("userId", "caseId", "createdAt");
