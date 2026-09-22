/**
 * Drizzle schema — tables referenced across the server.
 * Migrated to SQLite (Better-SQLite3) for unified desktop experience.
 */
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ─── Users & auth ───────────────────────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email"),
  password: text("password"),
  loginMethod: text("loginMethod"),
  role: text("role").default("user").notNull(),
  stripeCustomerId: text("stripeCustomerId"),
  stripeSubscriptionId: text("stripeSubscriptionId"),
  subscriptionStatus: text("subscriptionStatus").default("free"),
  subscriptionTier: text("subscriptionTier").default("free"),
  emailPreferences: text("emailPreferences"),
  resetCodeHash: text("resetCodeHash"),
  resetCodeExpiresAt: text("resetCodeExpiresAt"),
  resetCodeFailures: integer("resetCodeFailures").notNull().default(0),
  resetCodeLockedUntil: integer("resetCodeLockedUntil", { mode: "timestamp" }),
  paymentFailedAt: integer("paymentFailedAt", { mode: "timestamp" }),
  gracePeriodEndsAt: integer("gracePeriodEndsAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  lastSignedIn: integer("lastSignedIn", { mode: "timestamp" }).default(new Date()),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Existing accounts whose trimmed, case-folded addresses collide are
 * quarantined by migration instead of being silently merged. An operator must
 * assign each affected account a distinct canonical address.
 */
export const accountEmailConflicts = sqliteTable(
  "account_email_conflicts",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    originalEmail: text("originalEmail").notNull(),
    normalizedEmail: text("normalizedEmail").notNull(),
    status: text("status").notNull().default("pending"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    resolvedAt: integer("resolvedAt", { mode: "timestamp" }),
  },
  (table) => ({
    userStatusUnique: uniqueIndex("account_email_conflicts_user_status_unique").on(table.userId, table.status),
    normalizedStatusIdx: index("account_email_conflicts_normalized_status_idx").on(table.normalizedEmail, table.status),
  }),
);

// ─── Lawyers ─────────────────────────────────────────────────────────────────

export const lawyers = sqliteTable(
  "lawyers",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    city: text("city"),
    firm: text("firm"),
    firmName: text("firmName"),
    legalAreas: text("legalAreas"),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    address: text("address"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    permanentlyFiltered: text("permanentlyFiltered").default("No"),
    filterUntil: integer("filterUntil", { mode: "timestamp" }),
    // Statistics for match scoring
    totalOutreaches: text("totalOutreaches").default("0"),
    totalResponses: text("totalResponses").default("0"),
    totalAcceptances: text("totalAcceptances").default("0"),
    averageResponseTimeHours: text("averageResponseTimeHours"),
    caseLoad: text("caseLoad").default("0"),
    caseStop: text("caseStop").default("No"),
    experienceYears: text("experienceYears").default("0"),
    barAssociationStatus: text("barAssociationStatus").default("Good Standing"),
    currentlyAccepting: text("currentlyAccepting").default("Yes"),
    capacityPercentage: text("capacityPercentage").default("0"),
    languages: text("languages"), // JSON string
    novaId: text("novaId"),
    officialProfileUrl: text("officialProfileUrl"),
    officialLegalAreas: text("officialLegalAreas"),
    specializationAssociations: text("specializationAssociations"),
    admissionDate: text("admissionDate"),
    district: text("district"),
    financedLegalAid: text("financedLegalAid"),
    directorySource: text("directorySource"),
    directoryRetrievedAt: integer("directoryRetrievedAt", { mode: "timestamp" }),
    directoryDistanceKm: text("directoryDistanceKm"),
    directorySearchLocation: text("directorySearchLocation"),
    createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
  },
  (t) => ({
    cityIdx: index("lawyers_city_idx").on(t.city),
    novaIdIdx: index("lawyers_novaId_idx").on(t.novaId),
  })
);

export type Lawyer = typeof lawyers.$inferSelect;

// ─── Cases & evidence ───────────────────────────────────────────────────────

export const cases = sqliteTable(
  "cases",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    clientName: text("clientName"),
    clientEmail: text("clientEmail"),
    clientPhone: text("clientPhone"),
    clientAddress: text("clientAddress"),
    caseType: text("caseType"),
    caseSummary: text("caseSummary"),
    urgency: text("urgency"),
    status: text("status").default("active"),
    legalAreas: text("legalAreas"),
    preferredLanguages: text("preferredLanguages"),
    latitude: text("latitude"),
    longitude: text("longitude"),
    metadata: text("metadata"),
    createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
  },
  (t) => ({
    userIdx: index("cases_userId_idx").on(t.userId),
    userCreatedIdx: index("cases_userId_createdAt_idx").on(t.userId, t.createdAt),
    userUpdatedIdx: index("cases_userId_updatedAt_idx").on(t.userId, t.updatedAt),
    userStatusCreatedIdx: index("cases_userId_status_createdAt_idx").on(t.userId, t.status, t.createdAt),
    userUrgencyCreatedIdx: index("cases_userId_urgency_createdAt_idx").on(t.userId, t.urgency, t.createdAt),
    userStatusUrgencyCreatedIdx: index("cases_userId_status_urgency_createdAt_idx").on(t.userId, t.status, t.urgency, t.createdAt),
    userClientNameIdx: index("cases_userId_clientName_idx").on(t.userId, t.clientName),
  })
);

