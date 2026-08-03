import { COOKIE_NAME, SESSION_MAX_AGE_MS, SESSION_EXPIRES_IN } from "../../shared/const";
import { getSessionCookieOptions } from "../cookies";
import { systemRouter } from '../_core/systemRouter';
import { publicProcedure, router, protectedProcedure } from '../_core/trpc';
import { healthRouter } from "./health";
import { casesRouter } from "./cases";
import { lawyersRouter } from "./lawyers";
import { matchingRouter } from "./matching";
import { dashboardRouter } from "./dashboard";
import { outreachRouter } from "./outreach";
import { outreachDirectoryRouter } from "./outreachDirectory";
import { savedSearchesRouter } from "./savedSearches";
import { workflowRouter } from "./workflow";
import { evidenceFilesRouter } from "./evidenceFiles";
import { evidenceExportRouter } from "./evidenceExport";
import { evidenceTimelineRouter } from "./evidenceTimeline";
import { documentAnalysisRouter } from "./documentAnalysis";
import { searchRouter } from "./search";
import { messagesRouter } from "./messages";
import { messageTemplatesRouter } from "./messageTemplates";
import { lawyerRatingRouter } from "./lawyerRating";
import { trelloEnhancedRouter } from "./trelloEnhanced";
import { telegramEnhancedRouter } from "./telegramEnhanced";
import { gapAnalysisRouter } from "./gapAnalysis";
import { emailAccountsRouter } from "./emailAccounts";
import { emailRouter } from "./email";
import { userPreferencesRouter } from "./userPreferences";
import { bulkImportRouter } from "./bulkImport";
import { supportRouter } from "./support";
import { evidenceAnalyticsRouter } from "./evidenceAnalytics";
import { autoCollectionRouter } from "./autoCollection";
import { googleDriveRouter } from "./googleDrive";
import { notificationsRouter } from "./notifications";
import { relevanceScoringRouter } from "./relevanceScoring";
import { featureFlagsRouter } from "./featureFlags";
import { helpRouter } from "./help";
import { onboardingRouter } from "./onboarding";
import { teamsRouter } from "./teams";
import { legacyImportsRouter } from "./legacyImports";
import {
  adminAnalyticsRouter, outreachAnalyticsRouter,
  evidenceAggregationRouter, enrichmentRouter, evidenceRouter,
  bulkFileOperationsRouter, caseManagementRouter, legalChecklistsRouter,
  emailMessagesRouter, syncSchedulerRouter, trelloRouter, unifiedInboxRouter,
} from "./extendedRouters";
import { adminRouter } from "./admin";
import { auditRouter } from "./audit";
import { enforceRateLimit, RATE_LIMITS } from "../rateLimit";
import { createAuditLog, AUDIT_ACTIONS } from "../audit";
import {
  gmailEnhancedRouter,
  outlookEnhancedRouter,
  googleDriveEnhancedRouter,
  oneDriveEnhancedRouter,
  slackEnhancedRouter,
} from "./enhancedConnections";
import { z } from "zod";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { ENV } from "../_core/env";
import { sendPasswordResetEmail } from "../systemEmail";
import { getUser, getDb } from "../db";
import { users, cases } from "../schema";
import { and, count, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { invokeLLM } from "../llm";
import { answerCaseQuestion } from "../caseAssistant";
import { extractImageText } from "../ocr";
import {
  isSupportedImageOcrMimeType,
  MAX_EVIDENCE_BASE64_CHARS,
  MAX_EVIDENCE_FILE_BYTES,
} from "../../shared/evidenceFiles";
import { standaloneSignupAllowed } from "../signupPolicy";

export const appRouter = router({
  system: systemRouter,
  health: healthRouter,
  cases: casesRouter,
  lawyers: lawyersRouter,
  matching: matchingRouter,
  dashboard: dashboardRouter,
  outreach: outreachRouter,
  outreachDirectory: outreachDirectoryRouter,
  savedSearches: savedSearchesRouter,
  workflow: workflowRouter,
  evidenceFiles: evidenceFilesRouter,
  evidenceTimeline: evidenceTimelineRouter,
  documentAnalysis: documentAnalysisRouter,
  search: searchRouter,
  messages: messagesRouter,
  messageTemplates: messageTemplatesRouter,
  lawyerRating: lawyerRatingRouter,
  trelloEnhanced: trelloEnhancedRouter,
  telegramEnhanced: telegramEnhancedRouter,
  gapAnalysis: gapAnalysisRouter,
  emailAccounts: emailAccountsRouter,
  email: emailRouter,
  userPreferences: userPreferencesRouter,
  bulkImport: bulkImportRouter,
  evidenceAnalytics: evidenceAnalyticsRouter,
  support: supportRouter,
  autoCollection: autoCollectionRouter,
  googleDrive: googleDriveRouter,
  notifications: notificationsRouter,
  featureFlags: featureFlagsRouter, // Phase 058
  help: helpRouter, // Phase 071/072
  onboarding: onboardingRouter, // Phase 105
  teams: teamsRouter, // Phase 106
  legacyImports: legacyImportsRouter,
  // Phase 010 (D1) — routers the renderer referenced but that had no backend.
  adminAnalytics: adminAnalyticsRouter,
  outreachAnalytics: outreachAnalyticsRouter,
  relevanceScoring: relevanceScoringRouter,
  evidenceAggregation: evidenceAggregationRouter,
  enrichment: enrichmentRouter,
  evidence: evidenceRouter,
  evidenceExport: evidenceExportRouter,
  bulkFileOperations: bulkFileOperationsRouter,
  caseManagement: caseManagementRouter,
  legalChecklists: legalChecklistsRouter,
  emailMessages: emailMessagesRouter,
  syncScheduler: syncSchedulerRouter,
  trello: trelloRouter,
  unifiedInbox: unifiedInboxRouter,

  // Local operation has no paid tier or quota gate. Usage is observational and
  // helps the owner understand workload without blocking a core action.
  billing: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      let usage: unknown = null;
      try {
        const mod: any = await import("../usageTracking");
        usage = typeof mod.getUsageSummary === "function" ? await mod.getUsageSummary(ctx.user.id) : null;
      } catch { usage = null; }
      return {
        plan: "local" as const,
        billingConfigured: false as const,
        forcedBilling: false as const,
        note: "All core features are available without billing or usage quotas.",
        usage,
      };
    }),
  }),
  admin: adminRouter,
  audit: auditRouter, // Phase 019 — event-history read path
  
  gmailEnhanced: gmailEnhancedRouter,
  outlookEnhanced: outlookEnhancedRouter,
  googleDriveEnhanced: googleDriveEnhancedRouter,
  oneDriveEnhanced: oneDriveEnhancedRouter,
  slackEnhanced: slackEnhancedRouter,

  // Auth procedures
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    
    signup: publicProcedure
      .input(z.object({
        email: z.string().email(),
        password: z.string().min(8),
        name: z.string().min(2),
        bootstrapToken: z.string().max(256).optional(),
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

        const [userCount] = await db.select({ value: count() }).from(users);
        if (!standaloneSignupAllowed({
          serverOnly: ENV.SERVER_ONLY,
          existingUserCount: Number(userCount?.value || 0),
          expectedBootstrapToken: ENV.STANDALONE_SIGNUP_TOKEN,
          suppliedBootstrapToken: input.bootstrapToken,
        })) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Standalone account enrollment is closed.",
          });
        }

        const existing = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
        if (existing.length > 0) {
          throw new TRPCError({ code: "CONFLICT", message: "A user with this email already exists" });
        }

        const hashedPassword = await bcrypt.hash(input.password, 10);
        const userId = `USER${Date.now()}`;

        await db.insert(users).values({
          id: userId,
          email: input.email,
          password: hashedPassword,
          name: input.name,
          role: ENV.SERVER_ONLY ? "admin" : "user",
          createdAt: new Date(),
        });

        const token = jwt.sign({ userId }, ENV.JWT_SECRET, { expiresIn: SESSION_EXPIRES_IN });
        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, {
          ...cookieOptions,
          maxAge: SESSION_MAX_AGE_MS,
        });

        return { success: true };
      }),

    login: publicProcedure
      .input(z.object({ 
        email: z.string().email(),
        password: z.string()
      }))
      .mutation(async ({ input, ctx }) => {
        // Phase 018: throttle credential attempts (brute-force protection).
        enforceRateLimit(ctx, "login", RATE_LIMITS.auth);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

        const userResults = await db.select().from(users).where(eq(users.email, input.email)).limit(1);
        const user = userResults[0];

        if (!user || !user.password) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid email or password",
          });
        }

        const valid = await bcrypt.compare(input.password, user.password);
        if (!valid) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid email or password",
          });
        }

        const token = jwt.sign({ userId: user.id }, ENV.JWT_SECRET, {
          expiresIn: SESSION_EXPIRES_IN,
        });

        const cookieOptions = getSessionCookieOptions(ctx.req);
        ctx.res.cookie(COOKIE_NAME, token, {
          ...cookieOptions,
          maxAge: SESSION_MAX_AGE_MS,
        });

        await createAuditLog({ // Phase 019
          userId: user.id,
          action: AUDIT_ACTIONS.USER_LOGIN,
          entityType: "user",
          entityId: user.id,
        });

        return { success: true, user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role
        } };
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),

    // Phase 007 — revoke ALL sessions for the current user (e.g. after suspected
    // compromise). Every outstanding JWT issued at/before now stops working.
    logoutAllDevices: protectedProcedure.mutation(async ({ ctx }) => {
      const { revokeUserSessions } = await import("../sessionRevocation");
      await revokeUserSessions(ctx.user.id);
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),

    // Step 1 of password reset: email the user a one-time code. Always returns
    // success regardless of whether the email exists, to avoid leaking which
    // addresses have accounts (no user enumeration).
    requestPasswordReset: publicProcedure
      .input(z.object({ email: z.string().email() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

        const TTL_MINUTES = 15;
        const user = (
          await db.select().from(users).where(eq(users.email, input.email)).limit(1)
        )[0];

        // Only generate + send a code for accounts that have a password set
        // (OAuth-only accounts have nothing to reset).
        if (user && user.password) {
          const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
          const codeHash = crypto.createHash("sha256").update(code).digest("hex");
          const expiresAt = Date.now() + TTL_MINUTES * 60 * 1000;

          await db
            .update(users)
            .set({ resetCodeHash: codeHash, resetCodeExpiresAt: String(expiresAt) })
            .where(eq(users.id, user.id));

          try {
            await sendPasswordResetEmail(user.email!, code, TTL_MINUTES);
          } catch (e) {
            console.error("[auth.requestPasswordReset] email send failed:", e);
            // Don't surface delivery errors to the client (avoids enumeration
            // and matches the dev console-fallback behaviour).
          }
        }

        return { success: true } as const;
      }),

    // Step 2 of password reset: verify the code and set a new password.
    resetPassword: publicProcedure
      .input(
        z.object({
          email: z.string().email(),
          code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"),
          newPassword: z.string().min(8),
        })
      )
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });

        const user = (
          await db.select().from(users).where(eq(users.email, input.email)).limit(1)
        )[0];

        const invalid = new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid or expired reset code",
        });

        if (!user || !user.resetCodeHash || !user.resetCodeExpiresAt) throw invalid;
        if (Date.now() > Number(user.resetCodeExpiresAt)) throw invalid;

        const candidateHash = crypto.createHash("sha256").update(input.code).digest("hex");
        const a = Buffer.from(candidateHash);
        const b = Buffer.from(user.resetCodeHash);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw invalid;

        const hashedPassword = await bcrypt.hash(input.newPassword, 10);
        await db
          .update(users)
          .set({ password: hashedPassword, resetCodeHash: null, resetCodeExpiresAt: null })
          .where(eq(users.id, user.id));

        return { success: true } as const;
      }),

    getApiToken: protectedProcedure.query(({ ctx }) => {
      const token = jwt.sign({ userId: ctx.user.id }, ENV.JWT_SECRET, {
        expiresIn: SESSION_EXPIRES_IN,
      });
      return { token };
    }),
    getScannerToken: protectedProcedure.query(({ ctx }) => {
      const token = jwt.sign(
        { userId: ctx.user.id, scope: "evidence-scanner" },
        ENV.JWT_SECRET,
        { expiresIn: "15m" }
      );
      return { token, expiresInSeconds: 15 * 60 };
    }),
  }),

  // Clarifications procedures
  // Phase 111 — ambiguous external-action resolution. Real logic (was an empty
  // stub): computes genuine clarifications the user must resolve BEFORE outreach
  // can proceed — e.g. a case with no recipient-resolvable matches, or a case
  // classified into multiple legal areas where the user hasn't confirmed intent.
  // Resolutions are persisted in system_config keyed per user+clarification, so
  // an answered clarification stops reappearing. Nothing external happens here.
  clarifications: router({
    pending: protectedProcedure.query(async ({ ctx }) => {
      const db = await getDb();
      if (!db) return [] as Array<{ id: string; caseId: string; question: string; context: string }>;
      const { getSystemSwitch } = await import("../systemState");
      const rows = await db
        .select({ id: cases.id, clientName: cases.clientName, clientEmail: cases.clientEmail, legalAreas: cases.legalAreas, status: cases.status })
        .from(cases)
        .where(eq(cases.userId, ctx.user.id));
      const out: Array<{ id: string; caseId: string; question: string; context: string }> = [];
      for (const c of rows) {
        let areas: string[] = [];
        try { areas = JSON.parse(c.legalAreas || "[]"); } catch { areas = []; }
        // Ambiguity 1: multiple legal areas → which should drive matching?
        if (areas.length > 1) {
          const cid = `${c.id}:primary-area`;
          if (!(await getSystemSwitch(`clarify:${ctx.user.id}:${cid}`))) {
            out.push({ id: cid, caseId: c.id, question: `This case matches multiple legal areas (${areas.join(", ")}). Which is the primary area for lawyer matching?`, context: "multiple-legal-areas" });
          }
        }
        // Ambiguity 2: no client email → outreach recipient is unresolved.
        if (!c.clientEmail) {
          const cid = `${c.id}:contact`;
          if (!(await getSystemSwitch(`clarify:${ctx.user.id}:${cid}`))) {
            out.push({ id: cid, caseId: c.id, question: `This case has no client contact email. Add one before preparing outreach.`, context: "missing-contact" });
          }
        }
      }
      return out;
    }),
    answer: protectedProcedure
      .input(z.object({ questionId: z.string(), answer: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const { setSystemSwitch } = await import("../systemState");
        // Mark this clarification resolved for this user so it stops surfacing.
        await setSystemSwitch(`clarify:${ctx.user.id}:${input.questionId}`, true);
        return { ok: true as const, resolved: input.questionId };
      }),
  }),

  assistant: router({
    ask: protectedProcedure
      .input(
        z.object({
          question: z.string().trim().min(1).max(2000),
          caseId: z.string().optional(),
          page: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.caseId) {
          return answerCaseQuestion({
            userId: ctx.user.id,
            caseId: input.caseId,
            question: input.question,
          });
        }

        try {
          const result = await invokeLLM({
            messages: [
              {
                role: "system",
                content: "You are LARO, a legal assistant for general product and legal-workflow guidance. If the user asks case-specific questions without a selected case, ask them to open a case first.",
              },
              { role: "user", content: input.question },
            ],
            maxTokens: 700,
          });
          const content = result.choices?.[0]?.message?.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .map((part: any) => (part?.type === "text" ? part.text : ""))
                    .join("\n")
                : "";
          return {
            answer: text || "I could not generate an answer right now. Please try again.",
            citations: [],
            grounded: false,
            mode: "general" as const,
            notice: "No case is selected, so case evidence was not used.",
          };
        } catch {
          return {
            answer: "I am currently unable to reach the AI service. Please try again in a moment.",
            citations: [],
            grounded: false,
            mode: "general" as const,
            notice: "No case is selected, so case evidence was not used.",
          };
        }
      }),
  }),
  
  // Local OCR accepts bounded image bytes only. It never fetches caller-provided
  // URLs and uses the same engine as source-grounded evidence analysis.
  ocr: router({
    supportsOcr: protectedProcedure
      .input(z.object({ mimeType: z.string() }))
      .query(({ input }) => ({ supported: isSupportedImageOcrMimeType(input.mimeType) })),
    getStatus: protectedProcedure.input(z.any()).query(() => ({
      status: "available" as const,
      processing: "local" as const,
    })),
    getSupportedLanguages: protectedProcedure.query(() => ({
      languages: [
        { code: "nld", name: "Dutch" },
        { code: "eng", name: "English" },
        { code: "nld+eng", name: "Dutch + English" },
      ],
    })),
    extractText: protectedProcedure
      .input(z.object({
        image: z.string().min(1).max(MAX_EVIDENCE_BASE64_CHARS + 100),
        language: z.string().optional().default("nld+eng"),
      }))
      .mutation(async ({ ctx, input }) => {
        enforceRateLimit(ctx, "ocr", RATE_LIMITS.aiAnalysis);
        const match = input.image.match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!match || !isSupportedImageOcrMimeType(match[1])) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "OCR requires a supported base64 image" });
        }
        const bytes = Buffer.from(match[2], "base64");
        if (!bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES) {
          throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "OCR images must be between 1 byte and 7 MB" });
        }
        try {
          const result = await extractImageText(bytes, input.language);
          return {
            success: true as const,
            text: result.text,
            confidence: result.confidence,
            language: result.language,
            processingTime: result.processingTimeMs,
          };
        } catch (error) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: error instanceof Error ? error.message : "OCR failed",
          });
        }
      }),
  }),

  // Analytics procedures — Phase 055: local-first, computed from the user's own
  // data (no third-party telemetry). Previously returned {} / [].
  analytics: router({
    getOverallStats: protectedProcedure.query(async ({ ctx }) => {
      const { overallStats } = await import("../analytics");
      return overallStats(ctx.user.id);
    }),
    getLegalAreaDistribution: protectedProcedure.query(async ({ ctx }) => {
      const { legalAreaDistribution } = await import("../analytics");
      return legalAreaDistribution(ctx.user.id);
    }),
    getCaseDistribution: protectedProcedure.query(async ({ ctx }) => {
      const { caseStatusDistribution } = await import("../analytics");
      return caseStatusDistribution(ctx.user.id);
    }),
    // Not yet derived from real data — returned as explicit empty rather than fabricated.
    getOutreachTrends: protectedProcedure.query(() => [] as Array<{ date: string; count: number }>),
    getLawyerPerformance: protectedProcedure.query(() => [] as unknown[]),
    getLawyerCapacity: protectedProcedure.query(() => [] as unknown[]),
    getWorkloadMetrics: protectedProcedure.query(() => [] as unknown[]),
  }),



  // GDPR procedures — Phase 028: real access + erasure (were empty stubs).
  gdpr: router({
    getConsent: protectedProcedure.query(async ({ ctx }) => {
      const { getPrivacyPreferences } = await import('../privacyPreferences');
      const preferences = await getPrivacyPreferences(ctx.user.id);
      return {
        // This describes required service processing, not proof of a GDPR legal
        // basis. The deployment operator must document that basis separately.
        dataProcessing: true,
        ...preferences,
      };
    }),
    // Full data export (right of access). Returns every row owned by the user.
    exportData: protectedProcedure.mutation(async ({ ctx }) => {
      const { exportUserData } = await import("../gdpr");
      const data = await exportUserData(ctx.user.id);
      await createAuditLog({ userId: ctx.user.id, action: "gdpr.export", entityType: "user", entityId: ctx.user.id });
      return { success: true, data };
    }),
    // Permanent account + data deletion (right of erasure).
    deleteData: protectedProcedure
      .input(z.object({ confirm: z.literal(true) }))
      .mutation(async ({ ctx }) => {
        const { deleteUserData } = await import("../gdpr");
        // Audit BEFORE deleting (the audit row for this user is erased too, but
        // the action is recorded in the same transaction window).
        await createAuditLog({ userId: ctx.user.id, action: "gdpr.delete", entityType: "user", entityId: ctx.user.id });
        const result = await deleteUserData(ctx.user.id);
        // Clear the session cookie since the account no longer exists.
        try {
          const { getSessionCookieOptions } = await import("../cookies");
          ctx.res.clearCookie(COOKIE_NAME, { ...getSessionCookieOptions(ctx.req), maxAge: -1 });
        } catch { /* ignore */ }
        return { success: true, ...result };
      }),
    updateConsent: protectedProcedure
      .input(
        z.object({ marketing: z.boolean().optional(), analytics: z.boolean().optional() })
          .refine((input) => input.marketing !== undefined || input.analytics !== undefined, {
            message: 'At least one privacy preference is required',
          })
      )
      .mutation(async ({ ctx, input }) => {
        const { updatePrivacyPreferences } = await import('../privacyPreferences');
        const preferences = await updatePrivacyPreferences(ctx.user.id, input);
        await createAuditLog({
          userId: ctx.user.id,
          action: "gdpr.consent_updated",
          entityType: "user",
          entityId: ctx.user.id,
          details: preferences,
        });
        return { success: true, ...preferences };
      }),
  }),

  // Agent procedures
  agent: router({
    listDevices: protectedProcedure.query(() => []),
    revokeDevice: protectedProcedure
      .input(z.object({ deviceId: z.string().min(1) }))
      .mutation(() => {
        throw new Error('Remote device registration and revocation are not available in this build.');
      }),
  }),
});

export type AppRouter = typeof appRouter;
