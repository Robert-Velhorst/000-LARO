import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { AUDIT_ACTIONS, writeAuditLogOrThrow } from "./audit";
import { getDb } from "./db";
import { buildGapAnalysisInputSnapshot } from "./evidenceCoverage";
import type { GeneratedDocument } from "./legalDocumentGenerator";
import {
  communicationGaps,
  documentAnalyses,
  evidence,
  evidenceCoverageAnalysis,
  expectedDocuments,
  legalDraftRecipients,
  legalDraftSnapshots,
  suspiciousPatterns,
} from "./schema";
import { hashBuffer, sanitizeFilename } from "./storage";

export const LEGAL_DRAFT_SNAPSHOT_CONTRACT = "legal-draft-snapshot-v1" as const;
const MAX_DRAFT_BYTES = 1024 * 1024;
const DOWNLOAD_TTL_MS = 2 * 60 * 1000;
const MAX_DOWNLOAD_TICKETS = 100;
const MAX_USER_DOWNLOAD_TICKETS = 5;

export type LegalDraftDocumentType = GeneratedDocument["type"];
export type RecipientProvenanceType = "owner_entered" | "evidence_derived";

type JsonObject = Record<string, unknown>;

export class LegalDraftPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalDraftPreconditionError";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseObject(value: string | null | undefined): JsonObject {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    return {};
  }
}

function normalizeLineText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

const TRANSIENT_ANALYSIS_KEYS = new Set([
  "createdAt",
  "updatedAt",
  "detectedAt",
  "generatedAt",
  "startedAt",
  "completedAt",
]);

function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semanticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonObject)
      .filter(([key]) => !TRANSIENT_ANALYSIS_KEYS.has(key))
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => [key, semanticValue(entry)]),
  );
}

function evidenceRevision(metadata: JsonObject, fallback: string | null): {
  contentHash: string | null;
  sourceRevision: string | null;
  revisionNumber: number | null;
} {
  const contentHash = typeof metadata.contentHash === "string"
    ? metadata.contentHash
    : fallback;
  const sourceRevision = typeof metadata.sourceRevision === "string"
    ? metadata.sourceRevision
    : null;
  const revisionNumber = Number.isSafeInteger(metadata.revisionNumber)
    ? Number(metadata.revisionNumber)
    : null;
  return { contentHash, sourceRevision, revisionNumber };
}

export interface ReviewedRecipientView {
  id: string;
  recipientId: string;
  caseId: string;
  revision: number;
  name: string;
  address: string;
  provenanceType: RecipientProvenanceType;
  evidenceId: string | null;
  sourceReference: JsonObject;
  revisionHash: string;
  reviewedAt: Date;
}

function recipientView(row: typeof legalDraftRecipients.$inferSelect): ReviewedRecipientView {
  return {
    id: row.id,
    recipientId: row.recipientId,
    caseId: row.caseId,
    revision: row.revision,
    name: row.name,
    address: row.address,
    provenanceType: row.provenanceType as RecipientProvenanceType,
    evidenceId: row.evidenceId,
    sourceReference: parseObject(row.sourceReference),
    revisionHash: row.revisionHash,
    reviewedAt: row.reviewedAt,
  };
}

async function latestRecipientRow(userId: string, caseId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(legalDraftRecipients).where(and(
    eq(legalDraftRecipients.userId, userId),
    eq(legalDraftRecipients.caseId, caseId),
  )).orderBy(desc(legalDraftRecipients.revision), desc(legalDraftRecipients.createdAt)).limit(1);
  return rows[0] ?? null;
}

export async function getCurrentReviewedRecipient(
  userId: string,
  caseId: string,
): Promise<ReviewedRecipientView | null> {
  const row = await latestRecipientRow(userId, caseId);
  return row ? recipientView(row) : null;
}

