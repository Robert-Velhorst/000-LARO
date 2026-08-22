-- Generated from the final checked-in SQLite migration state.
-- Review this baseline with every local schema evolution before hosted deployment.
CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" text NOT NULL,
  "userId" text,
  "action" text,
  "resource" text,
  "entityType" text,
  "entityId" text,
  "details" text,
  "ipAddress" text,
  "userAgent" text,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "auto_collection_logs" (
  "id" text NOT NULL,
  "caseId" text,
  "settingsId" text,
  "userId" text,
  "runStartedAt" bigint,
  "runCompletedAt" bigint,
  "status" text,
  "emailsFound" text,
  "emailsProcessed" text,
  "filesFound" text,
  "filesDownloaded" text,
  "errorCount" text,
  "errorMessage" text,
  "executionTimeSeconds" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "auto_collection_settings" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "keywords" text,
  "keywordMatchMode" text,
  "dateRangeStart" bigint,
  "dateRangeEnd" bigint,
  "emailAccountIds" text,
  "googleDriveFolderIds" text,
  "autoDownloadAttachments" bigint,
  "autoDownloadGoogleDriveFiles" bigint,
  "isEnabled" bigint DEFAULT 1,
  "status" text,
  "lastRunAt" bigint,
  "totalItemsCollected" text,
  "totalEmailsCollected" text,
  "totalFilesCollected" text,
  "metadata" text,
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "billing_periods" (
  "id" text NOT NULL,
  "userId" text,
  "stripeSubscriptionId" text,
  "stripeInvoiceId" text,
  "periodStart" bigint,
  "periodEnd" bigint,
  "status" text,
  "metadata" text,
  "totalCost" text,
  "totalBilledCost" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "bulk_import_jobs" (
  "id" text NOT NULL,
  "userId" text,
  "filename" text,
  "status" text,
  "totalRows" text DEFAULT '0',
  "processedRows" text DEFAULT '0',
  "failedRows" text DEFAULT '0',
  "errors" text,
  "completedAt" bigint,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "case_strength_analysis" (
  "id" text NOT NULL,
  "caseId" text,
  "data" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "cases" (
  "id" text NOT NULL,
  "userId" text NOT NULL,
  "clientName" text,
  "clientEmail" text,
  "clientPhone" text,
  "clientAddress" text,
  "caseType" text,
  "caseSummary" text,
  "urgency" text,
  "status" text DEFAULT 'active',
  "legalAreas" text,
  "preferredLanguages" text,
  "latitude" text,
  "longitude" text,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "channel_integrations" (
  "id" text NOT NULL,
  "userId" text,
  "provider" text,
  "status" text DEFAULT 'active',
  "lastSyncAt" bigint,
  "nextSyncAt" bigint,
  "syncFrequency" bigint DEFAULT 3600,
  "errorMessage" text,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "clarification_questions" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "question" text,
  "answer" text,
  "status" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "communication_gaps" (
  "id" text NOT NULL,
  "caseId" text,
  "data" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "communications" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "channel" text,
  "type" text,
  "direction" text,
  "subject" text,
  "body" text,
  "content" text,
  "timestamp" bigint,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "conversation_threads" (
  "id" text NOT NULL,
  "userId" text,
  "caseId" text,
  "title" text,
  "status" text DEFAULT 'active',
  "priority" text DEFAULT 'normal',
  "participants" text,
  "channels" text,
  "firstMessageAt" bigint,
  "lastMessageAt" bigint,
  "messageCount" bigint DEFAULT 0,
  "unreadCount" bigint DEFAULT 0,
  "aiSummary" text,
  "aiTopics" text,
  "metadata" text,
  "archivedAt" bigint,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "deadlines" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "title" text,
  "description" text,
  "dueDate" bigint,
  "completed" bigint DEFAULT 0,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "documents" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "title" text,
  "content" text,
  "name" text,
  "type" text,
  "folder" text,
  "uploadedAt" bigint,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "email_accounts" (
  "id" text NOT NULL,
  "userId" text NOT NULL,
  "provider" text,
  "email" text,
  "displayName" text,
  "accessToken" text,
  "refreshToken" text,
  "tokenExpiry" bigint,
  "status" text,
  "connectedAt" bigint,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "email_activity" (
  "id" text NOT NULL,
  "caseId" text,
  "lawyerId" text,
  "activityType" text,
  "emailType" text,
  "recipientEmail" text,
  "subject" text,
  "metadata" text,
  "responseReceived" text,
  "responseStatus" text,
  "sentAt" bigint,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "email_messages" (
  "id" text NOT NULL,
  "accountId" text,
  "caseId" text,
  "category" text,
  "relevanceScore" text,
  "subject" text,
  "snippet" text,
  "body" text,
  "date" bigint,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "email_sync_jobs" (
  "id" text NOT NULL,
  "accountId" text,
  "caseId" text,
  "status" text,
  "startDate" bigint,
  "endDate" bigint,
  "keywords" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "evidence" (
  "id" text NOT NULL,
  "caseId" text NOT NULL,
  "userId" text NOT NULL,
  "type" text NOT NULL,
  "source" text,
  "title" text NOT NULL,
  "description" text,
  "fileUrl" text,
  "fileName" text,
  "fileSize" text,
  "mimeType" text,
  "metadata" text,
  "tags" text,
  "relevant" bigint DEFAULT 1,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "evidence_file_tags" (
  "id" text NOT NULL,
  "evidenceFileId" text,
  "tagId" text,
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "evidence_files" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text NOT NULL,
  "fileType" text,
  "fileSize" text,
  "uploadSource" text DEFAULT 'manual',
  "uploadedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "fileName" text,
  "mimeType" text,
  "storageKey" text,
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "evidence_items" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "source" text,
  "sourceId" text,
  "sourceType" text,
  "fileName" text,
  "title" text,
  "description" text,
  "type" text,
  "folder" text,
  "size" text,
  "tags" text,
  "relevance" bigint,
  "relevanceScore" bigint,
  "content" text,
  "metadata" text,
  "timestamp" bigint,
  "uploadedAt" bigint,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "evidence_sources" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "provider" text,
  "sourceType" text,
  "externalId" text,
  "sourceIdentifier" text,
  "connectionStatus" text,
  "status" text,
  "accessToken" text,
  "itemsCollected" bigint,
  "itemCount" bigint,
  "lastSyncedAt" bigint,
  "connectedAt" bigint,
  "errorMessage" text,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "evidence_tags" (
  "id" text NOT NULL,
  "userId" text,
  "name" text,
  "color" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "expected_documents" (
  "id" text NOT NULL,
  "caseId" text,
  "data" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "extracted_entities" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "entityType" text,
  "value" text,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "google_drive_files" (
  "id" text NOT NULL,
  "userId" text,
  "caseId" text,
  "accountId" text,
  "googleFileId" text,
  "fileName" text,
  "mimeType" text,
  "fileSize" text,
  "s3Key" text,
  "s3Url" text,
  "googleWebViewLink" text,
  "googleModifiedTime" bigint,
  "evidenceType" text,
  "isIncluded" text,
  "relevanceScore" text,
  "category" text,
  "userNotes" text,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "keyword_matches" (
  "id" text NOT NULL,
  "caseId" text,
  "itemId" text,
  "itemType" text,
  "matchedKeywords" text,
  "matchCount" text,
  "source" text,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "lawyer_interactions" (
  "id" text NOT NULL,
  "lawyerId" text NOT NULL,
  "caseId" text NOT NULL,
  "interactionType" text NOT NULL,
  "outreachSentAt" bigint,
  "responseReceivedAt" bigint,
  "responseTimeHours" text,
  "responseText" text,
  "responseLength" text,
  "completenessScore" text,
  "professionalismScore" text,
  "helpfulnessScore" text,
  "clarityScore" text,
  "aiAnalysis" text,
  "acceptedCase" bigint DEFAULT 0,
  "declinedCase" bigint DEFAULT 0,
  "providedAlternatives" bigint DEFAULT 0,
  "askedClarifyingQuestions" bigint DEFAULT 0,
  "finalOutcome" text DEFAULT 'pending',
  "outcomeNotes" text,
  "analyzedAt" bigint,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "lawyer_ratings" (
  "id" text NOT NULL,
  "lawyerId" text,
  "overallRating" text NOT NULL,
  "totalInteractions" text DEFAULT '0',
  "ratingConfidence" text DEFAULT 'low',
  "responseTimeScore" text,
  "completenessScore" text,
  "cooperationScore" text,
  "ratingTrend" text DEFAULT 'stable',
  "lastCalculatedAt" bigint,
  "lastInteractionAt" bigint,
  "averageResponseTimeHours" text,
  "fastResponses" text DEFAULT '0',
  "mediumResponses" text DEFAULT '0',
  "slowResponses" text DEFAULT '0',
  "verySlowResponses" text DEFAULT '0',
  "averageCompletenessScore" text,
  "completeAnswers" text DEFAULT '0',
  "partialAnswers" text DEFAULT '0',
  "incompleteAnswers" text DEFAULT '0',
  "averageCooperationScore" text,
  "casesAccepted" text DEFAULT '0',
  "casesDeclined" text DEFAULT '0',
  "casesNoResponse" text DEFAULT '0',
  "acceptanceRate" text,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "lawyers" (
  "id" text NOT NULL,
  "name" text,
  "city" text,
  "firm" text,
  "firmName" text,
  "legalAreas" text,
  "email" text,
  "phone" text,
  "website" text,
  "address" text,
  "latitude" text,
  "longitude" text,
  "permanentlyFiltered" text DEFAULT 'No',
  "filterUntil" bigint,
  "totalOutreaches" text DEFAULT '0',
  "totalResponses" text DEFAULT '0',
  "totalAcceptances" text DEFAULT '0',
  "averageResponseTimeHours" text,
  "caseLoad" text DEFAULT '0',
  "caseStop" text DEFAULT 'No',
  "experienceYears" text DEFAULT '0',
  "barAssociationStatus" text DEFAULT 'Good Standing',
  "currentlyAccepting" text DEFAULT 'Yes',
  "capacityPercentage" text DEFAULT '0',
  "languages" text,
  "novaId" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "officialProfileUrl" text,
  "officialLegalAreas" text,
  "specializationAssociations" text,
  "admissionDate" text,
  "district" text,
  "financedLegalAid" text,
  "directorySource" text,
  "directoryRetrievedAt" bigint,
  "directoryDistanceKm" text,
  "directorySearchLocation" text,
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "legal_inferences" (
  "id" text NOT NULL,
  "caseId" text,
  "data" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "message_templates" (
  "id" text NOT NULL,
  "userId" text,
  "name" text,
  "body" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "messages" (
  "id" text NOT NULL,
  "userId" text,
  "caseId" text,
  "content" text,
  "threadId" text,
  "parentId" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "notifications" (
  "id" text NOT NULL,
  "userId" text,
  "title" text,
  "body" text,
  "read" bigint DEFAULT 0,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "outreach_status" (
  "id" text NOT NULL,
  "caseId" text,
  "lawyerId" text,
  "status" text,
  "initialContact" bigint,
  "lastContact" bigint,
  "followUpsSent" bigint,
  "followUp1SentAt" bigint,
  "followUp2SentAt" bigint,
  "responseTimeHours" text,
  "lawyerCapacityPercentage" text,
  "acceptanceStatus" text,
  "response" text,
  "responseReceived" text DEFAULT 'No',
  "notes" text,
  "distanceKm" bigint,
  "metadata" text,
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "rating_calculation_logs" (
  "id" text NOT NULL,
  "lawyerId" text,
  "calculationType" text,
  "interactionsAnalyzed" text,
  "previousRating" text,
  "newRating" text,
  "ratingChange" text,
  "responseTimeComponent" text,
  "completenessComponent" text,
  "cooperationComponent" text,
  "calculationDetails" text,
  "triggeredBy" text,
  "log" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "saved_searches" (
  "id" text NOT NULL,
  "userId" text NOT NULL,
  "name" text,
  "queryJson" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "storage_deletion_queue" (
  "id" text NOT NULL,
  "storageKey" text NOT NULL,
  "attempts" bigint DEFAULT 0 NOT NULL,
  "lastError" text,
  "nextAttemptAt" bigint NOT NULL,
  "createdAt" bigint NOT NULL,
  "updatedAt" bigint NOT NULL,
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "support_tickets" (
  "id" text NOT NULL,
  "userId" text,
  "category" text NOT NULL,
  "subject" text NOT NULL,
  "message" text NOT NULL,
  "status" text DEFAULT 'open',
  "createdAt" bigint NOT NULL,
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "suspicious_patterns" (
  "id" text NOT NULL,
  "caseId" text,
  "data" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "system_config" (
  "configKey" text NOT NULL,
  "configValue" text,
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("configKey")
);
CREATE TABLE IF NOT EXISTS "timeline" (
  "id" text NOT NULL,
  "caseId" text,
  "userId" text,
  "eventType" text,
  "title" text,
  "description" text,
  "eventAt" bigint,
  "metadata" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "unified_messages" (
  "id" text NOT NULL,
  "userId" text,
  "caseId" text,
  "threadId" text,
  "channel" text,
  "externalId" text,
  "sender" text,
  "recipient" text,
  "subject" text,
  "body" text,
  "direction" text,
  "status" text DEFAULT 'received',
  "priority" text DEFAULT 'normal',
  "metadata" text,
  "attachmentCount" bigint DEFAULT 0,
  "readAt" bigint,
  "sentAt" bigint,
  "receivedAt" bigint,
  "aiSubject" text,
  "aiSentiment" text,
  "aiCategory" text,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "usage_limits" (
  "id" text NOT NULL,
  "userId" text,
  "tier" text,
  "resourceType" text,
  "monthlyLimit" text,
  "description" text,
  "limitsJson" text,
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "usage_tracking" (
  "id" text NOT NULL,
  "userId" text,
  "resourceType" text,
  "quantity" text,
  "baseCost" text,
  "billedCost" text,
  "metadata" text,
  "caseId" text,
  "reportedToStripe" bigint DEFAULT 0,
  "stripeUsageRecordId" text,
  "timestamp" bigint,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "user_preferences" (
  "id" text NOT NULL,
  "userId" text NOT NULL,
  "key" text,
  "value" text,
  "theme" text,
  "dashboardWidgets" text,
  "notificationSettings" text,
  "preferredLawyers" text,
  "caseTemplates" text,
  "updatedAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "userPreferences" text,
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "users" (
  "id" text NOT NULL,
  "name" text,
  "email" text,
  "password" text,
  "loginMethod" text,
  "role" text DEFAULT 'user' NOT NULL,
  "stripeCustomerId" text,
  "stripeSubscriptionId" text,
  "subscriptionStatus" text DEFAULT 'free',
  "subscriptionTier" text DEFAULT 'free',
  "emailPreferences" text,
  "paymentFailedAt" bigint,
  "gracePeriodEndsAt" bigint,
  "createdAt" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  "lastSignedIn" bigint DEFAULT ((EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint),
  PRIMARY KEY ("id")
);
CREATE TABLE IF NOT EXISTS "document_analyses" (
  "id" text NOT NULL,
  "evidenceId" text NOT NULL,
  "caseId" text NOT NULL,
  "userId" text NOT NULL,
  "analysisVersion" text NOT NULL,
  "contentHash" text NOT NULL,
  "status" text NOT NULL,
  "extractionMethod" text NOT NULL,
  "providerStatus" text NOT NULL,
  "documentType" text NOT NULL,
  "confidence" bigint NOT NULL,
  "summary" text NOT NULL,
  "result" text NOT NULL,
  "analyzedChars" bigint NOT NULL,
  "createdAt" bigint NOT NULL,
  "updatedAt" bigint NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("caseId") REFERENCES "cases" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("evidenceId") REFERENCES "evidence" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "integration_access_tokens" (
  "id" text NOT NULL,
  "userId" text NOT NULL,
  "name" text NOT NULL,
  "tokenPrefix" text NOT NULL,
  "tokenHash" text NOT NULL,
  "scope" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "expiresAt" bigint NOT NULL,
  "lastUsedAt" bigint,
  "createdAt" bigint NOT NULL,
  "revokedAt" bigint,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "keyword_pull_jobs" (
  "id" text NOT NULL,
  "caseId" text NOT NULL,
  "userId" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "phase" text DEFAULT 'queued' NOT NULL,
  "message" text DEFAULT 'Waiting to start' NOT NULL,
  "processedWords" bigint DEFAULT 0 NOT NULL,
  "totalWords" bigint DEFAULT 0 NOT NULL,
  "processedItems" bigint DEFAULT 0 NOT NULL,
  "totalItems" bigint DEFAULT 0 NOT NULL,
  "estimatedSecondsRemaining" bigint,
  "result" text,
  "error" text,
  "createdAt" bigint NOT NULL,
  "startedAt" bigint,
  "updatedAt" bigint NOT NULL,
  "completedAt" bigint,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("caseId") REFERENCES "cases" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "legacy_import_runs" (
  "id" text NOT NULL,
  "sourceRuntime" text NOT NULL,
  "sourceInstanceId" text NOT NULL,
  "userId" text NOT NULL,
  "sourceUserId" text NOT NULL,
  "sourceUserEmail" text,
  "status" text NOT NULL,
  "sourceSnapshotHash" text NOT NULL,
  "recordsImported" bigint NOT NULL,
  "casesImported" bigint NOT NULL,
  "filesCopied" bigint NOT NULL,
  "missingFiles" bigint NOT NULL,
  "summary" text NOT NULL,
  "startedAt" bigint NOT NULL,
  "completedAt" bigint,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "outreach_directory_targets" (
  "id" text NOT NULL,
  "userId" text NOT NULL,
  "targetType" text NOT NULL,
  "name" text NOT NULL,
  "subtype" text,
  "description" text,
  "topics" text,
  "legalAreas" text,
  "audience" text,
  "channels" text,
  "region" text,
  "url" text NOT NULL,
  "contactUrl" text,
  "sourceUrl" text,
  "sourceLabel" text,
  "sourceRetrievedAt" bigint,
  "status" text DEFAULT 'pending' NOT NULL,
  "confidence" text DEFAULT 'discovery_candidate' NOT NULL,
  "reviewNotes" text,
  "reviewedAt" bigint,
  "createdAt" bigint NOT NULL,
  "updatedAt" bigint NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "case_outreach_target_matches" (
  "id" text NOT NULL,
  "userId" text NOT NULL,
  "caseId" text NOT NULL,
  "targetId" text NOT NULL,
  "targetType" text NOT NULL,
  "matchScore" bigint NOT NULL,
  "scoreBreakdown" text NOT NULL,
  "matchReasons" text NOT NULL,
  "status" text DEFAULT 'suggested' NOT NULL,
  "createdAt" bigint NOT NULL,
  "updatedAt" bigint NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("targetId") REFERENCES "outreach_directory_targets" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("caseId") REFERENCES "cases" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS "legacy_import_records" (
  "id" text NOT NULL,
  "runId" text NOT NULL,
  "userId" text NOT NULL,
  "caseId" text,
  "sourceRuntime" text NOT NULL,
  "sourceInstanceId" text NOT NULL,
  "sourceTable" text NOT NULL,
  "sourceRecordId" text NOT NULL,
  "sourceHash" text NOT NULL,
  "payloadHash" text NOT NULL,
  "redactedFields" text NOT NULL,
  "payload" text NOT NULL,
  "importedAt" bigint NOT NULL,
  PRIMARY KEY ("id"),
  FOREIGN KEY ("caseId") REFERENCES "cases" ("id") ON UPDATE NO ACTION ON DELETE SET NULL,
  FOREIGN KEY ("userId") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  FOREIGN KEY ("runId") REFERENCES "legacy_import_runs" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx" ON "audit_logs" ("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "case_outreach_matches_case_target_unique" ON "case_outreach_target_matches" ("caseId","targetId");
CREATE INDEX IF NOT EXISTS "case_outreach_matches_user_case_type_idx" ON "case_outreach_target_matches" ("userId","caseId","targetType");
CREATE INDEX IF NOT EXISTS "cases_userId_clientName_idx" ON "cases" ("userId","clientName");
CREATE INDEX IF NOT EXISTS "cases_userId_createdAt_idx" ON "cases" ("userId","createdAt");
CREATE INDEX IF NOT EXISTS "cases_userId_idx" ON "cases" ("userId");
CREATE INDEX IF NOT EXISTS "cases_userId_status_createdAt_idx" ON "cases" ("userId","status","createdAt");
CREATE INDEX IF NOT EXISTS "cases_userId_status_urgency_createdAt_idx" ON "cases" ("userId","status","urgency","createdAt");
CREATE INDEX IF NOT EXISTS "cases_userId_updatedAt_idx" ON "cases" ("userId","updatedAt");
CREATE INDEX IF NOT EXISTS "cases_userId_urgency_createdAt_idx" ON "cases" ("userId","urgency","createdAt");
CREATE INDEX IF NOT EXISTS "document_analyses_case_created_idx" ON "document_analyses" ("caseId","createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "document_analyses_evidence_version_unique" ON "document_analyses" ("evidenceId","analysisVersion");
CREATE INDEX IF NOT EXISTS "document_analyses_user_idx" ON "document_analyses" ("userId");
CREATE INDEX IF NOT EXISTS "document_analyses_user_updatedAt_idx" ON "document_analyses" ("userId","updatedAt");
CREATE INDEX IF NOT EXISTS "evidence_caseId_idx" ON "evidence" ("caseId");
CREATE INDEX IF NOT EXISTS "evidence_files_user_idx" ON "evidence_files" ("userId");
CREATE INDEX IF NOT EXISTS "evidence_userId_idx" ON "evidence" ("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "integration_access_tokens_hash_unique" ON "integration_access_tokens" ("tokenHash");
CREATE INDEX IF NOT EXISTS "integration_access_tokens_user_status_idx" ON "integration_access_tokens" ("userId","status");
CREATE INDEX IF NOT EXISTS "keyword_pull_jobs_user_case_created_idx" ON "keyword_pull_jobs" ("userId","caseId","createdAt");
CREATE INDEX IF NOT EXISTS "keyword_pull_jobs_user_status_idx" ON "keyword_pull_jobs" ("userId","status");
CREATE INDEX IF NOT EXISTS "lawyers_city_idx" ON "lawyers" ("city");
CREATE INDEX IF NOT EXISTS "lawyers_novaId_idx" ON "lawyers" ("novaId");
CREATE INDEX IF NOT EXISTS "legacy_import_records_run_table_idx" ON "legacy_import_records" ("runId","sourceTable");
CREATE UNIQUE INDEX IF NOT EXISTS "legacy_import_records_source_unique" ON "legacy_import_records" ("sourceRuntime","sourceInstanceId","sourceTable","sourceRecordId","userId");
CREATE INDEX IF NOT EXISTS "legacy_import_records_user_case_idx" ON "legacy_import_records" ("userId","caseId");
CREATE UNIQUE INDEX IF NOT EXISTS "legacy_import_runs_source_user_unique" ON "legacy_import_runs" ("sourceRuntime","sourceInstanceId","userId");
CREATE INDEX IF NOT EXISTS "legacy_import_runs_user_completed_idx" ON "legacy_import_runs" ("userId","completedAt");
CREATE INDEX IF NOT EXISTS "outreach_targets_user_type_status_idx" ON "outreach_directory_targets" ("userId","targetType","status");
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_targets_user_type_url_unique" ON "outreach_directory_targets" ("userId","targetType","url");
CREATE INDEX IF NOT EXISTS "storage_deletion_queue_nextAttemptAt_idx" ON "storage_deletion_queue" ("nextAttemptAt");
CREATE UNIQUE INDEX IF NOT EXISTS "storage_deletion_queue_storageKey_unique" ON "storage_deletion_queue" ("storageKey");
CREATE UNIQUE INDEX IF NOT EXISTS "user_preferences_user_key_unique" ON "user_preferences" ("userId", "key");
