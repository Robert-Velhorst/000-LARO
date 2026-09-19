import { randomUUID } from "crypto";
import { sourceFailureMessage } from "../shared/sourceFailure";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "./db";
import { cases, documentAnalyses, documentInbox, evidence } from "./schema";
import { hashBuffer, sanitizeFilename, storageDelete, storagePut, storageRead } from "./storage";
import { writeAuditLogOrThrow } from "./audit";
import { createCaseId } from "./ids";
import { analyzeDocumentExtraction, extractDocumentTextInAcquiredSlot, withDocumentAnalysisResourceSlot, type DocumentAnalysisResult } from "./documentIntelligence";
import { documentContentAuthorizationToken, getWorkflowPreferences } from "./workflowPreferences";
import { referencesForCase, sourceReferences } from "./documentCaseMatching";
import { evidenceTypeForMime, MAX_EVIDENCE_FILE_BYTES } from "../shared/evidenceFiles";
import { discoverDossier, discoveryCaseSnapshot, type DiscoveryCase, type DiscoveryDecision } from "./dossierDiscovery";
import type { SourceProvenance } from "./documentSourceTypes";
import { isLLMUsageLimitError } from "./llmUsageBudget";

function discoveryContext(rows: Array<typeof cases.$inferSelect>): DiscoveryCase[] {
  return rows.map((row) => ({ id: row.id, title: row.clientName || row.caseType || row.id,
    summary: row.caseSummary || "", metadata: row.metadata }));
}

function storeCaseAnalysis(db: Pick<Awaited<ReturnType<typeof getDb>>, "insert">, input: {
  userId: string; caseId: string; evidenceId: string; contentHash: string; analysis: DocumentAnalysisResult;
}) {
  const { analysis, ...source } = input;
  const now = new Date();
  const values = { ...source, analysisVersion: analysis.analysisVersion, status: analysis.status,
    extractionMethod: analysis.extractionMethod, providerStatus: analysis.providerStatus,
    documentType: analysis.documentType, confidence: analysis.confidence, summary: analysis.summary,
    result: JSON.stringify(analysis), analyzedChars: analysis.analyzedChars, updatedAt: now };
  db.insert(documentAnalyses).values({ ...values, id: randomUUID(), createdAt: now })
    .onConflictDoUpdate({ target: [documentAnalyses.evidenceId, documentAnalyses.analysisVersion], set: values }).run();
}

export async function getOwnedInboxItem(userId: string, id: string) {
  const db = await getDb();
  const [row] = await db.select().from(documentInbox).where(and(eq(documentInbox.id, id), eq(documentInbox.userId, userId))).limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Inbox document not found" });
  return row;
}

export async function stageInboxDocument(userId: string, input: {
  fileName: string; sourcePath?: string; mimeType: string; bytes: Buffer; provenance?: SourceProvenance;
}) {
  const db = await getDb();
  const fileName = sanitizeFilename(input.fileName);
  const sourcePath = input.sourcePath || fileName;
  const contentHash = hashBuffer(input.bytes);
  const sourceType = input.provenance?.source || "manual";
  const where = and(eq(documentInbox.userId, userId), eq(documentInbox.sourceType, sourceType), eq(documentInbox.sourcePath, sourcePath), eq(documentInbox.contentHash, contentHash));
  const [existing] = await db.select({ id: documentInbox.id }).from(documentInbox).where(where).limit(1);
  if (existing) return { id: existing.id, duplicate: true };
  const id = randomUUID();
  // Original names remain metadata, not filesystem components (Windows name limits).
  const stored = await storagePut(`inbox/${userId}/${id}`, input.bytes, input.mimeType);
  let inserted = false;
  try {
    const result = db.transaction((tx) => {
      const raced = tx.select({ id: documentInbox.id }).from(documentInbox).where(where).get();
      if (raced) return { id: raced.id, duplicate: true };
      const now = new Date();
      tx.insert(documentInbox).values({ id, userId, fileName, sourcePath, sourceType, provenance: input.provenance ? JSON.stringify(input.provenance) : null, mimeType: input.mimeType,
        fileSize: input.bytes.length, storageKey: stored.key, contentHash, createdAt: now, updatedAt: now }).run();
      writeAuditLogOrThrow(tx, { userId, action: "inbox.uploaded", entityType: "document_inbox", entityId: id,
        details: { contentHash, fileSize: input.bytes.length } });
      return { id, duplicate: false };
    });
    inserted = !result.duplicate;
    return result;
  } finally {
    if (!inserted) await storageDelete(stored.key).catch(() => undefined);
  }
}