export async function saveReviewedRecipient(options: {
  userId: string;
  caseId: string;
  name: string;
  address: string;
  provenanceType: RecipientProvenanceType;
  evidenceId?: string;
}): Promise<ReviewedRecipientView> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const name = normalizeLineText(options.name);
  const address = normalizeLineText(options.address);
  if (!name || !address) {
    throw new LegalDraftPreconditionError("A recipient name and complete address are required.");
  }

  let evidenceId: string | null = null;
  let sourceReference: JsonObject;
  if (options.provenanceType === "evidence_derived") {
    if (!options.evidenceId) {
      throw new LegalDraftPreconditionError("Select the evidence that supports this recipient.");
    }
    const evidenceRows = await db.select().from(evidence).where(and(
      eq(evidence.id, options.evidenceId),
      eq(evidence.caseId, options.caseId),
      eq(evidence.userId, options.userId),
    )).limit(1);
    const source = evidenceRows[0];
    if (!source) {
      throw new LegalDraftPreconditionError("The selected recipient source is not available in this case.");
    }
    const analyses = await db.select().from(documentAnalyses).where(and(
      eq(documentAnalyses.evidenceId, source.id),
      eq(documentAnalyses.userId, options.userId),
    )).orderBy(desc(documentAnalyses.updatedAt), desc(documentAnalyses.id)).limit(1);
    const analysis = analyses[0] ?? null;
    const revision = evidenceRevision(parseObject(source.metadata), analysis?.contentHash ?? null);
    evidenceId = source.id;
    sourceReference = {
      kind: "evidence_derived",
      evidenceId: source.id,
      label: source.title,
      contentHash: revision.contentHash,
      sourceRevision: revision.sourceRevision,
      revisionNumber: revision.revisionNumber,
      analysisId: analysis?.id ?? null,
      analysisRevision: analysis
        ? digest([analysis.analysisVersion, analysis.contentHash, analysis.result])
        : null,
    };
  } else {
    sourceReference = {
      kind: "owner_entered",
      label: "Owner-provided recipient",
      fields: ["name", "address"],
    };
  }

  const revisionHash = digest([
    "legal-draft-recipient-v1",
    name,
    address,
    options.provenanceType,
    sourceReference,
  ]);

  const saved = db.transaction((tx) => {
    const latest = tx.select().from(legalDraftRecipients).where(and(
      eq(legalDraftRecipients.userId, options.userId),
      eq(legalDraftRecipients.caseId, options.caseId),
    )).orderBy(desc(legalDraftRecipients.revision), desc(legalDraftRecipients.createdAt)).limit(1).get();
    if (latest?.revisionHash === revisionHash) return latest;

    const now = new Date();
    const id = `LDR-${nanoid(20)}`;
    const recipientId = latest?.recipientId ?? `LR-${nanoid(20)}`;
    const revision = (latest?.revision ?? 0) + 1;
    tx.insert(legalDraftRecipients).values({
      id,
      recipientId,
      userId: options.userId,
      caseId: options.caseId,
      revision,
      name,
      address,
      provenanceType: options.provenanceType,
      evidenceId,
      sourceReference: JSON.stringify(sourceReference),
      revisionHash,
      reviewedBy: options.userId,
      reviewedAt: now,
      createdAt: now,
    }).run();
    writeAuditLogOrThrow(tx, {
      userId: options.userId,
      action: AUDIT_ACTIONS.LEGAL_DRAFT_RECIPIENT_REVIEWED,
      entityType: "legal_draft_recipient",
      entityId: id,
      details: {
        caseId: options.caseId,
        recipientId,
        revision,
        revisionHash,
        provenanceType: options.provenanceType,
        evidenceId,
      },
      idempotencyKey: `legal-recipient-reviewed:${id}`,
    });
    return tx.select().from(legalDraftRecipients).where(eq(legalDraftRecipients.id, id)).get()!;
  });
  return recipientView(saved);
}

export interface DraftRevisionState {
  coverageAnalysisId: string;
  caseRevision: string;
  inputRevision: string;
  sourceRevision: string;
  analysisRevision: string;
  evidenceReferences: unknown[];
  gaps: Array<{ id: string; data: JsonObject }>;
  expectedDocuments: Array<{ id: string; data: JsonObject }>;
  suspiciousPatterns: Array<{ id: string; data: JsonObject }>;
}

