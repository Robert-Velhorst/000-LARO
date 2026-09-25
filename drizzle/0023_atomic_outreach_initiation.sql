CREATE UNIQUE INDEX IF NOT EXISTS `outreach_status_case_lawyer_unique`
  ON `outreach_status` (`caseId`,`lawyerId`);
