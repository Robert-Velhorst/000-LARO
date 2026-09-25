DELETE FROM `system_config`
WHERE `configKey` IN ('flag:analytics.enabled', 'flag:demo.mode');
