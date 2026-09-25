CREATE TABLE IF NOT EXISTS account_email_conflicts (
  id text PRIMARY KEY NOT NULL,
  userId text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  originalEmail text NOT NULL,
  normalizedEmail text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  createdAt integer NOT NULL,
  resolvedAt integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS account_email_conflicts_user_status_unique
  ON account_email_conflicts(userId, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS account_email_conflicts_normalized_status_idx
  ON account_email_conflicts(normalizedEmail, status);
--> statement-breakpoint
INSERT OR IGNORE INTO account_email_conflicts (
  id, userId, originalEmail, normalizedEmail, status, createdAt, resolvedAt
)
SELECT
  'email-conflict:' || u.id,
  u.id,
  u.email,
  lower(trim(u.email)),
  'pending',
  CAST(unixepoch('now') * 1000 AS integer),
  NULL
FROM users AS u
WHERE u.email IS NOT NULL
  AND trim(u.email) <> ''
  AND lower(trim(u.email)) IN (
    SELECT lower(trim(email))
    FROM users
    WHERE email IS NOT NULL AND trim(email) <> ''
    GROUP BY lower(trim(email))
    HAVING count(*) > 1
  );
--> statement-breakpoint
-- Quarantine every ambiguous login identity. No account is silently selected
-- as the survivor and no owned records are merged or deleted.
UPDATE users
SET email = NULL
WHERE id IN (
  SELECT userId FROM account_email_conflicts WHERE status = 'pending'
);
--> statement-breakpoint
UPDATE users
SET email = lower(trim(email))
WHERE email IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS users_email_unique;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS users_email_canonical_unique
  ON users(lower(trim(email)))
  WHERE email IS NOT NULL;
