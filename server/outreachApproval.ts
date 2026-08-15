import crypto from "crypto";
import { LEGAL_DISCLAIMER } from "../shared/const";

export interface OutreachMessagePayload {
  to: string;
  subject: string;
  text: string;
  disclaimer: string;
  approvalHash: string;
}

export interface ApprovedOutreachMessage extends OutreachMessagePayload {
  approvedBy: string;
  approvedAt: string;
}

interface ApproveOutreachMessageInput {
  outreachId: string;
  caseId: string;
  to: string;
  subject: string;
  text: string;
  disclaimer?: string;
  approvedBy: string;
  approvedAt: string;
}

interface BuildOutreachMessageInput {
  outreachId: string;
  caseId: string;
  caseType?: string | null;
  lawyerName?: string | null;
  lawyerEmail?: string | null;
}

function canonicalMessage(input: Omit<BuildOutreachMessageInput, "lawyerName" | "lawyerEmail" | "caseType"> & {
  to: string;
  subject: string;
  text: string;
  disclaimer: string;
}): string {
  return JSON.stringify({
    outreachId: input.outreachId,
    caseId: input.caseId,
    to: input.to,
    subject: input.subject,
    text: input.text,
    disclaimer: input.disclaimer,
  });
}

function hashMessage(input: Parameters<typeof canonicalMessage>[0]): string {
  return crypto.createHash("sha256").update(canonicalMessage(input), "utf8").digest("hex");
}

export function buildOutreachMessage(input: BuildOutreachMessageInput): OutreachMessagePayload {
  const to = input.lawyerEmail?.trim();
  if (!to) throw new Error("Matched lawyer has no email address; cannot approve or send this draft.");
  const caseType = input.caseType?.trim() || "legal";
  const lawyerName = input.lawyerName?.trim() || "there";
  const subject = `Legal assistance enquiry - ${caseType}`;
  const text = [
    `Hello ${lawyerName},`,
    "",
    `A prospective client is seeking assistance with a ${caseType} matter. They would like to know if you are able to help.`,
    "",
    "Sent via LARO after explicit user approval.",
    "",
    "---",
    LEGAL_DISCLAIMER,
  ].join("\n");
  const hashInput = {
    outreachId: input.outreachId,
    caseId: input.caseId,
    to,
    subject,
    text,
    disclaimer: LEGAL_DISCLAIMER,
  };
  return { to, subject, text, disclaimer: LEGAL_DISCLAIMER, approvalHash: hashMessage(hashInput) };
}

export function approveOutreachMessage(input: ApproveOutreachMessageInput): ApprovedOutreachMessage {
  const disclaimer = input.disclaimer ?? LEGAL_DISCLAIMER;
  const hashInput = {
    outreachId: input.outreachId,
    caseId: input.caseId,
    to: input.to,
    subject: input.subject,
    text: input.text,
    disclaimer,
  };
  return {
    to: input.to,
    subject: input.subject,
    text: input.text,
    disclaimer,
    approvalHash: hashMessage(hashInput),
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt,
  };
}

export function readOutreachMetadata(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function readApprovedOutreachMessage(
  raw: string | null,
  outreachId: string,
  caseId: string,
): ApprovedOutreachMessage | null {
  const value = readOutreachMetadata(raw).approvedMessage;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const required = ["to", "subject", "text", "disclaimer", "approvalHash", "approvedBy", "approvedAt"] as const;
  if (required.some((key) => typeof candidate[key] !== "string" || !(candidate[key] as string).trim())) return null;
  const expectedHash = hashMessage({
    outreachId,
    caseId,
    to: candidate.to as string,
    subject: candidate.subject as string,
    text: candidate.text as string,
    disclaimer: candidate.disclaimer as string,
  });
  if (candidate.approvalHash !== expectedHash) return null;
  return candidate as unknown as ApprovedOutreachMessage;
}
