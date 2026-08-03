import { createHash, createHmac, timingSafeEqual } from "crypto";
import { eq } from "drizzle-orm";
import { APP_VERSION } from "./_core/version";
import { ENV } from "./_core/env";
import { AUDIT_ACTIONS } from "./audit";
import { getDb } from "./db";
import { auditLogs, systemConfig } from "./schema";
import { nanoid } from "nanoid";

const OUTBOUND_RECEIPT_PREFIX = "acceptance:outbound-email:";

export interface OutboundAcceptanceReceipt {
  schemaVersion: 1;
  userId: string;
  runId: string;
  provider: "smtp" | "sendgrid";
  recipientHash: string;
  messageCount: 1;
  sentAuditCount: 1;
  duplicateBlocked: true;
  verifiedAt: string;
  appVersion: string;
  signature: string;
}

type UnsignedOutboundReceipt = Omit<OutboundAcceptanceReceipt, "signature">;

function receiptKey(userId: string): string {
  return `${OUTBOUND_RECEIPT_PREFIX}${userId}`;
}

function canonicalReceipt(receipt: UnsignedOutboundReceipt): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    userId: receipt.userId,
    runId: receipt.runId,
    provider: receipt.provider,
    recipientHash: receipt.recipientHash,
    messageCount: receipt.messageCount,
    sentAuditCount: receipt.sentAuditCount,
    duplicateBlocked: receipt.duplicateBlocked,
    verifiedAt: receipt.verifiedAt,
    appVersion: receipt.appVersion,
  });
}

function signReceipt(receipt: UnsignedOutboundReceipt): string {
  return createHmac("sha256", ENV.COOKIE_SECRET).update(canonicalReceipt(receipt)).digest("hex");
}

function isValidSignature(receipt: OutboundAcceptanceReceipt): boolean {
  if (!/^[a-f0-9]{64}$/.test(receipt.signature)) return false;
  const expected = Buffer.from(signReceipt(receipt), "hex");
  const actual = Buffer.from(receipt.signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashAcceptanceRecipient(recipient: string): string {
  return createHash("sha256").update(recipient.trim().toLowerCase()).digest("hex");
}

export async function recordOutboundAcceptanceReceipt(input: {
  userId: string;
  runId: string;
  provider: "smtp" | "sendgrid";
  recipient: string;
  verifiedAt?: Date;
}): Promise<OutboundAcceptanceReceipt> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const unsigned: UnsignedOutboundReceipt = {
    schemaVersion: 1,
    userId: input.userId,
    runId: input.runId,
    provider: input.provider,
    recipientHash: hashAcceptanceRecipient(input.recipient),
    messageCount: 1,
    sentAuditCount: 1,
    duplicateBlocked: true,
    verifiedAt: (input.verifiedAt ?? new Date()).toISOString(),
    appVersion: APP_VERSION,
  };
  const receipt: OutboundAcceptanceReceipt = { ...unsigned, signature: signReceipt(unsigned) };
  const recordedAt = new Date();
  db.transaction((tx: any) => {
    tx.insert(systemConfig).values({
      configKey: receiptKey(input.userId),
      configValue: JSON.stringify(receipt),
      updatedAt: recordedAt,
    }).onConflictDoUpdate({
      target: systemConfig.configKey,
      set: { configValue: JSON.stringify(receipt), updatedAt: recordedAt },
    }).run();
    tx.insert(auditLogs).values({
      id: nanoid(),
      userId: input.userId,
      action: AUDIT_ACTIONS.PROVIDER_ACCEPTANCE_RECORDED,
      entityType: "provider_acceptance",
      entityId: input.runId,
      details: JSON.stringify({
        provider: input.provider,
        recipientHash: receipt.recipientHash,
        messageCount: receipt.messageCount,
        duplicateBlocked: receipt.duplicateBlocked,
        appVersion: receipt.appVersion,
      }),
      createdAt: recordedAt,
    }).run();
  });
  return receipt;
}

export async function readOutboundAcceptanceReceipt(
  userId: string,
): Promise<OutboundAcceptanceReceipt | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db.select({ value: systemConfig.configValue })
    .from(systemConfig)
    .where(eq(systemConfig.configKey, receiptKey(userId)))
    .limit(1);
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<OutboundAcceptanceReceipt>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.userId !== userId ||
      typeof parsed.runId !== "string" ||
      !["smtp", "sendgrid"].includes(parsed.provider || "") ||
      !/^[a-f0-9]{64}$/.test(parsed.recipientHash || "") ||
      parsed.messageCount !== 1 ||
      parsed.sentAuditCount !== 1 ||
      parsed.duplicateBlocked !== true ||
      typeof parsed.verifiedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.verifiedAt)) ||
      typeof parsed.appVersion !== "string" ||
      typeof parsed.signature !== "string"
    ) {
      return null;
    }
    const receipt = parsed as OutboundAcceptanceReceipt;
    return isValidSignature(receipt) ? receipt : null;
  } catch {
    return null;
  }
}
