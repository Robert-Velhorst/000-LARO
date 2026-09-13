ALTER TABLE `document_inbox` ADD COLUMN `sourceType` text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE `document_inbox` ADD COLUMN `provenance` text;
--> statement-breakpoint
DROP INDEX IF EXISTS `document_inbox_owner_source_hash_idx`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `document_inbox_owner_source_identity_idx` ON `document_inbox` (`userId`, `sourceType`, `sourcePath`, `contentHash`);
