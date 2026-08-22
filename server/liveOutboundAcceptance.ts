import { createHash } from "crypto";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { AUDIT_ACTIONS } from "./audit";
import { getDb } from "./db";
import { decryptToken } from "./emailOAuth";
import { getFlag, setFlag } from "./featureFlags";
import { listGoogleDriveFolders } from "./googleDriveService";
import {
  sendApprovedOutreach,
  type ApprovedOutreachMessageOverride,
  type SendResult,
} from "./outreachSend";
import {
  hashAcceptanceRecipient,
  readOutboundAcceptanceReceipt,
  recordOutboundAcceptanceReceipt,
} from "./providerAcceptanceEvidence";
import {
  auditLogs,
  cases,
  emailAccounts,
  lawyers,
  outreachStatus,
  systemConfig,
  users,
} from "./schema";
import { assertNotEmergencyStopped } from "./systemState";
import { verifyOutboundEmailConnection } from "./systemEmail";
import { approveOutreachMessage, readOutreachMetadata } from "./outreachApproval";
import { LEGAL_DISCLAIMER } from "../shared/const";

interface AcceptanceOptions {
  userId: string;
  googleAccountId: string;
  recipient: string;
  confirmedRecipient: string;
  runId: string;
}

interface AcceptanceDependencies {
  sendApproved: (
    userId: string,
    outreachId: string,
    message: ApprovedOutreachMessageOverride,
  ) => Promise<SendResult>;
  getFreshAccessToken: (userId: string, accountId: string) => Promise<string>;
  countInboxMessages: (accessToken: string, subject: string, recipient: string) => Promise<number>;
  verifyOutbound: typeof verifyOutboundEmailConnection;
  recordReceipt: typeof recordOutboundAcceptanceReceipt;
  sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_DEPENDENCIES: AcceptanceDependencies = {
  sendApproved: (userId, outreachId, message) => sendApprovedOutreach(
    userId,
    outreachId,
    undefined,
    message,
  ),
  getFreshAccessToken: getFreshGoogleAccessToken,
  countInboxMessages: countGmailInboxMessages,
  verifyOutbound: verifyOutboundEmailConnection,
  recordReceipt: recordOutboundAcceptanceReceipt,
  sleep: (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
};

function acceptanceIds(options: AcceptanceOptions) {
  const suffix = createHash("sha256")
    .update(`${options.userId}\n${options.googleAccountId}\n${options.runId}`)
    .digest("hex")
    .slice(0, 24);
  return {
    caseId: `ACCEPTANCE_CASE_${suffix}`,
    lawyerId: `ACCEPTANCE_RECIPIENT_${suffix}`,
    outreachId: `ACCEPTANCE_OUTREACH_${suffix}`,
  };
}

export function outboundAcceptanceSubject(options: {
  userId: string;
  googleAccountId: string;
  runId: string;
}): string {
  const marker = acceptanceIds({
    ...options,
    recipient: "",
    confirmedRecipient: "",
  }).outreachId.slice(-12);
  return `LARO production delivery acceptance ${marker}`;
}

function cleanupTransientAcceptanceRows(
  db: Awaited<ReturnType<typeof getDb>>,
  ids: ReturnType<typeof acceptanceIds>,
): void {
  if (!db) throw new Error("Database not available");
  db.transaction((tx: any) => {
    tx.delete(auditLogs).where(eq(auditLogs.entityId, ids.outreachId)).run();
    tx.delete(systemConfig).where(eq(systemConfig.configKey, `sent:${ids.outreachId}`)).run();
    tx.delete(outreachStatus).where(eq(outreachStatus.id, ids.outreachId)).run();
    tx.delete(cases).where(eq(cases.id, ids.caseId)).run();
    tx.delete(lawyers).where(eq(lawyers.id, ids.lawyerId)).run();
  });
}

function validateOptions(options: AcceptanceOptions): void {
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(options.runId)) {
    throw new Error("runId must contain 8-80 letters, numbers, dots, underscores, or hyphens");
  }
  const recipient = options.recipient.trim().toLowerCase();
  if (!recipient || recipient !== options.confirmedRecipient.trim().toLowerCase()) {
    throw new Error("The explicit recipient confirmation does not match the requested recipient");
  }
}

async function getFreshGoogleAccessToken(userId: string, accountId: string): Promise<string> {
  // The Drive client refreshes and persists an expired shared Google OAuth grant.
  await listGoogleDriveFolders(userId, undefined, accountId);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [account] = await db.select({ accessToken: emailAccounts.accessToken })
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)))
    .limit(1);
  if (!account?.accessToken) throw new Error("Selected Google account has no access token");
  return decryptToken(account.accessToken);
}

