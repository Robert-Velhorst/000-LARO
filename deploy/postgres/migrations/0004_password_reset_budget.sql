ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "resetCodeFailures" bigint NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "resetCodeLockedUntil" bigint;
