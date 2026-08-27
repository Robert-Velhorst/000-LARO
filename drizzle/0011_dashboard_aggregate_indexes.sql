CREATE INDEX IF NOT EXISTS `evidence_userId_caseId_idx` ON `evidence` (`userId`,`caseId`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outreach_status_caseId_status_idx` ON `outreach_status` (`caseId`,`status`);
