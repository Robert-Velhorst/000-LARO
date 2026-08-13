DELETE FROM `user_preferences`
WHERE rowid IN (
  SELECT rowid FROM (
    SELECT
      rowid,
      ROW_NUMBER() OVER (
        PARTITION BY `userId`, `key`
        ORDER BY COALESCE(`updatedAt`, 0) DESC, rowid DESC
      ) AS `preferenceRank`
    FROM `user_preferences`
    WHERE `key` IS NOT NULL
  )
  WHERE `preferenceRank` > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `user_preferences_user_key_unique` ON `user_preferences` (`userId`, `key`);
