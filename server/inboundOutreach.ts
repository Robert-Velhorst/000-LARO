import { and, eq, inArray, isNull } from "drizzle-orm";
import { AUDIT_ACTIONS, writeAuditLogOrThrow } from "./audit";
import { getDb } from "./db";
import { createNotification } from "./notifications";
import { cases, lawyers, outreachStatus } from "./schema";

type LinkStatus = "linked" | "duplicate" | "unmatched" | "ambiguous";

export interface InboundOutreachMessage {
  gmailMessageId: string;
  gmailThreadId?: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: Date;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

function parseMetadata(raw: string | null): Record<string, any> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function normalizeMessageId(value: string | null | undefined): string {
  return String(value || "").trim().replace(/^<|>$/g, "").toLowerCase();
}

function referencedMessageIds(message: InboundOutreachMessage): Set<string> {
  return new Set(
    [message.inReplyTo, message.references]
      .filter(Boolean)
      .flatMap((value) => String(value).split(/\s+/))
      .map(normalizeMessageId)
      .filter(Boolean),
  );
}

function normalizeSubject(value: string): string {
  let subject = value.trim();
  while (/^(re|fw|fwd)\s*:/i.test(subject)) subject = subject.replace(/^(re|fw|fwd)\s*:\s*/i, "");
  return subject.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractEmail(value: string): string {
  const bracketed = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracketed) return bracketed[1].trim().toLowerCase();
  const plain = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return plain?.[0].trim().toLowerCase() || "";
}

export async function linkInboundOutreachReply(options: {
  userId: string;
  caseId: string;
  message: InboundOutreachMessage;
}): Promise<{ status: LinkStatus; outreachId?: string }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [ownedCase] = await db.select({ id: cases.id }).from(cases).where(and(eq(cases.id, options.caseId), eq(cases.userId, options.userId))).limit(1);
  if (!ownedCase) return { status: "unmatched" };

  const rows = await db
    .select({ outreach: outreachStatus, lawyerEmail: lawyers.email })
    .from(outreachStatus)
    .leftJoin(lawyers, eq(outreachStatus.lawyerId, lawyers.id))
    .where(and(
      eq(outreachStatus.caseId, options.caseId),
      inArray(outreachStatus.status, ["Sent", "Interested", "Declined", "NoResponse"]),
    ));
  const sender = extractEmail(options.message.from);
  const references = referencedMessageIds(options.message);
  const normalizedSubject = normalizeSubject(options.message.subject);

  const candidates = rows.filter(({ outreach, lawyerEmail }) => {
    const metadata = parseMetadata(outreach.metadata);
    const providerMessageId = normalizeMessageId(metadata.outboundProviderMessageId);
    if (providerMessageId && references.has(providerMessageId)) return true;
    return Boolean(
      sender && sender === extractEmail(String(metadata.outboundRecipient || lawyerEmail || "")) &&
      normalizedSubject && normalizedSubject === normalizeSubject(String(metadata.outboundSubject || "")) &&
      (!outreach.initialContact || options.message.receivedAt >= outreach.initialContact)
    );
  });
  if (!candidates.length) return { status: "unmatched" };
  if (candidates.length > 1) return { status: "ambiguous" };

  const { outreach } = candidates[0];
  const metadata = parseMetadata(outreach.metadata);
  const inboundMessageIds = Array.isArray(metadata.inboundGmailMessageIds)
    ? metadata.inboundGmailMessageIds.map(String)
    : [];
  if (inboundMessageIds.includes(options.message.gmailMessageId)) {
    return { status: "duplicate", outreachId: outreach.id };
  }

  const firstContact = outreach.initialContact ?? outreach.lastContact ?? outreach.createdAt;
  const responseTimeHours = firstContact
    ? Math.max(0, (options.message.receivedAt.getTime() - firstContact.getTime()) / 3_600_000).toFixed(2)
    : null;
  db.transaction((tx: any) => {
    const mutation = tx.update(outreachStatus).set({
      responseReceived: "Yes",
      response: outreach.response || options.message.body.trim().slice(0, 5_000) || null,
      responseTimeHours,
      lastContact: options.message.receivedAt,
      metadata: JSON.stringify({
        ...metadata,
        inboundGmailMessageIds: [...inboundMessageIds, options.message.gmailMessageId],
        inboundGmailThreadId: options.message.gmailThreadId ?? metadata.inboundGmailThreadId ?? null,
        latestInboundMessageId: options.message.messageId ?? null,
        latestInboundAt: options.message.receivedAt.toISOString(),
        responseNeedsClassification: !["Interested", "Declined"].includes(String(outreach.status)),
      }),
      updatedAt: new Date(),
    }).where(and(
      eq(outreachStatus.id, outreach.id),
      outreach.metadata == null
        ? isNull(outreachStatus.metadata)
        : eq(outreachStatus.metadata, outreach.metadata),
    )).run();
    if (Number(mutation.changes || 0) !== 1) {
      throw new Error("The outreach reply target changed before it could be linked");
    }
    writeAuditLogOrThrow(tx, {
      userId: options.userId,
      action: AUDIT_ACTIONS.EMAIL_RESPONSE_RECEIVED,
      entityType: "outreach",
      entityId: outreach.id,
      details: {
        caseId: options.caseId,
        gmailMessageId: options.message.gmailMessageId,
        gmailThreadId: options.message.gmailThreadId ?? null,
        classification: ["Interested", "Declined"].includes(String(outreach.status)) ? outreach.status : "needs_review",
      },
    });
  });
  await createNotification({
    userId: options.userId,
    title: "New outreach reply",
    body: `A reply to ${options.message.subject || "an outreach message"} was linked to its case and is ready for review.`,
  });
  return { status: "linked", outreachId: outreach.id };
}
