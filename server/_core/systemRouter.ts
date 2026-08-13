import { router, publicProcedure, protectedProcedure } from './trpc';
import { ENV } from './env';
import { capabilitiesFor, normalizeRole } from './roles';
import { APP_VERSION } from './version';
import { resolveOutboundEmailConfiguration } from '../emailConfig';
import { getLLMProviderDescriptors } from '../llm';

export const systemRouter = router({
  health: publicProcedure.query(() => ({
    status: 'ok',
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  })),

  // Phase 037 — app info the UI uses to show an unmistakable environment/demo
  // banner. `demoMode` is forced false in production so demo behaviour can never
  // be confused with real production.
  appInfo: publicProcedure.query(() => ({
    version: APP_VERSION,
    env: ENV.NODE_ENV,
    isProduction: ENV.isProd,
    demoMode: ENV.isDemo,
    // A ready-to-render label for a banner; empty in normal production.
    banner: ENV.isDemo
      ? 'DEMO MODE — sample environment, not for real cases'
      : ENV.isProd
        ? ''
        : `DEVELOPMENT (${ENV.NODE_ENV}) — not for production use`,
  })),

  // Phase 063 — provider credential verification checklist. Reports which
  // integrations are configured (by env presence) WITHOUT exposing any secret
  // value — only booleans + the names of the required env vars. Lets an operator
  // see at a glance what still needs credentials before a feature will work.
  // Phase 079 (red-team): require auth — even the "which integrations exist"
  // signal should not be exposed to unauthenticated callers.
  // Phase 106 — role-based capabilities for the current user, so the renderer can
  // show/hide role-gated settings. Derived from the real users.role value.
  capabilities: protectedProcedure.query(({ ctx }) => {
    const role = normalizeRole((ctx.user as { role?: string | null }).role);
    return { role, capabilities: capabilitiesFor(role) };
  }),

  providerChecklist: protectedProcedure.query(() => {
    const has = (v: string | undefined) => !!(v && v.length > 0);
    const outboundEmail = resolveOutboundEmailConfiguration();
    const items = [
      { provider: 'AI analysis (selected provider)', category: 'ai', requiredEnv: ['one supported provider API key'],
        configured: getLLMProviderDescriptors().some((provider) => provider.configured),
        note: 'Optional — provider-backed AI actions fail closed without this key; deterministic analysis remains available.' },
      { provider: 'Google (Gmail/Drive)', category: 'oauth', requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
        configured: has(ENV.GOOGLE_CLIENT_ID) && has(ENV.GOOGLE_CLIENT_SECRET) },
      { provider: 'Microsoft (Outlook/OneDrive)', category: 'oauth', requiredEnv: [], configured: false,
        note: 'Unavailable — OAuth plumbing exists, but evidence collection is not release-capable.' },
      { provider: 'AWS S3 (evidence storage)', category: 'storage', requiredEnv: ['AWS_S3_BUCKET', 'AWS_S3_ACCESS_KEY', 'AWS_S3_SECRET_KEY'],
        configured: has(ENV.AWS_S3_BUCKET) && has(ENV.AWS_S3_ACCESS_KEY) && has(ENV.AWS_S3_SECRET_KEY),
        note: 'Optional — falls back to local disk storage.' },
      { provider: 'Email send (SendGrid/SMTP)', category: 'email',
        requiredEnv: ['SENDGRID_API_KEY + EMAIL_FROM | SMTP_HOST + SMTP_USER + SMTP_PASS + SMTP_FROM'],
        configured: outboundEmail.configured,
        note: outboundEmail.missingVars.length > 0
          ? `Incomplete configuration; missing ${outboundEmail.missingVars.join(', ')}.`
          : undefined },
      { provider: 'Trello', category: 'evidence', requiredEnv: [], configured: false,
        note: 'Unavailable — secure server-side token persistence is not implemented.' },
      { provider: 'Telegram', category: 'evidence', requiredEnv: ['TELEGRAM_BOT_TOKEN'], configured: has(ENV.TELEGRAM_BOT_TOKEN) },
    ];
    return {
      configuredCount: items.filter((i) => i.configured).length,
      total: items.length,
      items,
    };
  }),
});
