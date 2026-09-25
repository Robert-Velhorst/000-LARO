CREATE TABLE `laro_numeric_baseline` (
	`version` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`columnCount` integer,
	`tablesRebuilt` integer,
	`reconciledAt` integer
);
--> statement-breakpoint
INSERT INTO `laro_numeric_baseline`
  (`version`, `name`, `columnCount`, `tablesRebuilt`, `reconciledAt`)
VALUES (1, 'numeric-normalization-v1', NULL, NULL, NULL);
