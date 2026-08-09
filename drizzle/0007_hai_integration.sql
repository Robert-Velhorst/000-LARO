CREATE TABLE `integration_access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`tokenPrefix` text NOT NULL,
	`tokenHash` text NOT NULL,
	`scope` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expiresAt` integer NOT NULL,
	`lastUsedAt` integer,
	`createdAt` integer NOT NULL,
	`revokedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_access_tokens_hash_unique` ON `integration_access_tokens` (`tokenHash`);
--> statement-breakpoint
CREATE INDEX `integration_access_tokens_user_status_idx` ON `integration_access_tokens` (`userId`,`status`);
--> statement-breakpoint
CREATE INDEX `cases_userId_updatedAt_idx` ON `cases` (`userId`,`updatedAt`);
--> statement-breakpoint
CREATE INDEX `document_analyses_user_updatedAt_idx` ON `document_analyses` (`userId`,`updatedAt`);
--> statement-breakpoint
CREATE INDEX `audit_logs_createdAt_idx` ON `audit_logs` (`createdAt`);
