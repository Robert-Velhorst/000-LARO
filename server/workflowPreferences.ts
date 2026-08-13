import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "./db";
import { userPreferences } from "./schema";
import { EXTERNAL_LLM_PROVIDERS, type LLMProvider } from "./llm";

export const WORKFLOW_PREFERENCE_KEY = "workflow-controls";

export type AnalysisMode = "local" | "cloud";
export type AnalysisProvider = "local" | LLMProvider;
export type ReviewMode = "each" | "batch" | "automatic";

export interface WorkflowPreferences {
  analysisMode: AnalysisMode;
  analysisProvider: AnalysisProvider;
  autoAnalyzeImports: boolean;
  shareRawDocumentContent: boolean;
  outreachReviewMode: ReviewMode;
  messageApprovalMode: ReviewMode;
}

export const DEFAULT_WORKFLOW_PREFERENCES: WorkflowPreferences = {
  analysisMode: "local",
  analysisProvider: "local",
  autoAnalyzeImports: true,
  shareRawDocumentContent: true,
  outreachReviewMode: "each",
  messageApprovalMode: "each",
};

function parseWorkflowPreferences(value: string | null | undefined): WorkflowPreferences {
  if (!value) return { ...DEFAULT_WORKFLOW_PREFERENCES };
  try {
    const parsed = JSON.parse(value) as Partial<WorkflowPreferences>;
    const externalProvider = EXTERNAL_LLM_PROVIDERS.includes(parsed.analysisProvider as LLMProvider)
      ? parsed.analysisProvider as LLMProvider
      : null;
    const analysisProvider: AnalysisProvider = parsed.analysisProvider === "local"
      ? "local"
      : externalProvider || (parsed.analysisMode === "cloud" ? "forge" : "local");
    return {
      analysisMode: analysisProvider === "local" ? "local" : "cloud",
      analysisProvider,
      autoAnalyzeImports: parsed.autoAnalyzeImports !== false,
      shareRawDocumentContent: parsed.shareRawDocumentContent !== false,
      outreachReviewMode: ["each", "batch", "automatic"].includes(parsed.outreachReviewMode || "")
        ? parsed.outreachReviewMode as ReviewMode
        : "each",
      messageApprovalMode: ["each", "batch", "automatic"].includes(parsed.messageApprovalMode || "")
        ? parsed.messageApprovalMode as ReviewMode
        : "each",
    };
  } catch {
    return { ...DEFAULT_WORKFLOW_PREFERENCES };
  }
}

export async function getWorkflowPreferences(userId: string): Promise<WorkflowPreferences> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(
      eq(userPreferences.userId, userId),
      eq(userPreferences.key, WORKFLOW_PREFERENCE_KEY),
    ))
    .limit(1);
  return parseWorkflowPreferences(row?.value);
}

export async function updateWorkflowPreferences(
  userId: string,
  updates: Partial<WorkflowPreferences>,
): Promise<WorkflowPreferences> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction((tx) => {
    const row = tx
      .select({ value: userPreferences.value })
      .from(userPreferences)
      .where(and(
        eq(userPreferences.userId, userId),
        eq(userPreferences.key, WORKFLOW_PREFERENCE_KEY),
      ))
      .limit(1)
      .get();
    const current = parseWorkflowPreferences(row?.value);
    const normalizedUpdates = { ...updates };
    if (updates.analysisProvider) {
      normalizedUpdates.analysisMode = updates.analysisProvider === "local" ? "local" : "cloud";
    } else if (updates.analysisMode) {
      normalizedUpdates.analysisProvider = updates.analysisMode === "cloud" ? "forge" : "local";
    }
    const next = parseWorkflowPreferences(JSON.stringify({ ...current, ...normalizedUpdates }));
    const now = new Date();
    tx.insert(userPreferences).values({
      id: nanoid(),
      userId,
      key: WORKFLOW_PREFERENCE_KEY,
      value: JSON.stringify(next),
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value: JSON.stringify(next), updatedAt: now },
    }).run();
    return next;
  });
}
