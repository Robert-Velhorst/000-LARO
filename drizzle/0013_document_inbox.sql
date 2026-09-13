CREATE TABLE IF NOT EXISTS `document_inbox` (
  `id` text PRIMARY KEY NOT NULL,
  `userId` text NOT NULL REFERENCES `users`(`id`),
  `fileName` text NOT NULL,
  `sourcePath` text NOT NULL,
  `mimeType` text NOT NULL,
  `fileSize` integer NOT NULL,
  `storageKey` text NOT NULL,
  `contentHash` text NOT NULL,
  `analysis` text,
  `sourceText` text,
  `error` text,
  `decision` text DEFAULT 'pending' NOT NULL,
  `reason` text,
  `evidenceId` text REFERENCES `evidence`(`id`) ON DELETE SET NULL,
  `createdAt` integer NOT NULL,
  `updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `document_inbox_owner_source_hash_idx` ON `document_inbox` (`userId`, `sourcePath`, `contentHash`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `document_inbox_owner_created_idx` ON `document_inbox` (`userId`, `createdAt`);
