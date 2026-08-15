CREATE TABLE `storage_deletion_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`storageKey` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`nextAttemptAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `storage_deletion_queue_storageKey_unique` ON `storage_deletion_queue` (`storageKey`);
--> statement-breakpoint
CREATE INDEX `storage_deletion_queue_nextAttemptAt_idx` ON `storage_deletion_queue` (`nextAttemptAt`);
