import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { createAuditLog } from "../audit";
import { getDb } from "../db";
import { userPreferences } from "../schema";
import {
  getWorkflowPreferences,
  grantExternalDocumentSharingConsent,
  revokeExternalDocumentSharingConsent,
  updateWorkflowPreferences,
} from "../workflowPreferences";
import { EXTERNAL_LLM_PROVIDERS, LLM_PROVIDERS } from "../llm";
import { EXTERNAL_DOCUMENT_SHARING_SCOPE } from "../../shared/workflowConsent";

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
        analysisProvider: z.enum(["local", ...LLM_PROVIDERS]).optional(),
        autoAnalyzeImports: z.boolean().optional(),
        autoOrganizeDocuments: z.boolean().optional(),
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

  grantExternalDocumentSharing: protectedProcedure
    .input(z.object({
      provider: z.enum(EXTERNAL_LLM_PROVIDERS),
      scope: z.literal(EXTERNAL_DOCUMENT_SHARING_SCOPE),
      automaticImports: z.boolean(),
      acknowledgeFullDocumentContent: z.literal(true),
      acknowledgeAutomaticImports: z.literal(true),
    }).strict())
    .mutation(({ ctx, input }) => grantExternalDocumentSharingConsent(ctx.user.id, input.provider, input.automaticImports)),

  revokeExternalDocumentSharing: protectedProcedure
    .input(z.object({ consentId: z.string().min(1).max(100) }).strict())
    .mutation(({ ctx, input }) => revokeExternalDocumentSharingConsent(ctx.user.id, input.consentId)),
});
