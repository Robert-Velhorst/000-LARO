CREATE TABLE IF NOT EXISTS "case_shares" (
  "id" text PRIMARY KEY,
  "caseId" text NOT NULL REFERENCES "cases"("id") ON DELETE CASCADE,
  "ownerId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "memberId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('read_only', 'collaborator')),
  "capabilities" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'accepted', 'revoked')),
  "invitedAt" bigint NOT NULL,
  "acceptedAt" bigint,
  "revokedAt" bigint,
  "updatedAt" bigint NOT NULL,
  CONSTRAINT "case_shares_not_self" CHECK ("ownerId" <> "memberId"),
  CONSTRAINT "case_shares_capabilities_array" CHECK (jsonb_typeof("capabilities") = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS "case_shares_case_member_unique"
  ON "case_shares"("caseId", "memberId");
CREATE INDEX IF NOT EXISTS "case_shares_owner_status_idx"
  ON "case_shares"("ownerId", "status");
CREATE INDEX IF NOT EXISTS "case_shares_member_status_idx"
  ON "case_shares"("memberId", "status");
CREATE INDEX IF NOT EXISTS "case_shares_case_status_idx"
  ON "case_shares"("caseId", "status");

-- Preserve valid legacy memberships as pending, least-privilege invitations.
-- Malformed legacy values are ignored instead of aborting the deployment.
DO $$
DECLARE
  legacy record;
  legacy_member text;
  owner_id text;
  now_ms bigint := (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint;
BEGIN
  FOR legacy IN
    SELECT "configKey", "configValue"
    FROM "system_config"
    WHERE "configKey" LIKE 'team:%:members'
  LOOP
    owner_id := substring(legacy."configKey" FROM 6 FOR char_length(legacy."configKey") - 13);
    BEGIN
      FOR legacy_member IN SELECT jsonb_array_elements_text(legacy."configValue"::jsonb)
      LOOP
        INSERT INTO "case_shares" (
          "id", "caseId", "ownerId", "memberId", "role", "capabilities",
          "status", "invitedAt", "acceptedAt", "revokedAt", "updatedAt"
        )
        SELECT
          'legacy:' || c."id" || ':' || u."id",
          c."id",
          c."userId",
          u."id",
          'read_only',
          '["case.read"]'::jsonb,
          'pending',
          now_ms,
          NULL,
          NULL,
          now_ms
        FROM "cases" c
        JOIN "users" u ON u."id" = legacy_member
        WHERE c."userId" = owner_id AND u."id" <> c."userId"
        ON CONFLICT ("caseId", "memberId") DO NOTHING;
      END LOOP;
    EXCEPTION WHEN others THEN
      RAISE NOTICE 'Ignoring malformed legacy team membership %', legacy."configKey";
    END;
  END LOOP;
END $$;