/**
 * Per-case collaboration grants.
 *
 * Invitations remain inert until the invited account accepts them.  Access is
 * expressed as a small capability set instead of treating every collaborator
 * as an owner.  The API validates the role/capability vocabulary on every
 * write; the migration also adds database-level CHECK constraints.
 */
export const caseShares = sqliteTable(
  "case_shares",
  {
    id: text("id").primaryKey(),
    caseId: text("caseId").notNull().references(() => cases.id, { onDelete: "cascade" }),
    ownerId: text("ownerId").notNull().references(() => users.id, { onDelete: "cascade" }),
    memberId: text("memberId").notNull().references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    capabilities: text("capabilities").notNull(),
    status: text("status").notNull().default("pending"),
    invitedAt: integer("invitedAt", { mode: "timestamp" }).notNull(),
    acceptedAt: integer("acceptedAt", { mode: "timestamp" }),
    revokedAt: integer("revokedAt", { mode: "timestamp" }),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    caseMemberUnique: uniqueIndex("case_shares_case_member_unique").on(table.caseId, table.memberId),
    ownerStatusIdx: index("case_shares_owner_status_idx").on(table.ownerId, table.status),
    memberStatusIdx: index("case_shares_member_status_idx").on(table.memberId, table.status),
    caseStatusIdx: index("case_shares_case_status_idx").on(table.caseId, table.status),
  }),
);

export type CaseShare = typeof caseShares.$inferSelect;

export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    caseId: text("caseId").notNull(),
    userId: text("userId").notNull(),
    type: text("type").notNull(),
    source: text("source"),
    title: text("title").notNull(),
    description: text("description"),
    fileUrl: text("fileUrl"),
    fileName: text("fileName"),
    fileSize: text("fileSize"),
    mimeType: text("mimeType"),
    metadata: text("metadata"),
    tags: text("tags"),
    relevant: integer("relevant", { mode: "boolean" }).default(true),
    createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
  },
  (table) => ({
    caseIdIdx: index("evidence_caseId_idx").on(table.caseId),
    userIdIdx: index("evidence_userId_idx").on(table.userId),
    userCaseIdx: index("evidence_userId_caseId_idx").on(table.userId, table.caseId),
  })
);