export async function readInboxOriginal(userId: string, id: string) {
  const row = await getOwnedInboxItem(userId, id);
  const bytes = await storageRead(row.storageKey, { maxBytes: MAX_EVIDENCE_FILE_BYTES });
  if (hashBuffer(bytes) !== row.contentHash) throw new TRPCError({ code: "CONFLICT", message: "Source integrity check failed" });
  return { row, bytes };
}

async function organizeInboxDocumentUnlocked(userId: string, id: string, explicitCaseId?: string) {
  const { row: original } = await readInboxOriginal(userId, id);
  const db = await getDb();
  const preferences = await getWorkflowPreferences(userId);
  const discoveryProvider = preferences.analysisProvider === "local" ? null : preferences.analysisProvider;
  const discoveryAuthorizationToken = discoveryProvider
    ? documentContentAuthorizationToken(preferences, discoveryProvider, userId)
    : null;
  const originalAnalysis: DocumentAnalysisResult | null = original.analysis ? JSON.parse(original.analysis) : null;
  const originalReferences = sourceReferences(original.sourceText || "");
  let discovery: DiscoveryDecision | null = null;
  let snapshot: string | null = null;
  if (!explicitCaseId && !original.evidenceId && originalAnalysis?.coverage.complete && preferences.autoOrganizeDocuments && originalReferences.length <= 1) {
    const ownedCases = await db.select().from(cases).where(eq(cases.userId, userId));
    const exactMatches = originalReferences.length === 1
      ? ownedCases.filter((candidate) => referencesForCase(candidate).includes(originalReferences[0].value)) : [];
    if (exactMatches.length === 0 && (originalReferences.length === 0 || preferences.analysisProvider !== "local")) {
      const candidates = discoveryContext(ownedCases);
      snapshot = discoveryCaseSnapshot(candidates);
      discovery = await discoverDossier({ ownerId: userId, analysis: originalAnalysis, sourceText: original.sourceText || "", cases: candidates, preferences,
        canContinue: async () => {
          const currentPreferences = await getWorkflowPreferences(userId);
          if (!currentPreferences.autoOrganizeDocuments || currentPreferences.analysisProvider !== preferences.analysisProvider ||
              (discoveryProvider && documentContentAuthorizationToken(currentPreferences, discoveryProvider, userId) !== discoveryAuthorizationToken)) return false;
          const current = await getOwnedInboxItem(userId, id);
          if (current.analysis !== original.analysis || current.sourceText !== original.sourceText || current.evidenceId !== original.evidenceId) return false;
          const currentCases = await db.select().from(cases).where(eq(cases.userId, userId));
          return discoveryCaseSnapshot(discoveryContext(currentCases)) === snapshot;
        },
      });
    }
  }
  const latestPreferences = await getWorkflowPreferences(userId);
  // No await inside this transaction: selection, case creation, evidence, analysis and audit commit together.
  return db.transaction((tx) => {
    const row = tx.select().from(documentInbox).where(and(eq(documentInbox.id, id), eq(documentInbox.userId, userId))).get();
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Inbox document not found" });
    if (explicitCaseId && !tx.select({ id: cases.id }).from(cases).where(and(eq(cases.id, explicitCaseId), eq(cases.userId, userId))).get()) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Case not found" });
    }
    if (row.evidenceId) {
      const linked = tx.select({ caseId: evidence.caseId }).from(evidence).where(and(eq(evidence.id, row.evidenceId), eq(evidence.userId, userId))).get();
      if (linked) {
        if (explicitCaseId && explicitCaseId !== linked.caseId) throw new TRPCError({ code: "CONFLICT", message: "Document is already assigned to another case" });
        return { decision: row.decision, caseId: linked.caseId, evidenceId: row.evidenceId };
      }
    }
    const analysis: DocumentAnalysisResult | null = row.analysis ? JSON.parse(row.analysis) : null;
    const references = sourceReferences(row.sourceText || "");
    let caseId = explicitCaseId;
    let decision = "assigned";
    let reason = explicitCaseId ? "Case selected by the owner" : "";
    const method = explicitCaseId ? "owner" : discovery ? "semantic_provider" : "explicit_source_reference";
    const now = new Date();
    if (!caseId && discovery) {
      const currentSnapshot = discoveryCaseSnapshot(discoveryContext(tx.select().from(cases).where(eq(cases.userId, userId)).all()));
      if (snapshot !== currentSnapshot || original.analysis !== row.analysis || original.sourceText !== row.sourceText) {
        reason = "The source or case inventory changed during discovery. Retry with the updated context.";
      } else if (!latestPreferences.autoOrganizeDocuments || preferences.analysisProvider !== latestPreferences.analysisProvider ||
                 (discoveryProvider && documentContentAuthorizationToken(latestPreferences, discoveryProvider, userId) !== discoveryAuthorizationToken)) {
        reason = "The analysis or organization settings changed during discovery. Retry with the current settings.";
      } else if (discovery.action === "assign" && discovery.caseId) {
        caseId = discovery.caseId;
        reason = discovery.reason;
      } else if (discovery.action === "create") {
        caseId = createCaseId(); decision = "created"; reason = discovery.reason;
        tx.insert(cases).values({ id: caseId, userId, clientName: discovery.title, caseType: "Unclassified",
          caseSummary: discovery.summary, status: "active", legalAreas: "[]",
          metadata: JSON.stringify({ provisional: true, sourceReferences: references.map((item) => item.value), discoveredFromInboxId: id, discoveryMethod: method }),
          createdAt: now, updatedAt: now }).run();
        writeAuditLogOrThrow(tx, { userId, action: "case.discovered", entityType: "case", entityId: caseId,
          details: { inboxId: id, method, discovery, provisional: true } });
      } else reason = discovery.reason;
    } else if (!caseId) {
      reason = !analysis ? "Analysis is required" : !latestPreferences.autoOrganizeDocuments ? "Automatic organization is disabled"
        : !analysis.coverage.complete ? "Source analysis is incomplete"
        : analysis.extractionConfidence !== null && (!Number.isFinite(analysis.extractionConfidence) || analysis.extractionConfidence < 80)
          ? "OCR confidence is too low for automatic dossier assignment; verify the source reference first"
        : references.length !== 1 ? "No unique explicit case reference in the source" : "";
      if (!reason) {
        const reference = references[0].value;
        const matches = tx.select().from(cases).where(eq(cases.userId, userId)).all()
          .filter((candidate) => referencesForCase(candidate).includes(reference));
        if (matches.length > 1) reason = "More than one case contains this reference";
        else if (matches.length === 1) {
          caseId = matches[0].id;
          reason = `Exact source reference: ${reference}`;
        } else {
          caseId = createCaseId();
          decision = "created";
          reason = `New provisional dossier from source reference: ${reference}`;
          tx.insert(cases).values({ id: caseId, userId, clientName: `Dossier ${reference}`, caseType: "Unclassified",
            caseSummary: analysis!.summary, status: "active", legalAreas: "[]",
            metadata: JSON.stringify({ provisional: true, sourceReferences: [reference], discoveredFromInboxId: id }),
            createdAt: now, updatedAt: now }).run();
          writeAuditLogOrThrow(tx, { userId, action: "case.discovered", entityType: "case", entityId: caseId,
            details: { inboxId: id, reference: references[0], method: "explicit_source_reference", provisional: true } });
        }
      }
    }
    if (!caseId) {
      const reviewedDiscovery = discovery ? { ...discovery, action: "review", confidence: "low", caseId: null, reason } : null;
      tx.update(documentInbox).set({ decision: "needs_review", reason,
        discovery: reviewedDiscovery ? JSON.stringify(reviewedDiscovery) : null, updatedAt: now }).where(eq(documentInbox.id, id)).run();
      if (discovery) writeAuditLogOrThrow(tx, { userId, action: "inbox.discovery_review", entityType: "document_inbox", entityId: id,
        details: { method, discovery, reason, contentHash: row.contentHash } });
      return { decision: "needs_review", caseId: null, evidenceId: null };
    }
    const evidenceId = randomUUID();
    tx.insert(evidence).values({ id: evidenceId, userId, caseId, title: row.fileName, fileName: row.fileName,
      type: evidenceTypeForMime(row.mimeType), source: row.sourceType, mimeType: row.mimeType, fileSize: String(row.fileSize),
      description: analysis?.summary || null, metadata: JSON.stringify({ ...(row.provenance ? JSON.parse(row.provenance) : {}), storageKey: row.storageKey, contentHash: row.contentHash,
        inboxId: id, sourcePath: row.sourcePath, organizationMethod: method }),
      createdAt: now, updatedAt: now }).run();
    if (analysis) {
      storeCaseAnalysis(tx, { evidenceId, caseId, userId, contentHash: row.contentHash, analysis });
    }
    tx.update(documentInbox).set({ evidenceId, decision, reason,
      discovery: discovery ? JSON.stringify(discovery) : null, updatedAt: now }).where(eq(documentInbox.id, id)).run();
    tx.update(cases).set({ updatedAt: now }).where(eq(cases.id, caseId)).run();
    writeAuditLogOrThrow(tx, { userId, action: "inbox.organized", entityType: "document_inbox", entityId: id,
      details: { caseId, evidenceId, method, references, discovery, contentHash: row.contentHash } });
    return { decision, caseId, evidenceId };
  });
}

