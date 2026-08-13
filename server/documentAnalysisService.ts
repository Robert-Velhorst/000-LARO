import { randomUUID } from "crypto";
import { and, desc, eq } from "drizzle-orm";
import { assertCaseOwnership } from "./_core/authz";
import { getDb } from "./db";
import { analyzeDocumentBytes, DOCUMENT_ANALYSIS_VERSION, type DocumentAnalysisResult } from "./documentIntelligence";
import { getEvidenceFile } from "./evidence";
import { documentAnalyses } from "./schema";
import { storageRead } from "./storage";
import { getWorkflowPreferences } from "./workflowPreferences";
import { isLLMProviderConfigured } from "./llm";

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
    preferences.shareRawDocumentContent
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
  const cachedResult = cached ? parseDocumentAnalysisResult(cached.result) : null;
  const providerUpgradeNeeded = Boolean(
    deepAnalysis && provider && isLLMProviderConfigured(provider) && cachedResult?.providerStatus !== "complete"
  );
  if (!options.force && cached && !providerUpgradeNeeded && (!sourceHash || cached.contentHash === sourceHash)) {
    return { id: cached.id, cached: true, result: cachedResult! };
  }

  const bytes = await storageRead(storageKey);
  const result = await analyzeDocumentBytes({
    bytes,
    mimeType: item.mimeType || "application/octet-stream",
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
  if (cached) await db.update(documentAnalyses).set(values).where(eq(documentAnalyses.id, cached.id));
  else await db.insert(documentAnalyses).values({ ...values, createdAt: new Date() });
  return { id, cached: false, result };
}
