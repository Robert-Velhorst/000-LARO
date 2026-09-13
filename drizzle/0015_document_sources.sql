CREATE TABLE IF NOT EXISTS `document_source_jobs` (
  `id` text PRIMARY KEY NOT NULL,
  `userId` text NOT NULL REFERENCES `users` (`id`),
  `kind` text NOT NULL,
  `config` text NOT NULL,
  `status` text DEFAULT 'running' NOT NULL,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_source_jobs_owner_status_idx` ON `document_source_jobs` (`userId`, `status`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `document_source_work` (
  `id` text PRIMARY KEY NOT NULL,
  `jobId` text NOT NULL REFERENCES `document_source_jobs` (`id`) ON DELETE CASCADE,
  `userId` text NOT NULL REFERENCES `users` (`id`),
  `kind` text NOT NULL,
  `payload` text NOT NULL,
  `label` text NOT NULL,
  `isDocument` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `inboxId` text REFERENCES `document_inbox` (`id`) ON DELETE SET NULL,
  `error` text,
  `leaseToken` text,
  `leaseUntil` integer,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_source_work_job_status_idx` ON `document_source_work` (`jobId`, `status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_source_work_lease_idx` ON `document_source_work` (`status`, `leaseUntil`);
