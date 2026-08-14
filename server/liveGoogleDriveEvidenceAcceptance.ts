import { createHash } from "crypto";
import { and, eq, inArray } from "drizzle-orm";
import { AUDIT_ACTIONS } from "./audit";
import { pullEvidenceByKeywords } from "./autoCollectionService";
import { getDb } from "./db";
import { analyzeStoredEvidence } from "./documentAnalysisService";
import { getEvidenceDownloadUrl, recordEvidenceSourceOpened } from "./evidenceAccess";
import { managedStorageKeyFromMetadata } from "./managedStorage";
import {
  hashAcceptanceRecipient,
  readGoogleDriveEvidenceAcceptanceReceipt,
  recordGoogleDriveEvidenceAcceptanceReceipt,
} from "./providerAcceptanceEvidence";
import {
  auditLogs,
  autoCollectionLogs,
  cases,
  documentAnalyses,
  emailAccounts,
  evidence,
  googleDriveFiles,
  users,
} from "./schema";
import { hashBuffer, storageDelete, storageRead } from "./storage";
import { assertNotEmergencyStopped } from "./systemState";

interface GoogleDriveEvidenceAcceptanceOptions {
  userId: string;
  googleAccountId: string;
  recipient: string;
  confirmedRecipient: string;
  driveFileName: string;
  driveFolderId?: string;
  runId: string;
}

interface GoogleDriveEvidenceAcceptanceDependencies {
  pullEvidence: typeof pullEvidenceByKeywords;
  getDownloadUrl: typeof getEvidenceDownloadUrl;
  fetchSource: (url: string) => Promise<Buffer>;
  analyzeEvidence: typeof analyzeStoredEvidence;
  recordSourceOpened: typeof recordEvidenceSourceOpened;
  recordReceipt: typeof recordGoogleDriveEvidenceAcceptanceReceipt;
}

const DEFAULT_DEPENDENCIES: GoogleDriveEvidenceAcceptanceDependencies = {
  pullEvidence: pullEvidenceByKeywords,
  getDownloadUrl: getEvidenceDownloadUrl,
  fetchSource: async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Signed evidence URL returned HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  },
  analyzeEvidence: analyzeStoredEvidence,
  recordSourceOpened: recordEvidenceSourceOpened,
  recordReceipt: recordGoogleDriveEvidenceAcceptanceReceipt,
};

function acceptanceCaseId(userId: string, runId: string): string {
  const suffix = createHash("sha256").update(`${userId}\n${runId}`).digest("hex").slice(0, 24);
  return `ACCEPTANCE_DRIVE_CASE_${suffix}`;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function validateOptions(options: GoogleDriveEvidenceAcceptanceOptions): void {
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(options.runId)) {
    throw new Error("runId must contain 8-80 letters, numbers, dots, underscores, or hyphens");
  }
  const recipient = options.recipient.trim().toLowerCase();
  if (!recipient || recipient !== options.confirmedRecipient.trim().toLowerCase()) {
    throw new Error("The explicit account confirmation does not match the requested recipient");
  }
  const driveFileName = options.driveFileName.trim();
  if (driveFileName.length < 3 || driveFileName.length > 200 || /[\r\n\0]/.test(driveFileName)) {
    throw new Error("driveFileName must contain 3-200 printable characters");
  }
  const folderId = options.driveFolderId?.trim();
  if (folderId && folderId !== "root" && !/^[A-Za-z0-9_-]{3,200}$/.test(folderId)) {
    throw new Error("driveFolderId is invalid");
  }
}

async function cleanupTransientDriveAcceptance(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  caseId: string,
  userId: string,
  runId: string,
): Promise<void> {
  const [caseRow] = await db.select({ userId: cases.userId, metadata: cases.metadata })
    .from(cases)
    .where(eq(cases.id, caseId))
    .limit(1);
  if (!caseRow) return;
  const expectedMetadata = JSON.stringify({ kind: "provider_acceptance", source: "google_drive", runId });
  if (caseRow.userId !== userId || caseRow.metadata !== expectedMetadata) {
    throw new Error("Refusing to clean a non-acceptance case collision");
  }
  const rows = await db.select({ id: evidence.id, metadata: evidence.metadata })
    .from(evidence)
    .where(eq(evidence.caseId, caseId));
  const storageKeys = rows.flatMap((row) => {
    const key = managedStorageKeyFromMetadata(row.metadata);
    return key ? [key] : [];
  });
  for (const key of storageKeys) await storageDelete(key);
  const evidenceIds = rows.map((row) => row.id);
  db.transaction((tx: any) => {
    if (evidenceIds.length > 0) {
      tx.delete(auditLogs).where(inArray(auditLogs.entityId, evidenceIds)).run();
    }
    tx.delete(autoCollectionLogs).where(eq(autoCollectionLogs.caseId, caseId)).run();
    tx.delete(documentAnalyses).where(eq(documentAnalyses.caseId, caseId)).run();
    tx.delete(googleDriveFiles).where(eq(googleDriveFiles.caseId, caseId)).run();
    tx.delete(evidence).where(eq(evidence.caseId, caseId)).run();
    tx.delete(cases).where(eq(cases.id, caseId)).run();
  });
}

