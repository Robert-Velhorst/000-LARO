CREATE TABLE `laro_schema_baseline` (
	`version` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`reconciledAt` integer
);
--> statement-breakpoint
INSERT INTO `laro_schema_baseline` (`version`, `name`, `reconciledAt`)
VALUES (1, 'non-destructive-v1', NULL);
