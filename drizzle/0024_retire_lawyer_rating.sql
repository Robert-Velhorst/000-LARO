CREATE TABLE `__retire_lawyer_rating_guard` (
	`rowCount` integer NOT NULL CHECK (`rowCount` = 0)
);
--> statement-breakpoint
INSERT INTO `__retire_lawyer_rating_guard` (`rowCount`)
SELECT
	(SELECT COUNT(*) FROM `lawyer_ratings`) +
	(SELECT COUNT(*) FROM `lawyer_interactions`) +
	(SELECT COUNT(*) FROM `rating_calculation_logs`);
--> statement-breakpoint
DROP TABLE `__retire_lawyer_rating_guard`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_lawyer_ratings_lawyerId_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_lawyer_ratings_lawyerId_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_lawyer_ratings_lawyerId_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_lawyer_interactions_lawyerId_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_lawyer_interactions_lawyerId_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_lawyer_interactions_lawyerId_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_rating_calculation_logs_lawyerId_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_rating_calculation_logs_lawyerId_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `laro_ri_rating_calculation_logs_lawyerId_delete`;
--> statement-breakpoint
DROP TABLE `rating_calculation_logs`;
--> statement-breakpoint
DROP TABLE `lawyer_interactions`;
--> statement-breakpoint
DROP TABLE `lawyer_ratings`;