async function countGmailInboxMessages(
  accessToken: string,
  subject: string,
  recipient: string,
): Promise<number> {
  const params = new URLSearchParams({
    maxResults: "10",
    q: `subject:"${subject}" newer_than:2d`,
  });
  const listResponse = await fetch(
    `https://www.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const listData = await listResponse.json() as {
    error?: { message?: string };
    messages?: Array<{ id: string }>;
  };
  if (!listResponse.ok || listData.error) {
    throw new Error(`Gmail receipt search failed: ${listData.error?.message || listResponse.status}`);
  }

  let count = 0;
  for (const message of listData.messages || []) {
    const detailResponse = await fetch(
      `https://www.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=To`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const detail = await detailResponse.json() as {
      error?: { message?: string };
      labelIds?: string[];
      payload?: { headers?: Array<{ name: string; value: string }> };
    };
    if (!detailResponse.ok || detail.error) {
      throw new Error(`Gmail receipt detail failed: ${detail.error?.message || detailResponse.status}`);
    }
    const headers = new Map((detail.payload?.headers || []).map((header) => [header.name.toLowerCase(), header.value]));
    const to = headers.get("to")?.toLowerCase() || "";
    if (detail.labelIds?.includes("INBOX") && to.includes(recipient.trim().toLowerCase())) count += 1;
  }
  return count;
}

async function pollForSingleInboxMessage(
  dependencies: AcceptanceDependencies,
  accessToken: string,
  subject: string,
  recipient: string,
): Promise<number> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const count = await dependencies.countInboxMessages(accessToken, subject, recipient);
    if (count === 1) return count;
    if (count > 1) throw new Error(`Expected one acceptance message in Gmail, found ${count}`);
    await dependencies.sleep(5_000);
  }
  throw new Error("The acceptance message was not observed in the Gmail inbox within 60 seconds");
}

