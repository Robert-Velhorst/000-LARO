import nodemailer from "nodemailer";
import { ENV } from "./_core/env";
import { resolveOutboundEmailConfiguration } from "./emailConfig";

const EMAIL_PROVIDER_TIMEOUT_MS = 20_000;
const EMAIL_PROVIDER_SOCKET_TIMEOUT_MS = 30_000;

/**
 * System (transactional) email sender — used for app-generated mail like
 * password-reset codes and explicitly approved outreach.
 *
 * Provider precedence: SendGrid → SMTP (nodemailer) → console fallback.
 * The console fallback keeps the feature testable in development / when no
 * provider is configured: the message (including any reset code) is logged so
 * a developer can complete the flow locally.
 */

export interface SystemEmail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SystemEmailResult {
  delivered: boolean;
  provider: "sendgrid" | "smtp" | "console" | "unconfigured";
  providerMessageId?: string;
}

function fromAddress(): string {
  return resolveOutboundEmailConfiguration().from || "noreply@laro.local";
}

function createSmtpTransport() {
  const port = Number(process.env.SMTP_PORT) || 587;
  const startTls = process.env.SMTP_STARTTLS !== "false";
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465 && startTls,
    tls: { minVersion: "TLSv1.2" },
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: EMAIL_PROVIDER_TIMEOUT_MS,
    greetingTimeout: EMAIL_PROVIDER_TIMEOUT_MS,
    socketTimeout: EMAIL_PROVIDER_SOCKET_TIMEOUT_MS,
  });
}

async function sendViaSendGrid(email: SystemEmail): Promise<string | undefined> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: email.to }] }],
      from: { email: fromAddress() },
      subject: email.subject,
      content: [
        { type: "text/plain", value: email.text },
        ...(email.html ? [{ type: "text/html", value: email.html }] : []),
      ],
    }),
    signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SendGrid send failed (${res.status}): ${detail}`);
  }
  return res.headers.get("x-message-id") || undefined;
}

async function sendViaSmtp(email: SystemEmail): Promise<string | undefined> {
  const transport = createSmtpTransport();
  try {
    const result = await transport.sendMail({
      from: fromAddress(),
      to: email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    const accepted = (result.accepted || []).map((entry) => (
      typeof entry === "string"
        ? entry.toLowerCase()
        : entry.address.toLowerCase()
    ));
    if (!accepted.some((entry) => entry.includes(email.to.trim().toLowerCase()))) {
      throw new Error("SMTP provider did not accept the intended recipient");
    }
    return result.messageId || undefined;
  } finally {
    transport.close();
  }
}

export async function verifyOutboundEmailConnection(): Promise<{
  ok: boolean;
  provider: "sendgrid" | "smtp" | "unconfigured";
}> {
  const configuration = resolveOutboundEmailConfiguration();
  if (configuration.provider === "smtp" && configuration.configured) {
    const transport = createSmtpTransport();
    try {
      await transport.verify();
      return { ok: true, provider: "smtp" };
    } finally {
      transport.close();
    }
  }
  if (configuration.provider === "sendgrid" && configuration.configured) {
    const response = await fetch("https://api.sendgrid.com/v3/user/profile", {
      headers: { Authorization: `Bearer ${ENV.SENDGRID_API_KEY}` },
      signal: AbortSignal.timeout(EMAIL_PROVIDER_TIMEOUT_MS),
    });
    return { ok: response.ok, provider: "sendgrid" };
  }
  return { ok: false, provider: "unconfigured" };
}

export async function sendSystemEmail(email: SystemEmail): Promise<SystemEmailResult> {
  const configuration = resolveOutboundEmailConfiguration();
  if (configuration.provider === "sendgrid" && configuration.configured) {
    const providerMessageId = await sendViaSendGrid(email);
    return { delivered: true, provider: "sendgrid", providerMessageId };
  }
  if (configuration.provider === "smtp" && configuration.configured) {
    const providerMessageId = await sendViaSmtp(email);
    return { delivered: true, provider: "smtp", providerMessageId };
  }

  if (ENV.isProd) {
    const detail = configuration.missingVars.length > 0
      ? ` Missing: ${configuration.missingVars.join(", ")}.`
      : "";
    console.warn(`[systemEmail] No complete transactional email provider is configured; message was not sent.${detail}`);
    return { delivered: false, provider: "unconfigured" };
  }

  console.log(`[systemEmail] Development preview for ${email.to}: ${email.subject}\n${email.text}`);
  return { delivered: false, provider: "console" };
}

/**
 * Send a password-reset code email. Returns the send result; callers should not
 * surface delivery details to the client (to avoid leaking account existence).
 */
export async function sendPasswordResetEmail(
  to: string,
  code: string,
  ttlMinutes: number
): Promise<SystemEmailResult> {
  const subject = "Your LARO password reset code";
  const text =
    `You requested to reset your LARO password.\n\n` +
    `Your reset code is: ${code}\n\n` +
    `This code expires in ${ttlMinutes} minutes. ` +
    `If you didn't request this, you can safely ignore this email.`;
  const html =
    `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;">` +
    `<h2 style="color:#111;">Reset your LARO password</h2>` +
    `<p style="color:#444;">Use the code below to set a new password:</p>` +
    `<div style="font-size:32px;font-weight:700;letter-spacing:6px;color:#111;` +
    `background:#f4f4f5;border-radius:8px;padding:16px;text-align:center;margin:16px 0;">${code}</div>` +
    `<p style="color:#666;font-size:13px;">This code expires in ${ttlMinutes} minutes. ` +
    `If you didn't request this, you can safely ignore this email.</p>` +
    `</div>`;
  return sendSystemEmail({ to, subject, text, html });
}
