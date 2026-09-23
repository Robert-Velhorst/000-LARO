CREATE TABLE `legacy_billing_archive` (
	`id` text PRIMARY KEY NOT NULL,
	`sourceTable` text NOT NULL,
	`sourceId` text NOT NULL,
	`ownerId` text,
	`payload` text NOT NULL,
	`archivedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_billing_archive_source_unique`
	ON `legacy_billing_archive` (`sourceTable`, `sourceId`);
--> statement-breakpoint
INSERT INTO `legacy_billing_archive`
	(`id`, `sourceTable`, `sourceId`, `ownerId`, `payload`, `archivedAt`)
SELECT
	'users:' || `id`,
	'users',
	`id`,
	`id`,
	json_object(
		'stripeCustomerId', `stripeCustomerId`,
		'stripeSubscriptionId', `stripeSubscriptionId`,
		'subscriptionStatus', `subscriptionStatus`,
		'subscriptionTier', `subscriptionTier`,
		'paymentFailedAt', `paymentFailedAt`,
		'gracePeriodEndsAt', `gracePeriodEndsAt`
	),
	CAST(unixepoch('now') * 1000 AS integer)
FROM `users`
WHERE `stripeCustomerId` IS NOT NULL
	OR `stripeSubscriptionId` IS NOT NULL
	OR COALESCE(`subscriptionStatus`, 'free') <> 'free'
	OR COALESCE(`subscriptionTier`, 'free') <> 'free'
	OR `paymentFailedAt` IS NOT NULL
	OR `gracePeriodEndsAt` IS NOT NULL;
--> statement-breakpoint
INSERT INTO `legacy_billing_archive`
	(`id`, `sourceTable`, `sourceId`, `ownerId`, `payload`, `archivedAt`)
SELECT
	'billing_periods:' || `id`,
	'billing_periods',
	`id`,
	`userId`,
	json_object(
		'userId', `userId`,
		'stripeSubscriptionId', `stripeSubscriptionId`,
		'stripeInvoiceId', `stripeInvoiceId`,
		'periodStart', `periodStart`,
		'periodEnd', `periodEnd`,
		'status', `status`,
		'metadata', `metadata`,
		'totalCost', `totalCost`,
		'totalBilledCost', `totalBilledCost`,
		'createdAt', `createdAt`
	),
	CAST(unixepoch('now') * 1000 AS integer)
FROM `billing_periods`;
--> statement-breakpoint
INSERT INTO `legacy_billing_archive`
	(`id`, `sourceTable`, `sourceId`, `ownerId`, `payload`, `archivedAt`)
SELECT
	'usage_limits:' || `id`,
	'usage_limits',
	`id`,
	`userId`,
	json_object(
		'userId', `userId`,
		'tier', `tier`,
		'resourceType', `resourceType`,
		'monthlyLimit', `monthlyLimit`,
		'description', `description`,
		'limitsJson', `limitsJson`,
		'updatedAt', `updatedAt`
	),
	CAST(unixepoch('now') * 1000 AS integer)
FROM `usage_limits`;
--> statement-breakpoint
INSERT INTO `legacy_billing_archive`
	(`id`, `sourceTable`, `sourceId`, `ownerId`, `payload`, `archivedAt`)
SELECT
	'usage_tracking:' || `id`,
	'usage_tracking',
	`id`,
	`userId`,
	json_object(
		'userId', `userId`,
		'resourceType', `resourceType`,
		'quantity', `quantity`,
		'baseCost', `baseCost`,
		'billedCost', `billedCost`,
		'metadata', `metadata`,
		'caseId', `caseId`,
		'reportedToStripe', `reportedToStripe`,
		'stripeUsageRecordId', `stripeUsageRecordId`,
		'timestamp', `timestamp`,
		'createdAt', `createdAt`
	),
	CAST(unixepoch('now') * 1000 AS integer)
FROM `usage_tracking`
WHERE `baseCost` IS NOT NULL
	OR `billedCost` IS NOT NULL
	OR COALESCE(`reportedToStripe`, 0) <> 0
	OR `stripeUsageRecordId` IS NOT NULL;
--> statement-breakpoint
DROP TABLE `billing_periods`;
--> statement-breakpoint
DROP TABLE `usage_limits`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `stripeCustomerId`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `stripeSubscriptionId`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `subscriptionStatus`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `subscriptionTier`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `paymentFailedAt`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `gracePeriodEndsAt`;
--> statement-breakpoint
ALTER TABLE `usage_tracking` DROP COLUMN `baseCost`;
--> statement-breakpoint
ALTER TABLE `usage_tracking` DROP COLUMN `billedCost`;
--> statement-breakpoint
ALTER TABLE `usage_tracking` DROP COLUMN `reportedToStripe`;
--> statement-breakpoint
ALTER TABLE `usage_tracking` DROP COLUMN `stripeUsageRecordId`;
--> statement-breakpoint
CREATE TRIGGER `legacy_billing_archive_no_insert`
BEFORE INSERT ON `legacy_billing_archive`
BEGIN
	SELECT RAISE(ABORT, 'legacy billing archive is read-only');
END;
--> statement-breakpoint
CREATE TRIGGER `legacy_billing_archive_no_update`
BEFORE UPDATE ON `legacy_billing_archive`
BEGIN
	SELECT RAISE(ABORT, 'legacy billing archive is read-only');
END;
--> statement-breakpoint
CREATE TRIGGER `legacy_billing_archive_no_delete`
BEFORE DELETE ON `legacy_billing_archive`
BEGIN
	SELECT RAISE(ABORT, 'legacy billing archive is read-only');
END;
