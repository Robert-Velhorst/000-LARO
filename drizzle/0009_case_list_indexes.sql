CREATE INDEX IF NOT EXISTS `cases_userId_createdAt_idx` ON `cases` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cases_userId_status_createdAt_idx` ON `cases` (`userId`,`status`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cases_userId_urgency_createdAt_idx` ON `cases` (`userId`,`urgency`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cases_userId_status_urgency_createdAt_idx` ON `cases` (`userId`,`status`,`urgency`,`createdAt`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `cases_userId_clientName_idx` ON `cases` (`userId`,`clientName`);