export async function runLiveGoogleDriveEvidenceAcceptance(
  options: GoogleDriveEvidenceAcceptanceOptions,
  dependencies: GoogleDriveEvidenceAcceptanceDependencies = DEFAULT_DEPENDENCIES,
) {
  validateOptions(options);
  await assertNotEmergencyStopped();
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const recipient = options.recipient.trim().toLowerCase();
  const caseId = acceptanceCaseId(options.userId, options.runId);

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, options.userId)).limit(1);
  if (!user) throw new Error("Target owner was not found");
  const [account] = await db.select().from(emailAccounts).where(and(
    eq(emailAccounts.id, options.googleAccountId),
    eq(emailAccounts.userId, options.userId),
    eq(emailAccounts.provider, "gmail"),
  )).limit(1);
  if (!account || account.status !== "connected") {
    throw new Error("Target Google account is not connected to the selected owner");
  }
  if ((account.email || "").trim().toLowerCase() !== recipient) {
    throw new Error("Live acceptance only reads the selected owner's connected Google account");
  }

  const existingReceipt = await readGoogleDriveEvidenceAcceptanceReceipt(options.userId);
  if (existingReceipt) {
    if (existingReceipt.accountEmailHash !== hashAcceptanceRecipient(recipient)) {
      throw new Error("A valid Drive evidence receipt exists for a different account");
    }
    await cleanupTransientDriveAcceptance(
      db,
      acceptanceCaseId(options.userId, existingReceipt.runId),
      options.userId,
      existingReceipt.runId,
    );
    return {
      status: "passed" as const,
      alreadyAccepted: true,
      runId: existingReceipt.runId,
      verifiedAt: existingReceipt.verifiedAt,
    };
  }

  // A failed prior attempt is safe to retry with the same run identifier.
  await cleanupTransientDriveAcceptance(db, caseId, options.userId, options.runId);
  const metadata = JSON.stringify({ kind: "provider_acceptance", source: "google_drive", runId: options.runId });
  await db.insert(cases).values({
    id: caseId,
    userId: options.userId,
    clientName: "LARO Google Drive evidence acceptance",
    clientEmail: recipient,
    caseType: "Provider acceptance",
    caseSummary: "Controlled Google Drive evidence ingestion and source retrieval; not a legal matter.",
    legalAreas: JSON.stringify(["Other"]),
    status: "active",
    metadata,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const pull = await dependencies.pullEvidence({
    caseId,
    userId: options.userId,
    keywords: [options.driveFileName.trim()],
    matchMode: "all",
    driveAccountId: options.googleAccountId,
    driveFolderIds: [options.driveFolderId?.trim() || "root"],
    driveExactFileName: options.driveFileName.trim(),
    includeGmail: false,
    includeGmailAttachments: false,
    includeDrive: true,
    includeLocal: false,
  });
  const collectionErrors = pull.errors.filter((error) => !error.startsWith('Analysis for "'));
  if (collectionErrors.length > 0) {
    throw new Error(`Drive acceptance pull reported ${collectionErrors.length} collection error(s)`);
  }

  const imported = await db.select().from(evidence).where(and(
    eq(evidence.caseId, caseId),
    eq(evidence.userId, options.userId),
    eq(evidence.source, "google_drive"),
  ));
  const matching = imported.filter((row) => {
    const source = parseMetadata(row.metadata);
    return source.driveAccountId === options.googleAccountId && typeof source.driveFileId === "string";
  });
  if (pull.driveFiles !== 1 || matching.length !== 1 || imported.length !== 1) {
    throw new Error(`Expected one exact Drive acceptance item, imported ${imported.length}`);
  }
  const item = matching[0];
  const sourceMetadata = parseMetadata(item.metadata);
  const storageKey = managedStorageKeyFromMetadata(item.metadata);
  const sourceId = sourceMetadata.driveFileId;
  const expectedHash = sourceMetadata.contentHash;
  if (!storageKey || typeof sourceId !== "string" || typeof expectedHash !== "string") {
    throw new Error("Imported Drive evidence is missing source provenance or its content hash");
  }

  const driveRows = await db.select().from(googleDriveFiles).where(and(
    eq(googleDriveFiles.caseId, caseId),
    eq(googleDriveFiles.userId, options.userId),
  ));
  if (
    driveRows.length !== 1 ||
    driveRows[0].googleFileId !== sourceId ||
    driveRows[0].s3Key !== storageKey
  ) {
    throw new Error("Imported Drive evidence is missing its provider provenance row");
  }

  const storedBytes = await storageRead(storageKey);
  if (hashBuffer(storedBytes) !== expectedHash) {
    throw new Error("Imported Drive evidence failed its stored-content hash check");
  }
  await dependencies.analyzeEvidence({
    userId: options.userId,
    evidenceId: item.id,
    deepAnalysis: false,
    force: true,
  });
  const [analysis] = await db.select().from(documentAnalyses).where(and(
    eq(documentAnalyses.evidenceId, item.id),
    eq(documentAnalyses.userId, options.userId),
  )).limit(1);
  const analysisResult = analysis ? parseMetadata(analysis.result) : {};
  if (
    !analysis ||
    analysis.status !== "complete" ||
    analysis.contentHash !== expectedHash ||
    analysisResult.status !== "complete" ||
    Number(analysis.analyzedChars || 0) <= 0
  ) {
    throw new Error("Imported Drive evidence did not complete deterministic content analysis");
  }

  const downloadUrl = await dependencies.getDownloadUrl(options.userId, item.id);
  if (!downloadUrl || !/^https?:\/\//i.test(downloadUrl)) {
    throw new Error("Imported Drive evidence did not resolve to an HTTP source link");
  }
  const fetchedBytes = await dependencies.fetchSource(downloadUrl);
  if (hashBuffer(fetchedBytes) !== expectedHash || !fetchedBytes.equals(storedBytes)) {
    throw new Error("Signed evidence source did not return the imported Drive bytes");
  }

  const existingOpenAudits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.userId, options.userId),
    eq(auditLogs.entityId, item.id),
    eq(auditLogs.action, AUDIT_ACTIONS.EVIDENCE_SOURCE_OPENED),
  ));
  if (existingOpenAudits.length === 0) {
    await dependencies.recordSourceOpened({
      userId: options.userId,
      evidenceId: item.id,
      accessMethod: "signed_http",
      acceptanceRun: options.runId,
      hashMatched: true,
    });
  } else if (
    existingOpenAudits.length !== 1 ||
    parseMetadata(existingOpenAudits[0].details).acceptanceRun !== options.runId
  ) {
    throw new Error("Drive acceptance source-open audit collision detected");
  }
  const sourceOpenAudits = await db.select().from(auditLogs).where(and(
    eq(auditLogs.userId, options.userId),
    eq(auditLogs.entityId, item.id),
    eq(auditLogs.action, AUDIT_ACTIONS.EVIDENCE_SOURCE_OPENED),
  ));
  if (sourceOpenAudits.length !== 1) {
    throw new Error(`Expected one Drive source-open audit, found ${sourceOpenAudits.length}`);
  }

  const receipt = await dependencies.recordReceipt({
    userId: options.userId,
    runId: options.runId,
    accountEmail: recipient,
    sourceId,
  });
  await cleanupTransientDriveAcceptance(db, caseId, options.userId, options.runId);

  return {
    status: "passed" as const,
    alreadyAccepted: false,
    runId: receipt.runId,
    verifiedAt: receipt.verifiedAt,
    source: receipt.source,
    persistedEvidenceCount: 1,
    sourceContentRead: true,
    contentHashMatched: true,
    analysisCompleted: true,
    sourceOpenedAuditRecorded: true,
    providerProvenanceRecorded: true,
    transientBusinessRowsRemoved: true,
  };
}

if (require.main === module) {
  const option = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index >= 0) return process.argv[index + 1];
    return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const userId = option("--user-id");
  const googleAccountId = option("--google-account-id");
  const recipient = option("--recipient");
  const confirmedRecipient = option("--confirm-account");
  const driveFileName = option("--drive-file-name");
  const driveFolderId = option("--drive-folder-id");
  const runId = option("--run-id");
  if (!userId || !googleAccountId || !recipient || !confirmedRecipient || !driveFileName || !runId) {
    console.error("Required: --user-id, --google-account-id, --recipient, --confirm-account, --drive-file-name, and --run-id");
    process.exitCode = 2;
  } else {
    runLiveGoogleDriveEvidenceAcceptance({
      userId,
      googleAccountId,
      recipient,
      confirmedRecipient,
      driveFileName,
      driveFolderId,
      runId,
    }).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  }
}