// Model calls run outside SQLite transactions. Serialize per owner so parallel
// imports compare against dossiers created by the preceding import, not stale snapshots.
const organizationQueues = new Map<string, { tail: Promise<void>; pending: number }>();
export async function organizeInboxDocument(userId: string, id: string, explicitCaseId?: string) {
  let queue = organizationQueues.get(userId);
  if ((!queue && organizationQueues.size >= 32) || (queue && queue.pending >= 8)) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Dossier organization is busy. Retry shortly." });
  }
  if (!queue) { queue = { tail: Promise.resolve(), pending: 0 }; organizationQueues.set(userId, queue); }
  const previous = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => { release = resolve; });
  queue.pending += 1;
  await previous;
  try { return await organizeInboxDocumentUnlocked(userId, id, explicitCaseId); }
  finally {
    queue.pending -= 1; release();
    if (queue.pending === 0) organizationQueues.delete(userId);
  }
}

const active = new Map<string, Promise<Awaited<ReturnType<typeof organizeInboxDocument>>>>();

export async function processInboxDocument(userId: string, id: string, force = false) {
  // The key includes the owner; callers cannot observe another user's in-flight work.
  await getOwnedInboxItem(userId, id);
  const key = `${userId}:${id}`;
  const existing = active.get(key);
  if (existing) return existing;
  if (active.size >= 8) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Document processing is busy. Retry shortly." });
  const operation = (async () => {
    const db = await getDb();
    const row = await getOwnedInboxItem(userId, id);
    if (!row.analysis || force) {
      try {
        const preferences = await getWorkflowPreferences(userId);
        const provider = preferences.analysisProvider === "local" ? undefined : preferences.analysisProvider;
        const authorizationToken = provider ? documentContentAuthorizationToken(preferences, provider, userId) : null;
        const extraction = await withDocumentAnalysisResourceSlot(async () => {
          const { bytes } = await readInboxOriginal(userId, id);
          return extractDocumentTextInAcquiredSlot(bytes, row.mimeType);
        });
        const result = await analyzeDocumentExtraction({ extraction, provider,
          budget: { ownerId: userId },
          deepAnalysis: Boolean(provider && authorizationToken),
          // The transport invokes this after queueing, for every source chunk.
          beforeDispatch: async () => {
            const current = await getOwnedInboxItem(userId, id);
            const currentPreferences = await getWorkflowPreferences(userId);
            return current.contentHash === row.contentHash && current.storageKey === row.storageKey &&
              currentPreferences.analysisProvider === preferences.analysisProvider &&
              Boolean(provider && authorizationToken &&
                documentContentAuthorizationToken(currentPreferences, provider, userId) === authorizationToken);
          },
        });
        db.transaction((tx) => {
          tx.update(documentInbox).set({ analysis: JSON.stringify(result), sourceText: extraction.text, error: null, updatedAt: new Date() })
            .where(and(eq(documentInbox.id, id), eq(documentInbox.userId, userId))).run();
          const latest = tx.select({ evidenceId: documentInbox.evidenceId }).from(documentInbox)
            .where(and(eq(documentInbox.id, id), eq(documentInbox.userId, userId))).get();
          if (latest?.evidenceId) {
            const linked = tx.select({ caseId: evidence.caseId }).from(evidence)
              .where(and(eq(evidence.id, latest.evidenceId), eq(evidence.userId, userId))).get();
            if (linked) storeCaseAnalysis(tx, { userId, evidenceId: latest.evidenceId, caseId: linked.caseId, contentHash: row.contentHash, analysis: result });
          }
          writeAuditLogOrThrow(tx, { userId, action: "inbox.analyzed", entityType: "document_inbox", entityId: id,
            details: { provider: result.analysisProvider, providerStatus: result.providerStatus, contentHash: row.contentHash } });
        });
      } catch (error) {
        if (isLLMUsageLimitError(error)) throw error;
        const message = `${sourceFailureMessage(error)} The saved original is preserved.`;
        await db.update(documentInbox).set({ error: message, updatedAt: new Date() }).where(and(eq(documentInbox.id, id), eq(documentInbox.userId, userId)));
        throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message });
      }
    }
    return organizeInboxDocument(userId, id);
  })();
  active.set(key, operation);
  try { return await operation; } finally { active.delete(key); }
}
