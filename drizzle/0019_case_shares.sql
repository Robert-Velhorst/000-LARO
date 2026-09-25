CREATE TABLE IF NOT EXISTS case_shares (
  id text PRIMARY KEY NOT NULL,
  caseId text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  ownerId text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  memberId text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('read_only', 'collaborator')),
  capabilities text NOT NULL CHECK (json_valid(capabilities) AND json_type(capabilities) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  invitedAt integer NOT NULL,
  acceptedAt integer,
  revokedAt integer,
  updatedAt integer NOT NULL,
  CHECK (ownerId <> memberId)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS case_shares_case_member_unique ON case_shares(caseId, memberId);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS case_shares_owner_status_idx ON case_shares(ownerId, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS case_shares_member_status_idx ON case_shares(memberId, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS case_shares_case_status_idx ON case_shares(caseId, status);
--> statement-breakpoint
-- Migrate the former owner-wide JSON memberships as inert per-case invitations.
-- They intentionally stay pending so an old setting can never silently widen
-- access after this migration.
INSERT OR IGNORE INTO case_shares (
  id, caseId, ownerId, memberId, role, capabilities, status,
  invitedAt, acceptedAt, revokedAt, updatedAt
)
SELECT
  'legacy:' || c.id || ':' || u.id,
  c.id,
  c.userId,
  u.id,
  'read_only',
  '["case.read"]',
  'pending',
  CAST(unixepoch('now') * 1000 AS integer),
  NULL,
  NULL,
  CAST(unixepoch('now') * 1000 AS integer)
FROM system_config AS config
JOIN json_each(
  CASE WHEN json_valid(config.configValue) THEN config.configValue ELSE '[]' END
) AS legacy_member
JOIN users AS u ON u.id = legacy_member.value
JOIN cases AS c
  ON c.userId = substr(config.configKey, 6, length(config.configKey) - 13)
WHERE config.configKey LIKE 'team:%:members'
  AND legacy_member.type = 'text'
  AND u.id <> c.userId;