export async function runLiveOutboundAcceptance(
  options: AcceptanceOptions,
  dependencies: AcceptanceDependencies = DEFAULT_DEPENDENCIES,
) {
  validateOptions(options);
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await assertNotEmergencyStopped();

  const recipient = options.recipient.trim().toLowerCase();
  const ids = acceptanceIds(options);
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, options.userId)).limit(1);
  if (!user) throw new Error("Target owner was not found");
  const [googleAccount] = await db.select().from(emailAccounts).where(and(
    eq(emailAccounts.id, options.googleAccountId),
    eq(emailAccounts.userId, options.userId),
    eq(emailAccounts.provider, "gmail"),
  )).limit(1);
  if (!googleAccount || googleAccount.status !== "connected") {
    throw new Error("Target Google account is not connected to the selected owner");
  }
  if ((googleAccount.email || "").trim().toLowerCase() !== recipient) {
    throw new Error("Live acceptance only sends to the selected owner's connected Google account");
  }
  const outboundConnection = await dependencies.verifyOutbound();
  if (!outboundConnection.ok || outboundConnection.provider === "unconfigured") {
    throw new Error("The outbound email provider is not configured or did not authenticate");
  }

  const existingReceipt = await readOutboundAcceptanceReceipt(options.userId);
  if (existingReceipt && existingReceipt.provider === outboundConnection.provider) {
    if (existingReceipt.recipientHash !== hashAcceptanceRecipient(recipient)) {
      throw new Error("A valid outbound receipt exists for a different recipient");
    }
    cleanupTransientAcceptanceRows(db, acceptanceIds({ ...options, runId: existingReceipt.runId }));
    return {
      status: "passed" as const,
      alreadyAccepted: true,
      provider: existingReceipt.provider,
      verifiedAt: existingReceipt.verifiedAt,
      runId: existingReceipt.runId,
    };
  }

  const marker = ids.outreachId.slice(-12);
  const caseType = `LARO provider acceptance ${marker}`;
  const subject = outboundAcceptanceSubject(options);
  const acceptanceMessage: ApprovedOutreachMessageOverride = {
    subject,
    text:
      `This is an authorized LARO production delivery test sent to the account owner.\n\n` +
      `No legal matter or third party is involved.\n` +
      `Acceptance run: ${options.runId}`,
  };
  const metadata = JSON.stringify({ kind: "provider_acceptance", runId: options.runId });
  const [rawFlag] = await db.select().from(systemConfig)
    .where(eq(systemConfig.configKey, "flag:outreach.send.enabled"))
    .limit(1);

  const accessToken = await dependencies.getFreshAccessToken(options.userId, options.googleAccountId);
  const [existingOutreach] = await db.select().from(outreachStatus)
    .where(eq(outreachStatus.id, ids.outreachId))
    .limit(1);
  const inboxBefore = await dependencies.countInboxMessages(accessToken, subject, recipient);
  if (inboxBefore > 0 && existingOutreach?.status !== "Sent") {
    throw new Error("An acceptance message already exists without a finalized local dispatch; use a new runId after review");
  }

  await db.insert(cases).values({
    id: ids.caseId,
    userId: options.userId,
    clientName: "LARO provider acceptance",
    clientEmail: recipient,
    caseType,
    caseSummary: "Controlled production provider acceptance; not a legal matter.",
    legalAreas: JSON.stringify(["Other"]),
    status: "active",
    metadata,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  await db.insert(lawyers).values({
    id: ids.lawyerId,
    name: "LARO owner acceptance recipient",
    email: recipient,
    legalAreas: JSON.stringify(["Other"]),
    directorySource: "provider_acceptance",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
  const [preparedCase] = await db.select().from(cases).where(eq(cases.id, ids.caseId)).limit(1);
  const [preparedLawyer] = await db.select().from(lawyers).where(eq(lawyers.id, ids.lawyerId)).limit(1);
  if (
    !preparedCase ||
    preparedCase.userId !== options.userId ||
    preparedCase.metadata !== metadata ||
    !preparedLawyer ||
    (preparedLawyer.email || "").trim().toLowerCase() !== recipient ||
    preparedLawyer.directorySource !== "provider_acceptance"
  ) {
    throw new Error("Acceptance record collision detected; no message was sent");
  }
  await db.insert(outreachStatus).values({
    id: ids.outreachId,
    caseId: ids.caseId,
    lawyerId: ids.lawyerId,
    status: "PendingApproval",
    metadata,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();

  const [prepared] = await db.select().from(outreachStatus).where(eq(outreachStatus.id, ids.outreachId)).limit(1);
  const preparedMetadata = readOutreachMetadata(prepared?.metadata ?? null);
  if (
    !prepared ||
    prepared.caseId !== ids.caseId ||
    prepared.lawyerId !== ids.lawyerId ||
    preparedMetadata.kind !== "provider_acceptance" ||
    preparedMetadata.runId !== options.runId
  ) {
    throw new Error("Acceptance record collision detected; no message was sent");
  }
  if (prepared.status === "PendingApproval") {
    const approvedAt = new Date();
    const approvedMessage = approveOutreachMessage({
      outreachId: ids.outreachId,
      caseId: ids.caseId,
      to: recipient,
      subject: acceptanceMessage.subject,
      text: acceptanceMessage.text,
      disclaimer: LEGAL_DISCLAIMER,
      approvedBy: options.userId,
      approvedAt: approvedAt.toISOString(),
    });
    db.transaction((tx: any) => {
      const status = tx.update(outreachStatus).set({
        status: "Approved",
        metadata: JSON.stringify({ ...preparedMetadata, approvedMessage }),
        updatedAt: approvedAt,
      }).where(and(
        eq(outreachStatus.id, ids.outreachId),
        eq(outreachStatus.status, "PendingApproval"),
      )).run();
      if (Number(status.changes || 0) !== 1) throw new Error("Acceptance draft changed before approval");
      tx.insert(auditLogs).values({
        id: nanoid(),
        userId: options.userId,
        action: AUDIT_ACTIONS.OUTREACH_STATUS_CHANGED,
        entityType: "outreach",
        entityId: ids.outreachId,
        details: JSON.stringify({ from: "PendingApproval", to: "Approved", acceptanceRun: options.runId }),
        createdAt: approvedAt,
      }).run();
    });
  } else if (!["Approved", "Dispatching", "Sent"].includes(prepared.status || "")) {
    throw new Error(`Acceptance outreach is in unexpected state ${prepared.status || "unknown"}`);
  }

  try {
    await setFlag("outreach.send.enabled", true);
    if (!(await getFlag("outreach.send.enabled"))) {
      throw new Error("outreach.send.enabled is overridden off; no message was sent");
    }

    const first = await dependencies.sendApproved(options.userId, ids.outreachId, acceptanceMessage);
    if (
      !first.sent ||
      first.alreadySent ||
      first.provider !== outboundConnection.provider
    ) {
      throw new Error("The first acceptance dispatch was not a new SMTP/SendGrid delivery");
    }
    const firstCount = await pollForSingleInboxMessage(dependencies, accessToken, subject, recipient);
    const duplicate = await dependencies.sendApproved(options.userId, ids.outreachId, acceptanceMessage);
    if (!duplicate.alreadySent) throw new Error("The duplicate acceptance dispatch was not blocked");
    await dependencies.sleep(3_000);
    const finalCount = await dependencies.countInboxMessages(accessToken, subject, recipient);
    if (firstCount !== 1 || finalCount !== 1) {
      throw new Error(`Duplicate-delivery check failed; Gmail inbox count is ${finalCount}`);
    }

    const sentAudits = (await db.select().from(auditLogs).where(and(
      eq(auditLogs.userId, options.userId),
      eq(auditLogs.entityId, ids.outreachId),
      eq(auditLogs.action, AUDIT_ACTIONS.OUTREACH_STATUS_CHANGED),
    ))).filter((entry) => {
      try {
        const details = JSON.parse(entry.details || "{}");
        return details.from === "Dispatching" && details.to === "Sent";
      } catch {
        return false;
      }
    });
    if (sentAudits.length !== 1) {
      throw new Error(`Expected one sent audit, found ${sentAudits.length}`);
    }

    const receipt = await dependencies.recordReceipt({
      userId: options.userId,
      runId: options.runId,
      provider: first.provider as "smtp" | "sendgrid",
      recipient,
    });

    cleanupTransientAcceptanceRows(db, ids);

    return {
      status: "passed" as const,
      alreadyAccepted: false,
      provider: receipt.provider,
      providerMessageId: first.providerMessageId || null,
      verifiedAt: receipt.verifiedAt,
      runId: receipt.runId,
      inboxMessageCount: 1,
      duplicateBlocked: true,
      transientBusinessRowsRemoved: true,
    };
  } finally {
    if (rawFlag) {
      await db.insert(systemConfig).values({
        configKey: rawFlag.configKey,
        configValue: rawFlag.configValue,
        updatedAt: rawFlag.updatedAt ?? new Date(),
      }).onConflictDoUpdate({
        target: systemConfig.configKey,
        set: { configValue: rawFlag.configValue, updatedAt: rawFlag.updatedAt ?? new Date() },
      });
    } else {
      await db.delete(systemConfig).where(eq(systemConfig.configKey, "flag:outreach.send.enabled"));
    }
  }
}

if (require.main === module) {
  const option = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index >= 0) return process.argv[index + 1];
    return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  const userId = option("--user-id");
  const googleAccountId = option("--google-account-id");
  const recipient = option("--recipient");
  const confirmedRecipient = option("--confirm-send-to");
  const runId = option("--run-id");
  if (!userId || !googleAccountId || !recipient || !confirmedRecipient || !runId) {
    console.error("Required: --user-id, --google-account-id, --recipient, --confirm-send-to, and --run-id");
    process.exitCode = 2;
  } else {
    runLiveOutboundAcceptance({ userId, googleAccountId, recipient, confirmedRecipient, runId })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
