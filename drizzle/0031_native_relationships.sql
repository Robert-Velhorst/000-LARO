CREATE TABLE `laro_relationship_baseline` (
	`version` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`relationshipCount` integer,
	`tablesRebuilt` integer,
	`reconciledAt` integer
);
--> statement-breakpoint
INSERT INTO `laro_relationship_baseline`
  (`version`, `name`, `relationshipCount`, `tablesRebuilt`, `reconciledAt`)
VALUES (1, 'native-relationships-v1', NULL, NULL, NULL);