export async function loadCurrentDraftRevisionState(caseId: string): Promise<DraftRevisionState> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const coverageRows = await db.select().from(evidenceCoverageAnalysis)
    .where(eq(evidenceCoverageAnalysis.caseId, caseId))
    .orderBy(desc(evidenceCoverageAnalysis.createdAt), desc(evidenceCoverageAnalysis.id))
    .limit(1);
  const coverage = coverageRows[0];
  const coverageData = parseObject(coverage?.data);
  if (
    !coverage
    || coverageData.contractVersion !== "evidence-coverage-v1"
    || coverageData.contractStatus !== "current"
    || coverageData.analysisStatus !== "fresh"
    || typeof coverageData.inputRevision !== "string"
    || typeof coverageData.sourceRevision !== "string"
    || typeof coverageData.caseRevision !== "string"
  ) {
    throw new LegalDraftPreconditionError(
      "Run a current coverage review before creating or reviewing a legal draft.",
    );
  }
  const currentInput = await buildGapAnalysisInputSnapshot(caseId);
  if (currentInput.inputRevision !== coverageData.inputRevision) {
    throw new LegalDraftPreconditionError(
      "Case or evidence inputs changed. Run the coverage review again before reviewing this draft.",
    );
  }

  const [gapRows, expectedRows, patternRows] = await Promise.all([
    db.select().from(communicationGaps).where(eq(communicationGaps.caseId, caseId)).orderBy(asc(communicationGaps.id)),
    db.select().from(expectedDocuments).where(eq(expectedDocuments.caseId, caseId)).orderBy(asc(expectedDocuments.id)),
    db.select().from(suspiciousPatterns).where(eq(suspiciousPatterns.caseId, caseId)).orderBy(asc(suspiciousPatterns.id)),
  ]);
  const gaps = gapRows.map((row) => ({ id: row.id, data: parseObject(row.data) }));
  const expected = expectedRows.map((row) => ({ id: row.id, data: parseObject(row.data) }));
  const patterns = patternRows.map((row) => ({ id: row.id, data: parseObject(row.data) }));
  const evidenceReferences = Array.isArray(coverageData.inputs)
    ? coverageData.inputs.map(semanticValue)
    : [];
  const analysisRevision = digest({
    contract: "legal-draft-analysis-v1",
    inputRevision: coverageData.inputRevision,
    sourceRevision: coverageData.sourceRevision,
    coverage: semanticValue({
      counts: coverageData.counts,
      missingContext: coverageData.missingContext,
      legalBasis: coverageData.legalBasis,
      unknowns: coverageData.unknowns,
      limitations: coverageData.limitations,
      reviewActions: coverageData.reviewActions,
      summary: coverageData.summary,
    }),
    gaps: gaps.map((row) => semanticValue(row.data)),
    expectedDocuments: expected.map((row) => semanticValue(row.data)),
    suspiciousPatterns: patterns.map((row) => semanticValue(row.data)),
  });

  return {
    coverageAnalysisId: coverage.id,
    caseRevision: coverageData.caseRevision,
    inputRevision: coverageData.inputRevision,
    sourceRevision: coverageData.sourceRevision,
    analysisRevision,
    evidenceReferences,
    gaps,
    expectedDocuments: expected,
    suspiciousPatterns: patterns,
  };
}

function renderDownloadBytes(document: GeneratedDocument): Buffer {
  const reviewItems = document.consequences?.length
    ? `\n\nReview checklist:\n${document.consequences.map((item) => `- ${item}`).join("\n")}`
    : "";
  return Buffer.from(`${document.title}\n\n${document.content}${reviewItems}\n`, "utf8");
}

function draftFileName(type: LegalDraftDocumentType, caseId: string, version: number): string {
  return sanitizeFilename(`${type}_${caseId}_v${version}.txt`);
}

function draftView(row: typeof legalDraftSnapshots.$inferSelect, isCurrentInputs?: boolean) {
  return {
    id: row.id,
    caseId: row.caseId,
    documentType: row.documentType as LegalDraftDocumentType,
    version: row.version,
    status: row.status as "pending_review" | "reviewed",
    contentHash: row.contentHash,
    byteLength: row.byteLength,
    fileName: row.fileName,
    inputRevision: row.inputRevision,
    sourceRevision: row.sourceRevision,
    analysisRevision: row.analysisRevision,
    recipientRevision: row.recipientRevision,
    recipientRevisionId: row.recipientRevisionId,
    reviewedAt: row.reviewedAt,
    createdAt: row.createdAt,
    ...(isCurrentInputs === undefined ? {} : { isCurrentInputs }),
  };
}