export const documentInbox = sqliteTable("document_inbox", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => users.id),
  fileName: text("fileName").notNull(),
  sourcePath: text("sourcePath").notNull(),
  sourceType: text("sourceType").notNull().default("manual"),
  provenance: text("provenance"),
  mimeType: text("mimeType").notNull(),
  fileSize: integer("fileSize").notNull(),
  storageKey: text("storageKey").notNull(),
  contentHash: text("contentHash").notNull(),
  analysis: text("analysis"),
  sourceText: text("sourceText"),
  discovery: text("discovery"),
  error: text("error"),
  decision: text("decision").notNull().default("pending"),
  reason: text("reason"),
  evidenceId: text("evidenceId").references(() => evidence.id, { onDelete: "set null" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => ({
  sourceHashUnique: uniqueIndex("document_inbox_owner_source_identity_idx").on(table.userId, table.sourceType, table.sourcePath, table.contentHash),
  ownerCreatedIdx: index("document_inbox_owner_created_idx").on(table.userId, table.createdAt),
}));

export const documentSourceJobs = sqliteTable("document_source_jobs", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  config: text("config").notNull(),
  status: text("status").notNull().default("running"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => ({ ownerStatusIdx: index("document_source_jobs_owner_status_idx").on(table.userId, table.status) }));

export const documentSourceWork = sqliteTable("document_source_work", {
  id: text("id").primaryKey(),
  jobId: text("jobId").notNull().references(() => documentSourceJobs.id, { onDelete: "cascade" }),
  userId: text("userId").notNull().references(() => users.id),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  label: text("label").notNull(),
  isDocument: integer("isDocument", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("queued"),
  inboxId: text("inboxId").references(() => documentInbox.id, { onDelete: "set null" }),
  error: text("error"),
  leaseToken: text("leaseToken"),
  leaseUntil: integer("leaseUntil"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => ({
  jobStatusIdx: index("document_source_work_job_status_idx").on(table.jobId, table.status),
  leaseIdx: index("document_source_work_lease_idx").on(table.status, table.leaseUntil),
}));

export const documentAnalyses = sqliteTable(
  "document_analyses",
  {
    id: text("id").primaryKey(),
    evidenceId: text("evidenceId").notNull().references(() => evidence.id, { onDelete: "cascade" }),
    caseId: text("caseId").notNull().references(() => cases.id, { onDelete: "cascade" }),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    analysisVersion: text("analysisVersion").notNull(),
    contentHash: text("contentHash").notNull(),
    status: text("status").notNull(),
    extractionMethod: text("extractionMethod").notNull(),
    providerStatus: text("providerStatus").notNull(),
    documentType: text("documentType").notNull(),
    confidence: integer("confidence").notNull(),
    summary: text("summary").notNull(),
    result: text("result").notNull(),
    analyzedChars: integer("analyzedChars").notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    evidenceVersionUnique: uniqueIndex("document_analyses_evidence_version_unique").on(
      table.evidenceId,
      table.analysisVersion
    ),
    caseCreatedIdx: index("document_analyses_case_created_idx").on(table.caseId, table.createdAt),
    userIdx: index("document_analyses_user_idx").on(table.userId),
    userUpdatedIdx: index("document_analyses_user_updatedAt_idx").on(table.userId, table.updatedAt),
  })
);

export type DocumentAnalysis = typeof documentAnalyses.$inferSelect;

export const evidenceItems = sqliteTable("evidence_items", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  source: text("source"),
  sourceId: text("sourceId"),
  sourceType: text("sourceType"),
  fileName: text("fileName"),
  title: text("title"),
  description: text("description"),
  type: text("type"),
  folder: text("folder"),
  size: text("size"),
  tags: text("tags"),
  relevance: integer("relevance", { mode: "boolean" }),
  relevanceScore: integer("relevanceScore"),
  content: text("content"),
  metadata: text("metadata"),
  timestamp: integer("timestamp", { mode: "timestamp" }),
  uploadedAt: integer("uploadedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
});

export const evidenceSources = sqliteTable("evidence_sources", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  provider: text("provider"),
  sourceType: text("sourceType"),
  externalId: text("externalId"),
  sourceIdentifier: text("sourceIdentifier"),
  connectionStatus: text("connectionStatus"),
  status: text("status"),
  accessToken: text("accessToken"),
  itemsCollected: integer("itemsCollected"),
  itemCount: integer("itemCount"),
  lastSyncedAt: integer("lastSyncedAt", { mode: "timestamp" }),
  connectedAt: integer("connectedAt", { mode: "timestamp" }),
  errorMessage: text("errorMessage"),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const evidenceFiles = sqliteTable(
  "evidence_files",
  {
    id: text("id").primaryKey(),
    caseId: text("caseId"),
    userId: text("userId").notNull(),
    fileType: text("fileType"),
    fileSize: text("fileSize"),
    uploadSource: text("uploadSource").default("manual"),
    uploadedAt: integer("uploadedAt", { mode: "timestamp" }).default(new Date()),
    fileName: text("fileName"),
    mimeType: text("mimeType"),
    storageKey: text("storageKey"),
  },
  (t) => ({ userIdx: index("evidence_files_user_idx").on(t.userId) })
);

export const evidenceTags = sqliteTable("evidence_tags", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  name: text("name"),
  color: text("color"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const evidenceFileTags = sqliteTable("evidence_file_tags", {
  id: text("id").primaryKey(),
  evidenceFileId: text("evidenceFileId"),
  tagId: text("tagId"),
});

// ─── Email & comms ────────────────────────────────────────────────────────────

export const emailAccounts = sqliteTable("email_accounts", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  provider: text("provider"),
  email: text("email"),
  displayName: text("displayName"),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  tokenExpiry: integer("tokenExpiry", { mode: "timestamp" }),
  status: text("status"),
  connectedAt: integer("connectedAt", { mode: "timestamp" }),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
});

export const emailSyncJobs = sqliteTable("email_sync_jobs", {
  id: text("id").primaryKey(),
  accountId: text("accountId"),
  caseId: text("caseId"),
  status: text("status"),
  startDate: integer("startDate", { mode: "timestamp" }),
  endDate: integer("endDate", { mode: "timestamp" }),
  keywords: text("keywords"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const emailMessages = sqliteTable("email_messages", {
  id: text("id").primaryKey(),
  accountId: text("accountId"),
  caseId: text("caseId"),
  category: text("category"),
  relevanceScore: text("relevanceScore"),
  subject: text("subject"),
  snippet: text("snippet"),
  body: text("body"),
  date: integer("date", { mode: "timestamp" }),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const emailActivity = sqliteTable("email_activity", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  lawyerId: text("lawyerId"),
  activityType: text("activityType"),
  emailType: text("emailType"),
  recipientEmail: text("recipientEmail"),
  subject: text("subject"),
  metadata: text("metadata"),
  responseReceived: text("responseReceived"),
  responseStatus: text("responseStatus"),
  sentAt: integer("sentAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const outreachStatus = sqliteTable(
  "outreach_status",
  {
    id: text("id").primaryKey(),
    caseId: text("caseId"),
    lawyerId: text("lawyerId"),
    status: text("status"),
    initialContact: integer("initialContact", { mode: "timestamp" }),
    lastContact: integer("lastContact", { mode: "timestamp" }),
    followUpsSent: integer("followUpsSent"),
    followUp1SentAt: integer("followUp1SentAt", { mode: "timestamp" }),
    followUp2SentAt: integer("followUp2SentAt", { mode: "timestamp" }),
    responseTimeHours: text("responseTimeHours"),
    lawyerCapacityPercentage: text("lawyerCapacityPercentage"),
    acceptanceStatus: text("acceptanceStatus"),
    response: text("response"),
    responseReceived: text("responseReceived").default("No"),
    notes: text("notes"),
    distanceKm: integer("distanceKm"),
    metadata: text("metadata"),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
    createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  },
  (table) => ({
    caseLawyerUnique: uniqueIndex("outreach_status_case_lawyer_unique").on(table.caseId, table.lawyerId),
    caseStatusIdx: index("outreach_status_caseId_status_idx").on(table.caseId, table.status),
  }),
);

export const outreachDirectoryTargets = sqliteTable(
  "outreach_directory_targets",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    targetType: text("targetType").notNull(),
    name: text("name").notNull(),
    subtype: text("subtype"),
    description: text("description"),
    topics: text("topics"),
    legalAreas: text("legalAreas"),
    audience: text("audience"),
    channels: text("channels"),
    region: text("region"),
    url: text("url").notNull(),
    contactUrl: text("contactUrl"),
    sourceUrl: text("sourceUrl"),
    sourceLabel: text("sourceLabel"),
    sourceRetrievedAt: integer("sourceRetrievedAt", { mode: "timestamp" }),
    status: text("status").notNull().default("pending"),
    confidence: text("confidence").notNull().default("discovery_candidate"),
    reviewNotes: text("reviewNotes"),
    reviewedAt: integer("reviewedAt", { mode: "timestamp" }),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    userTypeUrlUnique: uniqueIndex("outreach_targets_user_type_url_unique").on(
      table.userId,
      table.targetType,
      table.url,
    ),
    userTypeStatusIdx: index("outreach_targets_user_type_status_idx").on(
      table.userId,
      table.targetType,
      table.status,
    ),
  }),
);

export const caseOutreachTargetMatches = sqliteTable(
  "case_outreach_target_matches",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    caseId: text("caseId").notNull().references(() => cases.id, { onDelete: "cascade" }),
    targetId: text("targetId").notNull().references(() => outreachDirectoryTargets.id, { onDelete: "cascade" }),
    targetType: text("targetType").notNull(),
    matchScore: integer("matchScore").notNull(),
    scoreBreakdown: text("scoreBreakdown").notNull(),
    matchReasons: text("matchReasons").notNull(),
    status: text("status").notNull().default("suggested"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    caseTargetUnique: uniqueIndex("case_outreach_matches_case_target_unique").on(table.caseId, table.targetId),
    userCaseTypeIdx: index("case_outreach_matches_user_case_type_idx").on(
      table.userId,
      table.caseId,
      table.targetType,
    ),
  }),
);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  caseId: text("caseId"),
  content: text("content"),
  threadId: text("threadId"),
  parentId: text("parentId"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const communications = sqliteTable("communications", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  channel: text("channel"),
  type: text("type"),
  direction: text("direction"), // inbound, outbound
  subject: text("subject"),
  body: text("body"),
  content: text("content"), // some services use content instead of body
  timestamp: integer("timestamp", { mode: "timestamp" }),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const documents = sqliteTable("documents", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  title: text("title"),
  content: text("content"),
  name: text("name"),
  type: text("type"),
  folder: text("folder"),
  uploadedAt: integer("uploadedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

// ─── Legacy billing tables and optional owner usage analytics ────────────────

export const billingPeriods = sqliteTable("billing_periods", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  stripeSubscriptionId: text("stripeSubscriptionId"),
  stripeInvoiceId: text("stripeInvoiceId"),
  periodStart: integer("periodStart", { mode: "timestamp" }),
  periodEnd: integer("periodEnd", { mode: "timestamp" }),
  status: text("status"), // completed, pending, failed
  metadata: text("metadata"),
  totalCost: text("totalCost"),
  totalBilledCost: text("totalBilledCost"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const usageTracking = sqliteTable("usage_tracking", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  resourceType: text("resourceType"),
  quantity: text("quantity"),
  baseCost: text("baseCost"),
  billedCost: text("billedCost"),
  metadata: text("metadata"),
  caseId: text("caseId"),
  reportedToStripe: integer("reportedToStripe", { mode: "boolean" }).default(false),
  stripeUsageRecordId: text("stripeUsageRecordId"),
  timestamp: integer("timestamp", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const usageLimits = sqliteTable("usage_limits", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  tier: text("tier"),
  resourceType: text("resourceType"),
  monthlyLimit: text("monthlyLimit"),
  description: text("description"),
  limitsJson: text("limitsJson"),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
});

// ─── Integrations & misc ─────────────────────────────────────────────────────

export const googleDriveFiles = sqliteTable("google_drive_files", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  caseId: text("caseId"),
  accountId: text("accountId"),
  googleFileId: text("googleFileId"),
  fileName: text("fileName"),
  mimeType: text("mimeType"),
  fileSize: text("fileSize"),
  s3Key: text("s3Key"),
  s3Url: text("s3Url"),
  googleWebViewLink: text("googleWebViewLink"),
  googleModifiedTime: integer("googleModifiedTime", { mode: "timestamp" }),
  evidenceType: text("evidenceType"),
  isIncluded: text("isIncluded"),
  relevanceScore: text("relevanceScore"),
  category: text("category"),
  userNotes: text("userNotes"),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const systemConfig = sqliteTable("system_config", {
  configKey: text("configKey").primaryKey(),
  configValue: text("configValue"),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
});

export const storageDeletionQueue = sqliteTable(
  "storage_deletion_queue",
  {
    id: text("id").primaryKey(),
    storageKey: text("storageKey").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("lastError"),
    nextAttemptAt: integer("nextAttemptAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    storageKeyUnique: uniqueIndex("storage_deletion_queue_storageKey_unique").on(table.storageKey),
    nextAttemptIdx: index("storage_deletion_queue_nextAttemptAt_idx").on(table.nextAttemptAt),
  }),
);

export const clarificationQuestions = sqliteTable("clarification_questions", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  kind: text("kind"),
  question: text("question"),
  context: text("context"),
  answer: text("answer"),
  answeredBy: text("answeredBy"),
  status: text("status"),
  applied: integer("applied", { mode: "boolean" }),
  outcome: text("outcome"),
  reviewStatus: text("reviewStatus"),
  provenance: text("provenance"),
  answeredAt: integer("answeredAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }),
}, (table) => ({
  ownerStatusIdx: index("clarification_questions_owner_status_idx").on(table.userId, table.status),
  caseKindIdx: index("clarification_questions_case_kind_idx").on(table.caseId, table.kind),
}));

export const savedSearches = sqliteTable("saved_searches", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull(),
  name: text("name"),
  queryJson: text("queryJson"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const userPreferences = sqliteTable(
  "user_preferences",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull(),
    key: text("key"),
    value: text("value"),
    theme: text("theme"),
    dashboardWidgets: text("dashboardWidgets"),
    notificationSettings: text("notificationSettings"),
    preferredLawyers: text("preferredLawyers"),
    caseTemplates: text("caseTemplates"),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
    userPreferences: text("userPreferences"),
  },
  (table) => ({
    userKeyUnique: uniqueIndex("user_preferences_user_key_unique").on(table.userId, table.key),
  }),
);

export const messageTemplates = sqliteTable("message_templates", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  name: text("name"),
  body: text("body"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("userId"),
    kind: text("kind"),
    title: text("title"),
    body: text("body"),
    actionUrl: text("actionUrl"),
    metadata: text("metadata"),
    caseId: text("caseId"),
    lawyerId: text("lawyerId"),
    evidenceFileId: text("evidenceFileId"),
    dedupKey: text("dedupKey"),
    read: integer("read", { mode: "boolean" }).default(false),
    createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  },
  (table) => ({
    userDedupUnique: uniqueIndex("notifications_user_dedup_unique").on(table.userId, table.dedupKey),
    userCreatedIdx: index("notifications_user_created_idx").on(table.userId, table.createdAt),
  }),
);

export type InsertNotification = typeof notifications.$inferInsert;

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    userId: text("userId"),
    action: text("action"),
    resource: text("resource"),
    entityType: text("entityType"),
    entityId: text("entityId"),
    details: text("details"),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    metadata: text("metadata"),
    createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  },
  (table) => ({
    createdAtIdx: index("audit_logs_createdAt_idx").on(table.createdAt),
  })
);

export type InsertAuditLog = typeof auditLogs.$inferInsert;

// A reviewed HAI grant is the authorization boundary behind a credential. Case
// and field selections are JSON arrays from closed vocabularies, validated on
// every read and write. Keeping the grant separate lets scope changes advance a
// revision and invalidate stale feed cursors without rotating the bearer token.
export const haiAccessGrants = sqliteTable(
  "hai_access_grants",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    caseIds: text("caseIds").notNull(),
    fieldCategories: text("fieldCategories").notNull(),
    includeFutureCases: integer("includeFutureCases", { mode: "boolean" }).notNull().default(false),
    includeFutureAnalyses: integer("includeFutureAnalyses", { mode: "boolean" }).notNull().default(false),
    revision: integer("revision").notNull().default(1),
    reviewedAt: integer("reviewedAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
    revokedAt: integer("revokedAt", { mode: "timestamp" }),
  },
  (table) => ({
    userIdx: index("hai_access_grants_user_idx").on(table.userId),
    userRevokedIdx: index("hai_access_grants_user_revoked_idx").on(table.userId, table.revokedAt),
  }),
);

export type HaiAccessGrant = typeof haiAccessGrants.$inferSelect;

// Read-only integration credentials. Only a SHA-256 digest and a short display
// prefix are persisted; the bearer token is returned once when it is created.
export const integrationAccessTokens = sqliteTable(
  "integration_access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("tokenPrefix").notNull(),
    tokenHash: text("tokenHash").notNull(),
    grantId: text("grantId").references(() => haiAccessGrants.id, { onDelete: "set null" }),
    scope: text("scope").notNull(),
    status: text("status").notNull().default("active"),
    expiresAt: integer("expiresAt", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    revokedAt: integer("revokedAt", { mode: "timestamp" }),
  },
  (table) => ({
    tokenHashUnique: uniqueIndex("integration_access_tokens_hash_unique").on(table.tokenHash),
    grantUnique: uniqueIndex("integration_access_tokens_grant_unique").on(table.grantId),
    userStatusIdx: index("integration_access_tokens_user_status_idx").on(table.userId, table.status),
  })
);

export type IntegrationAccessToken = typeof integrationAccessTokens.$inferSelect;

export const legacyImportRuns = sqliteTable(
  "legacy_import_runs",
  {
    id: text("id").primaryKey(),
    sourceRuntime: text("sourceRuntime").notNull(),
    sourceInstanceId: text("sourceInstanceId").notNull(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    sourceUserId: text("sourceUserId").notNull(),
    sourceUserEmail: text("sourceUserEmail"),
    status: text("status").notNull(),
    sourceSnapshotHash: text("sourceSnapshotHash").notNull(),
    recordsImported: integer("recordsImported").notNull(),
    casesImported: integer("casesImported").notNull(),
    filesCopied: integer("filesCopied").notNull(),
    missingFiles: integer("missingFiles").notNull(),
    summary: text("summary").notNull(),
    startedAt: integer("startedAt", { mode: "timestamp" }).notNull(),
    completedAt: integer("completedAt", { mode: "timestamp" }),
  },
  (table) => ({
    sourceUserUnique: uniqueIndex("legacy_import_runs_source_user_unique").on(
      table.sourceRuntime,
      table.sourceInstanceId,
      table.userId,
    ),
    userCompletedIdx: index("legacy_import_runs_user_completed_idx").on(table.userId, table.completedAt),
  }),
);

export const legacyImportRecords = sqliteTable(
  "legacy_import_records",
  {
    id: text("id").primaryKey(),
    runId: text("runId").notNull().references(() => legacyImportRuns.id, { onDelete: "cascade" }),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    caseId: text("caseId").references(() => cases.id, { onDelete: "set null" }),
    sourceRuntime: text("sourceRuntime").notNull(),
    sourceInstanceId: text("sourceInstanceId").notNull(),
    sourceTable: text("sourceTable").notNull(),
    sourceRecordId: text("sourceRecordId").notNull(),
    sourceHash: text("sourceHash").notNull(),
    payloadHash: text("payloadHash").notNull(),
    redactedFields: text("redactedFields").notNull(),
    payload: text("payload").notNull(),
    importedAt: integer("importedAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    sourceUnique: uniqueIndex("legacy_import_records_source_unique").on(
      table.sourceRuntime,
      table.sourceInstanceId,
      table.sourceTable,
      table.sourceRecordId,
      table.userId,
    ),
    runTableIdx: index("legacy_import_records_run_table_idx").on(table.runId, table.sourceTable),
    userCaseIdx: index("legacy_import_records_user_case_idx").on(table.userId, table.caseId),
  }),
);

export const bulkImportJobs = sqliteTable("bulk_import_jobs", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  filename: text("filename"),
  status: text("status"),
  totalRows: text("totalRows").default("0"),
  processedRows: text("processedRows").default("0"),
  failedRows: text("failedRows").default("0"),
  errors: text("errors"),
  completedAt: integer("completedAt", { mode: "timestamp" }),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const supportTickets = sqliteTable("support_tickets", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  category: text("category").notNull(),
  subject: text("subject").notNull(),
  message: text("message").notNull(),
  status: text("status").default("open"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});

export type InsertSupportTicket = typeof supportTickets.$inferInsert;

export const extractedEntities = sqliteTable("extracted_entities", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  entityType: text("entityType"),
  value: text("value"),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export type InsertExtractedEntity = typeof extractedEntities.$inferInsert;

// ─── Gap analysis & timeline ─────────────────────────────────────────────────

export const communicationGaps = sqliteTable(
  "communication_gaps",
  {
    id: text("id").primaryKey(),
    caseId: text("caseId"),
    data: text("data"),
    createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  },
  (table) => ({
    caseIdIdx: index("communication_gaps_caseId_idx").on(table.caseId),
  }),
);

export const expectedDocuments = sqliteTable(
  "expected_documents",
  {
    id: text("id").primaryKey(),
    caseId: text("caseId"),
    data: text("data"),
    createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  },
  (table) => ({
    caseIdIdx: index("expected_documents_caseId_idx").on(table.caseId),
  }),
);

export const suspiciousPatterns = sqliteTable("suspicious_patterns", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  data: text("data"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const legalInferences = sqliteTable("legal_inferences", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  data: text("data"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

// The physical table name is retained for installed-database compatibility.
// Rows now contain the versioned evidence-coverage contract; migration 0027
// marks every row produced by the retired score contract before it can be read.
export const evidenceCoverageAnalysis = sqliteTable("case_strength_analysis", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  data: text("data"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

/**
 * Immutable recipient revisions and generated legal-draft byte snapshots.
 *
 * A recipient edit creates another row instead of overwriting the reviewed
 * identity that an older draft references. Draft content/provenance is likewise
 * append-only; only the review fields transition from pending to reviewed.
 */
export const legalDraftRecipients = sqliteTable(
  "legal_draft_recipients",
  {
    id: text("id").primaryKey(),
    recipientId: text("recipientId").notNull(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    caseId: text("caseId").notNull().references(() => cases.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    address: text("address").notNull(),
    provenanceType: text("provenanceType").notNull(),
    evidenceId: text("evidenceId").references(() => evidence.id, { onDelete: "set null" }),
    sourceReference: text("sourceReference").notNull(),
    revisionHash: text("revisionHash").notNull(),
    reviewedBy: text("reviewedBy").notNull(),
    reviewedAt: integer("reviewedAt", { mode: "timestamp" }).notNull(),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    recipientRevisionUnique: uniqueIndex("legal_draft_recipients_revision_unique").on(
      table.recipientId,
      table.revision,
    ),
    ownerCaseRevisionIdx: index("legal_draft_recipients_owner_case_revision_idx").on(
      table.userId,
      table.caseId,
      table.revision,
    ),
  }),
);

export const legalDraftSnapshots = sqliteTable(
  "legal_draft_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    caseId: text("caseId").notNull().references(() => cases.id, { onDelete: "cascade" }),
    documentType: text("documentType").notNull(),
    version: integer("version").notNull(),
    status: text("status").notNull().default("pending_review"),
    generationRevision: text("generationRevision").notNull(),
    inputRevision: text("inputRevision").notNull(),
    sourceRevision: text("sourceRevision").notNull(),
    caseRevision: text("caseRevision").notNull(),
    analysisRevision: text("analysisRevision").notNull(),
    coverageAnalysisId: text("coverageAnalysisId").notNull(),
    recipientRevisionId: text("recipientRevisionId").notNull(),
    recipientRevision: integer("recipientRevision").notNull(),
    recipientRevisionHash: text("recipientRevisionHash").notNull(),
    recipientSnapshot: text("recipientSnapshot").notNull(),
    ownerInputRevision: text("ownerInputRevision").notNull(),
    provenance: text("provenance").notNull(),
    previewJson: text("previewJson").notNull(),
    contentBase64: text("contentBase64").notNull(),
    contentHash: text("contentHash").notNull(),
    byteLength: integer("byteLength").notNull(),
    fileName: text("fileName").notNull(),
    reviewedBy: text("reviewedBy"),
    reviewedAt: integer("reviewedAt", { mode: "timestamp" }),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    generationUnique: uniqueIndex("legal_draft_snapshots_generation_unique").on(
      table.userId,
      table.caseId,
      table.documentType,
      table.generationRevision,
    ),
    ownerCaseVersionUnique: uniqueIndex("legal_draft_snapshots_owner_case_type_version_unique").on(
      table.userId,
      table.caseId,
      table.documentType,
      table.version,
    ),
    ownerCaseCreatedIdx: index("legal_draft_snapshots_owner_case_created_idx").on(
      table.userId,
      table.caseId,
      table.createdAt,
    ),
  }),
);

export type LegalDraftRecipient = typeof legalDraftRecipients.$inferSelect;
export type LegalDraftSnapshot = typeof legalDraftSnapshots.$inferSelect;

export const timeline = sqliteTable("timeline", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  eventType: text("eventType"),
  title: text("title"),
  description: text("description"),
  eventAt: integer("eventAt", { mode: "timestamp" }),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export type CommunicationGap = typeof communicationGaps.$inferSelect;
export type ExpectedDocument = typeof expectedDocuments.$inferSelect;
export type SuspiciousPattern = typeof suspiciousPatterns.$inferSelect;
export type LegalInference = typeof legalInferences.$inferSelect;
export type Communication = typeof communications.$inferSelect;
export type Timeline = typeof timeline.$inferSelect;
export type Case = typeof cases.$inferSelect;

// ─── Auto-collection & unified inbox ─────────────────────────────────────────

export const autoCollectionSettings = sqliteTable("auto_collection_settings", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  keywords: text("keywords"),
  keywordMatchMode: text("keywordMatchMode"),
  dateRangeStart: integer("dateRangeStart", { mode: "timestamp" }),
  dateRangeEnd: integer("dateRangeEnd", { mode: "timestamp" }),
  emailAccountIds: text("emailAccountIds"),
  googleDriveFolderIds: text("googleDriveFolderIds"),
  autoDownloadAttachments: integer("autoDownloadAttachments", { mode: "boolean" }),
  autoDownloadGoogleDriveFiles: integer("autoDownloadGoogleDriveFiles", { mode: "boolean" }),
  isEnabled: integer("isEnabled", { mode: "boolean" }).default(true),
  status: text("status"),
  lastRunAt: integer("lastRunAt", { mode: "timestamp" }),
  totalItemsCollected: text("totalItemsCollected"),
  totalEmailsCollected: text("totalEmailsCollected"),
  totalFilesCollected: text("totalFilesCollected"),
  metadata: text("metadata"),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
});

export const autoCollectionLogs = sqliteTable("auto_collection_logs", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  settingsId: text("settingsId"),
  userId: text("userId"),
  runStartedAt: integer("runStartedAt", { mode: "timestamp" }),
  runCompletedAt: integer("runCompletedAt", { mode: "timestamp" }),
  status: text("status"),
  emailsFound: text("emailsFound"),
  emailsProcessed: text("emailsProcessed"),
  filesFound: text("filesFound"),
  filesDownloaded: text("filesDownloaded"),
  errorCount: text("errorCount"),
  errorMessage: text("errorMessage"),
  executionTimeSeconds: text("executionTimeSeconds"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const keywordPullJobs = sqliteTable(
  "keyword_pull_jobs",
  {
    id: text("id").primaryKey(),
    caseId: text("caseId").notNull().references(() => cases.id, { onDelete: "cascade" }),
    userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    phase: text("phase").notNull().default("queued"),
    message: text("message").notNull().default("Waiting to start"),
    processedWords: integer("processedWords").notNull().default(0),
    totalWords: integer("totalWords").notNull().default(0),
    processedItems: integer("processedItems").notNull().default(0),
    totalItems: integer("totalItems").notNull().default(0),
    estimatedSecondsRemaining: integer("estimatedSecondsRemaining"),
    result: text("result"),
    error: text("error"),
    createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
    startedAt: integer("startedAt", { mode: "timestamp" }),
    updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
    completedAt: integer("completedAt", { mode: "timestamp" }),
  },
  (table) => ({
    userCaseCreatedIdx: index("keyword_pull_jobs_user_case_created_idx").on(
      table.userId,
      table.caseId,
      table.createdAt
    ),
    userStatusIdx: index("keyword_pull_jobs_user_status_idx").on(table.userId, table.status),
  })
);

export type KeywordPullJob = typeof keywordPullJobs.$inferSelect;

export const keywordMatches = sqliteTable("keyword_matches", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  itemId: text("itemId"),
  itemType: text("itemType"),
  matchedKeywords: text("matchedKeywords"),
  matchCount: text("matchCount"),
  source: text("source"),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export const unifiedMessages = sqliteTable("unified_messages", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  caseId: text("caseId"),
  threadId: text("threadId"),
  channel: text("channel"),
  externalId: text("externalId"),
  sender: text("sender"),
  recipient: text("recipient"),
  subject: text("subject"),
  body: text("body"),
  direction: text("direction"), // inbound, outbound
  status: text("status").default("received"), // sent, delivered, read, failed
  priority: text("priority").default("normal"),
  metadata: text("metadata"),
  attachmentCount: integer("attachmentCount").default(0),
  readAt: integer("readAt", { mode: "timestamp" }),
  sentAt: integer("sentAt", { mode: "timestamp" }),
  receivedAt: integer("receivedAt", { mode: "timestamp" }),
  aiSubject: text("aiSubject"),
  aiSentiment: text("aiSentiment"),
  aiCategory: text("aiCategory"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
});

export type InsertUnifiedMessage = typeof unifiedMessages.$inferInsert;

export const conversationThreads = sqliteTable("conversation_threads", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  caseId: text("caseId"),
  title: text("title"),
  status: text("status").default("active"),
  priority: text("priority").default("normal"),
  participants: text("participants"), // JSON
  channels: text("channels"), // JSON
  firstMessageAt: integer("firstMessageAt", { mode: "timestamp" }),
  lastMessageAt: integer("lastMessageAt", { mode: "timestamp" }),
  messageCount: integer("messageCount").default(0),
  unreadCount: integer("unreadCount").default(0),
  aiSummary: text("aiSummary"),
  aiTopics: text("aiTopics"), // JSON
  metadata: text("metadata"),
  archivedAt: integer("archivedAt", { mode: "timestamp" }),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
});

export type InsertConversationThread = typeof conversationThreads.$inferInsert;

export const channelIntegrations = sqliteTable("channel_integrations", {
  id: text("id").primaryKey(),
  userId: text("userId"),
  provider: text("provider"),
  status: text("status").default("active"),
  lastSyncAt: integer("lastSyncAt", { mode: "timestamp" }),
  nextSyncAt: integer("nextSyncAt", { mode: "timestamp" }),
  syncFrequency: integer("syncFrequency").default(3600), // in seconds
  errorMessage: text("errorMessage"),
  metadata: text("metadata"),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
});

export type InsertChannelIntegration = typeof channelIntegrations.$inferInsert;

export const deadlines = sqliteTable("deadlines", {
  id: text("id").primaryKey(),
  caseId: text("caseId"),
  userId: text("userId"),
  title: text("title"),
  description: text("description"),
  dueDate: integer("dueDate", { mode: "timestamp" }),
  completed: integer("completed", { mode: "boolean" }).default(false),
  createdAt: integer("createdAt", { mode: "timestamp" }).default(new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).default(new Date()),
});

export const caseActionEvidence = sqliteTable("case_action_evidence", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  caseId: text("caseId").notNull().references(() => cases.id, { onDelete: "cascade" }),
  actionId: text("actionId").notNull().references(() => deadlines.id, { onDelete: "cascade" }),
  evidenceId: text("evidenceId").references(() => evidence.id, { onDelete: "set null" }),
  relation: text("relation").notNull(),
  state: text("state").notNull(),
  note: text("note").notNull(),
  snapshot: text("snapshot").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => ({ ownerAction: index("case_action_evidence_owner_action_idx").on(table.userId, table.actionId) }));

export const caseActionProposals = sqliteTable("case_action_proposals", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade" }),
  caseId: text("caseId").notNull().references(() => cases.id, { onDelete: "cascade" }),
  evidenceId: text("evidenceId").references(() => evidence.id, { onDelete: "set null" }),
  actionId: text("actionId").references(() => deadlines.id, { onDelete: "set null" }),
  state: text("state").notNull(),
  snapshot: text("snapshot").notNull(),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updatedAt", { mode: "timestamp" }).notNull(),
}, (table) => ({
  ownerCase: index("case_action_proposals_owner_case_idx").on(table.userId, table.caseId),
  action: uniqueIndex("case_action_proposals_action_idx").on(table.actionId),
}));
