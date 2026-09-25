CREATE TABLE IF NOT EXISTS "account_email_conflicts" (
  "id" text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "originalEmail" text NOT NULL,
  "normalizedEmail" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'resolved')),
  "createdAt" bigint NOT NULL,
  "resolvedAt" bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS "account_email_conflicts_user_status_unique"
  ON "account_email_conflicts"("userId", "status");
CREATE INDEX IF NOT EXISTS "account_email_conflicts_normalized_status_idx"
  ON "account_email_conflicts"("normalizedEmail", "status");

INSERT INTO "account_email_conflicts" (
  "id", "userId", "originalEmail", "normalizedEmail", "status", "createdAt", "resolvedAt"
)
SELECT
  'email-conflict:' || u."id",
  u."id",
  u."email",
  lower(btrim(u."email")),
  'pending',
  (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint,
  NULL
FROM "users" u
WHERE u."email" IS NOT NULL
  AND btrim(u."email") <> ''
  AND lower(btrim(u."email")) IN (
    SELECT lower(btrim("email"))
    FROM "users"
    WHERE "email" IS NOT NULL AND btrim("email") <> ''
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
  )
ON CONFLICT ("id") DO NOTHING;

UPDATE "users"
SET "email" = NULL
WHERE "id" IN (
  SELECT "userId" FROM "account_email_conflicts" WHERE "status" = 'pending'
);

UPDATE "users"
SET "email" = lower(btrim("email"))
WHERE "email" IS NOT NULL;

DROP INDEX IF EXISTS "users_email_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_canonical_unique"
  ON "users"(lower(btrim("email")))
  WHERE "email" IS NOT NULL;