export async function createLegalDraftSnapshot(options: {
  userId: string;
  caseId: string;
  document: GeneratedDocument;
  demandAmount?: number;
  recipient: ReviewedRecipientView;
  revisionState: DraftRevisionState;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const ownerInputRevision = digest({
    contract: "legal-draft-owner-input-v1",
    demandAmount: options.demandAmount ?? null,
  });
  const generationRevision = digest([
    LEGAL_DRAFT_SNAPSHOT_CONTRACT,
    options.document.type,
    options.revisionState.inputRevision,
    options.revisionState.sourceRevision,
    options.revisionState.analysisRevision,
    options.recipient.revisionHash,
    ownerInputRevision,
  ]);
  const bytes = renderDownloadBytes(options.document);
  if (bytes.length === 0 || bytes.length > MAX_DRAFT_BYTES) {
    throw new LegalDraftPreconditionError("The generated draft exceeds the supported snapshot size.");
  }
  const contentHash = hashBuffer(bytes);
  const recipientSnapshot = {
    recipientId: options.recipient.recipientId,
    revisionId: options.recipient.id,
    revision: options.recipient.revision,
    name: options.recipient.name,
    address: options.recipient.address,
    provenanceType: options.recipient.provenanceType,
    evidenceId: options.recipient.evidenceId,
    sourceReference: options.recipient.sourceReference,
  };
  const provenance = {
    contract: LEGAL_DRAFT_SNAPSHOT_CONTRACT,
    ownerProvided: [
      { field: "case.clientName", provenance: "case_owner" },
      { field: "recipient.name", provenance: options.recipient.provenanceType },
      { field: "recipient.address", provenance: options.recipient.provenanceType },
      ...(options.demandAmount === undefined
        ? []
        : [{ field: "demandAmount", provenance: "case_owner" }]),
    ],
    analysis: {
      coverageAnalysisId: options.revisionState.coverageAnalysisId,
      inputRevision: options.revisionState.inputRevision,
      sourceRevision: options.revisionState.sourceRevision,
      caseRevision: options.revisionState.caseRevision,
      analysisRevision: options.revisionState.analysisRevision,
      evidenceReferences: options.revisionState.evidenceReferences,
      derivedReferences: {
        communicationGapIds: options.revisionState.gaps.map((row) => row.id),
        expectedDocumentIds: options.revisionState.expectedDocuments.map((row) => row.id),
        suspiciousPatternIds: options.revisionState.suspiciousPatterns.map((row) => row.id),
      },
    },
  };

  const row = db.transaction((tx) => {
    const existing = tx.select().from(legalDraftSnapshots).where(and(
      eq(legalDraftSnapshots.userId, options.userId),
      eq(legalDraftSnapshots.caseId, options.caseId),
      eq(legalDraftSnapshots.documentType, options.document.type),
      eq(legalDraftSnapshots.generationRevision, generationRevision),
    )).limit(1).get();
    if (existing) return existing;

    const latest = tx.select({ version: legalDraftSnapshots.version }).from(legalDraftSnapshots).where(and(
      eq(legalDraftSnapshots.userId, options.userId),
      eq(legalDraftSnapshots.caseId, options.caseId),
      eq(legalDraftSnapshots.documentType, options.document.type),
    )).orderBy(desc(legalDraftSnapshots.version)).limit(1).get();
    const version = (latest?.version ?? 0) + 1;
    const id = `LDS-${nanoid(20)}`;
    const now = new Date();
    tx.insert(legalDraftSnapshots).values({
      id,
      userId: options.userId,
      caseId: options.caseId,
      documentType: options.document.type,
      version,
      status: "pending_review",
      generationRevision,
      inputRevision: options.revisionState.inputRevision,
      sourceRevision: options.revisionState.sourceRevision,
      caseRevision: options.revisionState.caseRevision,
      analysisRevision: options.revisionState.analysisRevision,
      coverageAnalysisId: options.revisionState.coverageAnalysisId,
      recipientRevisionId: options.recipient.id,
      recipientRevision: options.recipient.revision,
      recipientRevisionHash: options.recipient.revisionHash,
      recipientSnapshot: JSON.stringify(recipientSnapshot),
      ownerInputRevision,
      provenance: JSON.stringify(provenance),
      previewJson: JSON.stringify(options.document),
      contentBase64: bytes.toString("base64"),
      contentHash,
      byteLength: bytes.length,
      fileName: draftFileName(options.document.type, options.caseId, version),
      createdAt: now,
    }).run();
    return tx.select().from(legalDraftSnapshots).where(eq(legalDraftSnapshots.id, id)).get()!;
  });
  return {
    ...draftView(row, true),
    document: JSON.parse(row.previewJson) as GeneratedDocument,
    recipient: JSON.parse(row.recipientSnapshot) as typeof recipientSnapshot,
  };
}

export async function reviewLegalDraftSnapshot(options: {
  userId: string;
  draftId: string;
  contentHash: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(legalDraftSnapshots).where(and(
    eq(legalDraftSnapshots.id, options.draftId),
    eq(legalDraftSnapshots.userId, options.userId),
  )).limit(1);
  const row = rows[0];
  if (!row) throw new LegalDraftPreconditionError("Draft not found.");
  if (row.contentHash !== options.contentHash) {
    throw new LegalDraftPreconditionError("The draft changed after it was shown. Open it again before review.");
  }
  if (row.status === "reviewed") return draftView(row);

  const [currentState, currentRecipient] = await Promise.all([
    loadCurrentDraftRevisionState(row.caseId),
    getCurrentReviewedRecipient(options.userId, row.caseId),
  ]);
  if (
    currentState.inputRevision !== row.inputRevision
    || currentState.sourceRevision !== row.sourceRevision
    || currentState.caseRevision !== row.caseRevision
    || currentState.analysisRevision !== row.analysisRevision
  ) {
    throw new LegalDraftPreconditionError(
      "Case facts, evidence, or analysis changed. Generate and review a new draft version.",
    );
  }
  if (!currentRecipient || currentRecipient.id !== row.recipientRevisionId) {
    throw new LegalDraftPreconditionError(
      "The reviewed recipient changed. Generate and review a new draft version.",
    );
  }

  const reviewed = db.transaction((tx) => {
    const current = tx.select().from(legalDraftSnapshots).where(and(
      eq(legalDraftSnapshots.id, row.id),
      eq(legalDraftSnapshots.userId, options.userId),
    )).get();
    if (!current) throw new LegalDraftPreconditionError("Draft not found.");
    if (current.status === "reviewed") return current;
    const reviewedAt = new Date();
    const updated = tx.update(legalDraftSnapshots).set({
      status: "reviewed",
      reviewedBy: options.userId,
      reviewedAt,
    }).where(and(
      eq(legalDraftSnapshots.id, row.id),
      eq(legalDraftSnapshots.status, "pending_review"),
    )).run();
    if (Number(updated?.changes ?? 0) !== 1) {
      throw new LegalDraftPreconditionError("The draft review state changed. Open it again.");
    }
    writeAuditLogOrThrow(tx, {
      userId: options.userId,
      action: AUDIT_ACTIONS.LEGAL_DRAFT_REVIEWED,
      entityType: "legal_draft_snapshot",
      entityId: row.id,
      details: {
        caseId: row.caseId,
        documentType: row.documentType,
        version: row.version,
        contentHash: row.contentHash,
        recipientRevision: row.recipientRevision,
        inputRevision: row.inputRevision,
        sourceRevision: row.sourceRevision,
        analysisRevision: row.analysisRevision,
      },
      idempotencyKey: `legal-draft-reviewed:${row.id}:${row.contentHash}`,
    });
    return tx.select().from(legalDraftSnapshots).where(eq(legalDraftSnapshots.id, row.id)).get()!;
  });
  return draftView(reviewed);
}

export async function listLegalDraftSnapshots(userId: string, caseId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(legalDraftSnapshots).where(and(
    eq(legalDraftSnapshots.userId, userId),
    eq(legalDraftSnapshots.caseId, caseId),
  )).orderBy(desc(legalDraftSnapshots.createdAt), desc(legalDraftSnapshots.version));
  let currentState: DraftRevisionState | null = null;
  let currentRecipient: ReviewedRecipientView | null = null;
  try {
    [currentState, currentRecipient] = await Promise.all([
      loadCurrentDraftRevisionState(caseId),
      getCurrentReviewedRecipient(userId, caseId),
    ]);
  } catch {
    currentRecipient = await getCurrentReviewedRecipient(userId, caseId);
  }
  return rows.map((row) => draftView(row, Boolean(
    currentState
    && currentRecipient
    && row.inputRevision === currentState.inputRevision
    && row.sourceRevision === currentState.sourceRevision
    && row.caseRevision === currentState.caseRevision
    && row.analysisRevision === currentState.analysisRevision
    && row.recipientRevisionId === currentRecipient.id
  )));
}

type DraftDownloadTicket = {
  userId: string;
  draftId: string;
  expiresAt: number;
};
const draftDownloadTickets = new Map<string, DraftDownloadTicket>();

function cleanDownloadTickets(now: number): void {
  for (const [token, ticket] of draftDownloadTickets) {
    if (ticket.expiresAt <= now) draftDownloadTickets.delete(token);
  }
}

export async function issueLegalDraftDownloadTicket(userId: string, draftId: string): Promise<{
  token: string;
  filename: string;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(legalDraftSnapshots).where(and(
    eq(legalDraftSnapshots.id, draftId),
    eq(legalDraftSnapshots.userId, userId),
  )).limit(1);
  const row = rows[0];
  if (!row || row.status !== "reviewed") {
    throw new LegalDraftPreconditionError("Only an explicitly reviewed draft can be downloaded.");
  }
  const now = Date.now();
  cleanDownloadTickets(now);
  if (draftDownloadTickets.size >= MAX_DOWNLOAD_TICKETS) {
    throw new LegalDraftPreconditionError("Draft download capacity is full; retry shortly.");
  }
  const pendingForUser = [...draftDownloadTickets.values()]
    .filter((ticket) => ticket.userId === userId).length;
  if (pendingForUser >= MAX_USER_DOWNLOAD_TICKETS) {
    throw new LegalDraftPreconditionError("Too many pending draft downloads; use an existing link first.");
  }
  const token = randomBytes(32).toString("base64url");
  draftDownloadTickets.set(token, { userId, draftId, expiresAt: now + DOWNLOAD_TTL_MS });
  return { token, filename: row.fileName };
}

export function consumeLegalDraftDownloadTicket(token: string, userId: string): string {
  const ticket = draftDownloadTickets.get(token);
  draftDownloadTickets.delete(token);
  if (!ticket || ticket.expiresAt <= Date.now() || ticket.userId !== userId) {
    throw new LegalDraftPreconditionError("Draft download link is invalid or expired.");
  }
  return ticket.draftId;
}

export async function readReviewedLegalDraft(userId: string, draftId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const rows = await db.select().from(legalDraftSnapshots).where(and(
    eq(legalDraftSnapshots.id, draftId),
    eq(legalDraftSnapshots.userId, userId),
  )).limit(1);
  const row = rows[0];
  if (!row || row.status !== "reviewed") {
    throw new LegalDraftPreconditionError("Reviewed draft not found.");
  }
  const bytes = Buffer.from(row.contentBase64, "base64");
  if (bytes.length !== row.byteLength || hashBuffer(bytes) !== row.contentHash) {
    throw new LegalDraftPreconditionError("The persisted draft failed its integrity check.");
  }
  return {
    id: row.id,
    caseId: row.caseId,
    documentType: row.documentType,
    version: row.version,
    filename: row.fileName,
    contentHash: row.contentHash,
    bytes,
  };
}

/**
 * Durable authorization receipt written before the HTTP response is released.
 * Only identifiers, revisions, sizes, and hashes enter the audit store; draft
 * bytes and recipient text stay in the immutable snapshot table.
 */
export async function recordReviewedLegalDraftDownload(userId: string, draftId: string) {
  const source = await readReviewedLegalDraft(userId, draftId);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  db.transaction((tx) => {
    writeAuditLogOrThrow(tx, {
      userId,
      action: AUDIT_ACTIONS.LEGAL_DRAFT_DOWNLOADED,
      entityType: "legal_draft_snapshot",
      entityId: source.id,
      details: {
        caseId: source.caseId,
        documentType: source.documentType,
        version: source.version,
        contentHash: source.contentHash,
        bytes: source.bytes.length,
      },
    });
  });
  return source;
}
