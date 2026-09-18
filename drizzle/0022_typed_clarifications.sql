ALTER TABLE `clarification_questions` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `clarification_questions` ADD `context` text;--> statement-breakpoint
ALTER TABLE `clarification_questions` ADD `answeredBy` text;--> statement-breakpoint
ALTER TABLE `clarification_questions` ADD `applied` integer;--> statement-breakpoint
ALTER TABLE `clarification_questions` ADD `outcome` text;--> statement-breakpoint
ALTER TABLE `clarification_questions` ADD `reviewStatus` text;--> statement-breakpoint
ALTER TABLE `clarification_questions` ADD `provenance` text;--> statement-breakpoint
ALTER TABLE `clarification_questions` ADD `answeredAt` integer;--> statement-breakpoint
ALTER TABLE `clarification_questions` ADD `updatedAt` integer;--> statement-breakpoint
CREATE INDEX `clarification_questions_owner_status_idx` ON `clarification_questions` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `clarification_questions_case_kind_idx` ON `clarification_questions` (`caseId`,`kind`);--> statement-breakpoint
INSERT OR IGNORE INTO `clarification_questions`
  (`id`, `caseId`, `userId`, `kind`, `question`, `status`, `applied`, `outcome`, `reviewStatus`, `provenance`, `createdAt`, `updatedAt`)
SELECT
  c.`id` || ':primary-area', c.`id`, c.`userId`, 'primary_legal_area',
  'Legacy primary legal-area clarification', 'answered', 0,
  'legacy_resolution_without_answer', 'legacy',
  '{"source":"legacy_system_config","answerAvailable":false}',
  COALESCE(s.`updatedAt`, CAST(strftime('%s','now') AS integer)),
  COALESCE(s.`updatedAt`, CAST(strftime('%s','now') AS integer))
FROM `cases` c
JOIN `system_config` s
  ON s.`configKey` = 'clarify:' || c.`userId` || ':' || c.`id` || ':primary-area'
 AND s.`configValue` = 'true';--> statement-breakpoint
INSERT OR IGNORE INTO `clarification_questions`
  (`id`, `caseId`, `userId`, `kind`, `question`, `status`, `applied`, `outcome`, `reviewStatus`, `provenance`, `createdAt`, `updatedAt`)
SELECT
  c.`id` || ':contact', c.`id`, c.`userId`, 'contact_email',
  'Legacy contact clarification', 'answered', 0,
  'legacy_resolution_without_answer', 'legacy',
  '{"source":"legacy_system_config","answerAvailable":false}',
  COALESCE(s.`updatedAt`, CAST(strftime('%s','now') AS integer)),
  COALESCE(s.`updatedAt`, CAST(strftime('%s','now') AS integer))
FROM `cases` c
JOIN `system_config` s
  ON s.`configKey` = 'clarify:' || c.`userId` || ':' || c.`id` || ':contact'
 AND s.`configValue` = 'true';
