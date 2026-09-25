ALTER TABLE users ADD COLUMN resetCodeFailures integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN resetCodeLockedUntil integer;
