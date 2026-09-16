import { z } from "zod";
import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../_core/trpc";
import { sendSystemEmail } from "../systemEmail";
import { resolveOutboundEmailConfiguration } from "../emailConfig";
import { normalizeAccountEmail } from "../emailIdentity";
import { roleSatisfies } from "../_core/roles";
import { assertNotEmergencyStopped } from "../systemState";
import { enforcePersistentRateLimit, RATE_LIMITS } from "../rateLimit";
import { AUDIT_ACTIONS, writeAuditLogOrThrow } from "../audit";
import { getDb } from "../db";

type EmailTestOutcome = "attempted" | "denied" | "rate_limited" | "failed" | "delivered";

const EMAIL_TEST_AUDIT_ACTION: Record<EmailTestOutcome, string> = {
  attempted: AUDIT_ACTIONS.EMAIL_TEST_ATTEMPTED,
  denied: AUDIT_ACTIONS.EMAIL_TEST_DENIED,
  rate_limited: AUDIT_ACTIONS.EMAIL_TEST_RATE_LIMITED,
  failed: AUDIT_ACTIONS.EMAIL_TEST_FAILED,
  delivered: AUDIT_ACTIONS.EMAIL_TEST_DELIVERED,
};

function recipientFingerprint(value: string): string {
  return createHash("sha256").update(normalizeAccountEmail(value)).digest("hex");
}

function acceptedTestRecipients(currentEmail: string | null): Set<string> {
  const configured = (process.env.LARO_EMAIL_TEST_ALLOWLIST || "")
    .split(",")
    .map(normalizeAccountEmail)
    .filter(Boolean);
  if (currentEmail) configured.push(normalizeAccountEmail(currentEmail));
  return new Set(configured);
}

async function recordEmailTest(
  ctx: { user: { id: string }; req: { headers?: Record<string, unknown> } },
  recipient: string,
  outcome: EmailTestOutcome,
  details: { reason?: string; provider?: string } = {},
): Promise<void> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  try {
    writeAuditLogOrThrow(db, {
      userId: ctx.user.id,
      action: EMAIL_TEST_AUDIT_ACTION[outcome],
      entityType: "system",
      entityId: "transactional_email_test",
      userAgent: typeof ctx.req.headers?.["user-agent"] === "string"
        ? String(ctx.req.headers["user-agent"]).slice(0, 300)
        : undefined,
      details: {
        outcome,
        recipientHash: recipientFingerprint(recipient),
        ...(details.reason ? { reason: details.reason } : {}),
        ...(details.provider ? { provider: details.provider } : {}),
      },
    });
  } catch (error) {
    console.error("[EmailTest] Mandatory audit write failed", {
      outcome,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Audit storage is unavailable; the email test was not confirmed.",
    });
  }
}

function resolveProvider() {
  const configuration = resolveOutboundEmailConfiguration();
  const from = configuration.from || "noreply@laro.local";
  if (configuration.provider === "sendgrid") {
    return {
      provider: "sendgrid" as const,
      name: "SendGrid",
      configured: configuration.configured,
      from,
      missingVars: configuration.missingVars,
    };
  }
  if (configuration.provider === "smtp") {
    return {
      provider: "smtp" as const,
      name: "SMTP",
      configured: configuration.configured,
      from,
      missingVars: configuration.missingVars,
    };
  }

  return {
    provider: "console" as const,
    name: "Console (Development)",
    configured: false,
    from: from || "Not configured",
    missingVars: configuration.missingVars,
  };
}

export const emailRouter = router({
  getProviderInfo: protectedProcedure.query(() => resolveProvider()),

  test: protectedProcedure
    .input(
      z.object({
        to: z.string().trim().email("Invalid email address"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const recipient = normalizeAccountEmail(input.to);
      const provider = resolveProvider().provider;
      if (!roleSatisfies(ctx.user.role, "admin")) {
        await recordEmailTest(ctx, recipient, "denied", { reason: "admin_capability_required" });
        throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
      }
      if (!acceptedTestRecipients(ctx.user.email).has(recipient)) {
        await recordEmailTest(ctx, recipient, "denied", { reason: "recipient_not_allowed" });
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Test email may only be sent to the current admin address or an operator allowlist address.",
        });
      }
      try {
        await assertNotEmergencyStopped();
      } catch (error) {
        await recordEmailTest(ctx, recipient, "denied", { reason: "emergency_stop" });
        throw error;
      }
      try {
        await enforcePersistentRateLimit(ctx, "transactional-email-test", RATE_LIMITS.transactionalEmailTest);
      } catch (error) {
        if (error instanceof TRPCError && error.code === "TOO_MANY_REQUESTS") {
          await recordEmailTest(ctx, recipient, "rate_limited", { provider });
        }
        throw error;
      }
      await recordEmailTest(ctx, recipient, "attempted", { provider });

      let result;
      try {
        result = await sendSystemEmail({
          to: recipient,
          subject: "LARO transactional email self-test",
          text: "This is an administrator-requested transactional email configuration test from LARO.",
        });
      } catch (error) {
        await recordEmailTest(ctx, recipient, "failed", { provider });
        throw error;
      }
      await recordEmailTest(ctx, recipient, result.delivered ? "delivered" : "failed", {
        provider: result.provider,
      });
      return {
        success: result.delivered,
        provider: result.provider,
        message: result.delivered
          ? `Test email sent through ${result.provider}.`
          : "No transactional email provider is configured; no email was sent.",
      };
    }),
});
