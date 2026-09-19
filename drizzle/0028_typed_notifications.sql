ALTER TABLE `notifications` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `actionUrl` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `metadata` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `caseId` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `lawyerId` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `evidenceFileId` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `dedupKey` text;--> statement-breakpoint
UPDATE `notifications`
SET `kind` = 'system_announcement'
WHERE `kind` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_user_dedup_unique`
ON `notifications` (`userId`, `dedupKey`);--> statement-breakpoint
CREATE INDEX `notifications_user_created_idx`
ON `notifications` (`userId`, `createdAt`);
