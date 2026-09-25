DELETE FROM `communication_gaps`
WHERE `caseId` IS NULL OR NOT EXISTS (
	SELECT 1
	FROM `case_strength_analysis` AS `coverage`
	WHERE `coverage`.`caseId` = `communication_gaps`.`caseId`
		AND CASE
			WHEN json_valid(`coverage`.`data`)
			THEN COALESCE(json_extract(`coverage`.`data`, '$.contractVersion'), '') = 'evidence-coverage-v1'
				AND COALESCE(json_extract(`coverage`.`data`, '$.contractStatus'), '') = 'current'
			ELSE 0
		END
);--> statement-breakpoint
DELETE FROM `expected_documents`
WHERE `caseId` IS NULL OR NOT EXISTS (
	SELECT 1
	FROM `case_strength_analysis` AS `coverage`
	WHERE `coverage`.`caseId` = `expected_documents`.`caseId`
		AND CASE
			WHEN json_valid(`coverage`.`data`)
			THEN COALESCE(json_extract(`coverage`.`data`, '$.contractVersion'), '') = 'evidence-coverage-v1'
				AND COALESCE(json_extract(`coverage`.`data`, '$.contractStatus'), '') = 'current'
			ELSE 0
		END
);--> statement-breakpoint
DELETE FROM `suspicious_patterns`
WHERE `caseId` IS NULL OR NOT EXISTS (
	SELECT 1
	FROM `case_strength_analysis` AS `coverage`
	WHERE `coverage`.`caseId` = `suspicious_patterns`.`caseId`
		AND CASE
			WHEN json_valid(`coverage`.`data`)
			THEN COALESCE(json_extract(`coverage`.`data`, '$.contractVersion'), '') = 'evidence-coverage-v1'
				AND COALESCE(json_extract(`coverage`.`data`, '$.contractStatus'), '') = 'current'
			ELSE 0
		END
);--> statement-breakpoint
DELETE FROM `legal_inferences`
WHERE `caseId` IS NULL OR NOT EXISTS (
	SELECT 1
	FROM `case_strength_analysis` AS `coverage`
	WHERE `coverage`.`caseId` = `legal_inferences`.`caseId`
		AND CASE
			WHEN json_valid(`coverage`.`data`)
			THEN COALESCE(json_extract(`coverage`.`data`, '$.contractVersion'), '') = 'evidence-coverage-v1'
				AND COALESCE(json_extract(`coverage`.`data`, '$.contractStatus'), '') = 'current'
			ELSE 0
		END
);--> statement-breakpoint
UPDATE `case_strength_analysis`
SET `data` = json_object(
	'contractVersion', 'legacy-case-strength-v0',
	'contractStatus', 'retired',
	'retirementReason', 'This saved row was produced by the retired scoring contract. Re-run coverage review to create a source-revision inventory.',
	'retiredAt', '2026-09-19T00:00:00.000Z'
)
WHERE CASE
	WHEN json_valid(`data`)
	THEN COALESCE(json_extract(`data`, '$.contractVersion'), '') <> 'evidence-coverage-v1'
		OR COALESCE(json_extract(`data`, '$.contractStatus'), '') <> 'current'
	ELSE 1
END;
