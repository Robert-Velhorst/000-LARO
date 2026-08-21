import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { assertCaseOwnership } from "./_core/authz";
import { getDb } from "./db";
import {
  analyzeDocumentExtraction,
  DOCUMENT_ANALYSIS_VERSION,
  extractDocumentTextInAcquiredSlot,
  type DocumentAnalysisResult,
  withDocumentAnalysisResourceSlot,
} from "./documentIntelligence";
import { getEvidenceFile } from "./evidence";
import { documentAnalyses } from "./schema";
import { storageRead } from "./storage";
import { getWorkflowPreferences } from "./workflowPreferences";
import { getLLMProviderDescriptors, isLLMProviderConfigured, isLocalLLMProvider } from "./llm";
import { MAX_EVIDENCE_FILE_BYTES } from "../shared/evidenceFiles";

const PROVIDER_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export function parseDocumentAnalysisResult(value: string): DocumentAnalysisResult {
  return JSON.parse(value) as DocumentAnalysisResult;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try { return JSON.parse(value) as Record<string, unknown>; } catch { return {}; }
}

export async function analyzeStoredEvidence(options: {
  userId: string;
  evidenceId: string;
  deepAnalysis?: boolean;
  force?: boolean;
}) {
  const db = await getDb();
  const item = await getEvidenceFile(options.userId, options.evidenceId);
  if (!item) throw new Error("Evidence file not found");
  await assertCaseOwnership(item.caseId, options.userId);

  const metadata = parseMetadata(item.metadata);
  const preferences = await getWorkflowPreferences(options.userId);
  const provider = preferences.analysisProvider === "local" ? undefined : preferences.analysisProvider;
  const requestedDeepAnalysis = options.deepAnalysis ?? true;
  const deepAnalysis = Boolean(
    requestedDeepAnalysis &&
    provider &&
    (isLocalLLMProvider(provider) || preferences.shareRawDocumentContent)
  );
  const storageKey = metadata.storageKey;
  if (typeof storageKey !== "string" || !storageKey) {
    throw new Error("This evidence record has no stored source file to analyze");
  }
  const sourceHash = typeof metadata.contentHash === "string" ? metadata.contentHash : item.contentHash;
  const [cached] = await db
    .select()
    .from(documentAnalyses)
    .where(and(
      eq(documentAnalyses.evidenceId, item.id),
      eq(documentAnalyses.analysisVersion, DOCUMENT_ANALYSIS_VERSION)
    ))
    .orderBy(desc(documentAnalyses.updatedAt))
    .limit(1);
  let cachedResult: DocumentAnalysisResult | null = null;
  if (cached) {
    try {
      cachedResult = parseDocumentAnalysisResult(cached.result);
    } catch {
      // A corrupt cache must never make the source document permanently unanalyzable.
    }
  }
  const requestedAnalysisProvider = deepAnalysis && provider ? provider : "local";
  const requestedProviderModel = provider
    ? getLLMProviderDescriptors().find((item) => item.id === provider)?.model ?? null
    : null;
  const providerMatches = cachedResult?.analysisProvider === requestedAnalysisProvider &&
    (requestedAnalysisProvider === "local" || cachedResult?.providerModel === requestedProviderModel);
  const cachedAgeMs = cached ? Math.max(0, Date.now() - cached.updatedAt.getTime()) : Number.POSITIVE_INFINITY;
  const providerRetryNeeded = Boolean(
    deepAnalysis &&
    provider &&
    providerMatches &&
    isLLMProviderConfigured(provider) &&
    (cachedResult?.providerStatus === "unavailable" || (
      cachedResult?.providerStatus !== "complete" && cachedAgeMs >= PROVIDER_RETRY_COOLDOWN_MS
    ))
  );
  if (
    !options.force &&
    cached &&
    cachedResult &&
    providerMatches &&
    !providerRetryNeeded &&
    (!sourceHash || cached.contentHash === sourceHash)
  ) {
    return { id: cached.id, cached: true, result: cachedResult };
  }

  const extraction = await withDocumentAnalysisResourceSlot(async () => {
    const bytes = await storageRead(storageKey, { maxBytes: MAX_EVIDENCE_FILE_BYTES });
    return extractDocumentTextInAcquiredSlot(bytes, item.mimeType || "application/octet-stream");
  });
  const result = await analyzeDocumentExtraction({
    extraction,
    deepAnalysis,
    provider,
  });
  const id = cached?.id ?? randomUUID();
  const values = {
    id,
    evidenceId: item.id,
    caseId: item.caseId,
    userId: options.userId,
    analysisVersion: DOCUMENT_ANALYSIS_VERSION,
    contentHash: sourceHash || result.contentHash,
    status: result.status,
    extractionMethod: result.extractionMethod,
    providerStatus: result.providerStatus,
    documentType: result.documentType,
    confidence: result.confidence,
    summary: result.summary,
    result: JSON.stringify(result),
    analyzedChars: result.analyzedChars,
    updatedAt: new Date(),
  };
  await db.insert(documentAnalyses).values({ ...values, createdAt: cached?.createdAt ?? new Date() })
    .onConflictDoUpdate({
      target: [documentAnalyses.evidenceId, documentAnalyses.analysisVersion],
      set: values,
    });
  const [stored] = await db.select({ id: documentAnalyses.id })
    .from(documentAnalyses)
    .where(and(
      eq(documentAnalyses.evidenceId, item.id),
      eq(documentAnalyses.analysisVersion, DOCUMENT_ANALYSIS_VERSION),
    ))
    .limit(1);
  return { id: stored?.id ?? id, cached: false, result };
}
