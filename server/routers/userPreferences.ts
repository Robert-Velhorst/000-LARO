import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { createAuditLog } from "../audit";
import { getDb } from "../db";
import { userPreferences } from "../schema";
import { getWorkflowPreferences, updateWorkflowPreferences } from "../workflowPreferences";
import { EXTERNAL_LLM_PROVIDERS } from "../llm";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const userPreferencesRouter = router({
  get: protectedProcedure.query(async ({ ctx }) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    const [row] = await db
      .select()
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, ctx.user.id), isNull(userPreferences.key)))
      .limit(1);

    return {
      dashboardWidgets: parseJson<Record<string, boolean>>(row?.dashboardWidgets, {}),
      notificationSettings: parseJson<Record<string, unknown>>(row?.notificationSettings, {}),
      preferredLawyers: parseJson<unknown[]>(row?.preferredLawyers, []),
      caseTemplates: parseJson<unknown[]>(row?.caseTemplates, []),
    };
  }),

  workflow: protectedProcedure.query(({ ctx }) => getWorkflowPreferences(ctx.user.id)),

  updateWorkflow: protectedProcedure
    .input(
      z.object({
        analysisMode: z.enum(["local", "cloud"]).optional(),
        analysisProvider: z.enum(["local", ...EXTERNAL_LLM_PROVIDERS]).optional(),
        autoAnalyzeImports: z.boolean().optional(),
        shareRawDocumentContent: z.boolean().optional(),
        outreachReviewMode: z.enum(["each", "batch", "automatic"]).optional(),
        messageApprovalMode: z.enum(["each", "batch", "automatic"]).optional(),
      }).refine((value) => Object.keys(value).length > 0, { message: "At least one workflow preference is required" }),
    )
    .mutation(async ({ ctx, input }) => {
      const preferences = await updateWorkflowPreferences(ctx.user.id, input);
      await createAuditLog({
        userId: ctx.user.id,
        action: "workflow.preferences_updated",
        entityType: "user",
        entityId: ctx.user.id,
        details: input,
      });
      return preferences;
    }),
});
