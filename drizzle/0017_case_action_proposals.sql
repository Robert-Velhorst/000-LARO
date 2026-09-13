CREATE TABLE IF NOT EXISTS case_action_proposals (
  id text PRIMARY KEY NOT NULL,
  userId text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  caseId text NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  evidenceId text REFERENCES evidence(id) ON DELETE SET NULL,
  actionId text REFERENCES deadlines(id) ON DELETE SET NULL,
  state text NOT NULL,
  snapshot text NOT NULL,
  createdAt integer NOT NULL,
  updatedAt integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS case_action_proposals_owner_case_idx ON case_action_proposals(userId, caseId);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS case_action_proposals_action_idx ON case_action_proposals(actionId);
