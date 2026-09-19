CREATE TABLE `hai_access_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`caseIds` text NOT NULL,
	`fieldCategories` text NOT NULL,
	`includeFutureCases` integer DEFAULT false NOT NULL,
	`includeFutureAnalyses` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`reviewedAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	`revokedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `hai_access_grants_revision_check` CHECK (`revision` >= 1),
	CONSTRAINT `hai_access_grants_case_ids_json_check` CHECK (json_valid(`caseIds`) AND json_type(`caseIds`) = 'array'),
	CONSTRAINT `hai_access_grants_fields_json_check` CHECK (json_valid(`fieldCategories`) AND json_type(`fieldCategories`) = 'array')
);
--> statement-breakpoint
ALTER TABLE `integration_access_tokens` ADD `grantId` text REFERENCES `hai_access_grants`(`id`) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `hai_access_grants_user_idx` ON `hai_access_grants` (`userId`);
--> statement-breakpoint
CREATE INDEX `hai_access_grants_user_revoked_idx` ON `hai_access_grants` (`userId`,`revokedAt`);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_access_tokens_grant_unique` ON `integration_access_tokens` (`grantId`);
--> statement-breakpoint
UPDATE `integration_access_tokens`
SET `status` = 'revoked', `revokedAt` = CAST(unixepoch('now') * 1000 AS integer)
WHERE `status` = 'active' AND `grantId` IS NULL;
