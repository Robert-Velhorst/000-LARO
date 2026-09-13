CREATE TABLE IF NOT EXISTS case_action_evidence (
  id text PRIMARY KEY NOT NULL,
  userId text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caseId text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actionId text NOT NULL REFERENCES deadlines(id) ON DELETE CASCADE,
  evidenceId text REFERENCES evidence(id) ON DELETE SET NULL,
  relation text NOT NULL CHECK (relation IN ('supports', 'contradicts')),
  state text NOT NULL CHECK (state IN ('active', 'withdrawn')),
  note text NOT NULL,
  snapshot text NOT NULL,
  createdAt integer NOT NULL,
  updatedAt integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS case_action_evidence_owner_action_idx ON case_action_evidence(userId, actionId);
