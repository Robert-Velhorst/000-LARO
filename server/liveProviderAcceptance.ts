import { and, eq, inArray } from "drizzle-orm";
import { AUDIT_ACTIONS } from "./audit";
import { ENV } from "./_core/env";
import { getDb } from "./db";
import { decryptToken } from "./emailOAuth";
import { listGoogleDriveFolders } from "./googleDriveService";
import { testGmailConnection } from "./gmailService";
import {
  auditLogs,
  cases,
  emailAccounts,
  evidence,
  outreachStatus,
  systemConfig,
} from "./schema";
import { verifyOutboundEmailConnection } from "./systemEmail";

const GOOGLE_REQUIREMENTS = [
  "credentials",
  "oauthConsent",
  "gmailRead",
  "driveRead",
  "evidencePersisted",
  "sourceLinkOpened",
  "disconnectRevoked",
] as const;

const OUTBOUND_REQUIREMENTS = [
  "credentials",
  "approvedSend",
  "singleDelivery",
  "auditRecorded",
  "duplicateBlocked",
] as const;

type CheckResult = { passed: boolean; evidence: string[] };
type ProviderResult = {
  status: "passed" | "pending";
  checks: Record<string, CheckResult>;
};

export interface LiveProviderAcceptanceDependencies {
  listDriveFolders: typeof listGoogleDriveFolders;
  testGmail: typeof testGmailConnection;
  verifyOutbound: typeof verifyOutboundEmailConnection;
  targetUserId?: string;
  targetGoogleAccountId?: string;
}

const DEFAULT_DEPENDENCIES: LiveProviderAcceptanceDependencies = {
  listDriveFolders: listGoogleDriveFolders,
  testGmail: testGmailConnection,
  verifyOutbound: verifyOutboundEmailConnection,
};

function check(passed: boolean, ...evidenceRefs: Array<string | false | null>): CheckResult {
  return {
    passed,
    evidence: evidenceRefs.filter((entry): entry is string => Boolean(entry)),
  };
}

function providerResult(
  requirements: readonly string[],
  checks: Record<string, CheckResult>,
): ProviderResult {
  return {
    status: requirements.every((requirement) => checks[requirement]?.passed) ? "passed" : "pending",
    checks,
  };
}

function parsedAuditDetails(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function collectLiveProviderAcceptance(
  dependencies: LiveProviderAcceptanceDependencies = DEFAULT_DEPENDENCIES,
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const googleAccountFilter = dependencies.targetGoogleAccountId
    ? dependencies.targetUserId
      ? and(
        eq(emailAccounts.provider, "gmail"),
        eq(emailAccounts.id, dependencies.targetGoogleAccountId),
        eq(emailAccounts.userId, dependencies.targetUserId),
      )
      : and(
        eq(emailAccounts.provider, "gmail"),
        eq(emailAccounts.id, dependencies.targetGoogleAccountId),
      )
    : dependencies.targetUserId
      ? and(
        eq(emailAccounts.provider, "gmail"),
        eq(emailAccounts.userId, dependencies.targetUserId),
      )
      : eq(emailAccounts.provider, "gmail");
  const googleAccounts = await db
    .select()
    .from(emailAccounts)
    .where(googleAccountFilter)
    .limit(2);
  const googleAccount = googleAccounts.length === 1 ? googleAccounts[0] : undefined;

  let oauthTokensDecryptable = false;
  if (googleAccount?.accessToken && googleAccount.refreshToken) {
    try {
      oauthTokensDecryptable = Boolean(
        decryptToken(googleAccount.accessToken) && decryptToken(googleAccount.refreshToken),
      );
    } catch {
      oauthTokensDecryptable = false;
    }
  }

  let driveRead = false;
  let driveRootFolderCount = 0;
  if (googleAccount?.userId) {
    try {
      const folders = await dependencies.listDriveFolders(googleAccount.userId);
      driveRootFolderCount = folders.length;
      driveRead = true;
    } catch {
      driveRead = false;
    }
  }

  let gmailRead = false;
  if (googleAccount?.id) {
    try {
      const [freshAccount] = await db
        .select({ accessToken: emailAccounts.accessToken })
        .from(emailAccounts)
        .where(eq(emailAccounts.id, googleAccount.id))
        .limit(1);
      if (freshAccount?.accessToken) {
        gmailRead = (await dependencies.testGmail(decryptToken(freshAccount.accessToken))).ok;
      }
    } catch {
      gmailRead = false;
    }
  }

  const googleEvidenceRows = googleAccount?.userId
    ? await db
      .select({ id: evidence.id })
      .from(evidence)
      .where(and(
        eq(evidence.userId, googleAccount.userId),
        inArray(evidence.source, ["gmail", "google_drive"]),
      ))
    : [];
  const googleEvidenceIds = new Set(googleEvidenceRows.map((row) => row.id));

  const ownerAudits = googleAccount?.userId
    ? await db
      .select({ action: auditLogs.action, entityId: auditLogs.entityId, details: auditLogs.details })
      .from(auditLogs)
      .where(eq(auditLogs.userId, googleAccount.userId))
    : [];
  const auditCount = (action: string) => ownerAudits.filter((entry) => entry.action === action).length;
  const googleSourceOpenAudits = ownerAudits.filter((entry) =>
    entry.action === AUDIT_ACTIONS.EVIDENCE_SOURCE_OPENED &&
    Boolean(entry.entityId && googleEvidenceIds.has(entry.entityId)),
  );

  const googleChecks = {
    credentials: check(
      Boolean(
        ENV.GOOGLE_CLIENT_ID &&
        ENV.GOOGLE_CLIENT_SECRET &&
        googleAccount?.status === "connected" &&
        oauthTokensDecryptable,
      ),
      ENV.GOOGLE_CLIENT_ID && ENV.GOOGLE_CLIENT_SECRET ? "runtime:google-client-configured" : false,
      googleAccount?.status === "connected" ? "database:google-account-connected" : false,
      oauthTokensDecryptable ? "database:google-token-vault-decryptable" : false,
    ),
    oauthConsent: check(
      auditCount(AUDIT_ACTIONS.PROVIDER_CONNECTED) > 0 && Boolean(googleAccount?.refreshToken),
      auditCount(AUDIT_ACTIONS.PROVIDER_CONNECTED) > 0 ? "audit:provider.connected" : false,
      googleAccount?.refreshToken ? "database:google-refresh-grant-stored" : false,
    ),
    gmailRead: check(gmailRead, gmailRead ? "google-api:gmail-profile-read" : false),
    driveRead: check(
      driveRead,
      driveRead ? `google-api:drive-root-read:folders=${driveRootFolderCount}` : false,
    ),
    evidencePersisted: check(
      googleEvidenceRows.length > 0,
      googleEvidenceRows.length > 0
        ? `database:google-evidence-count=${googleEvidenceRows.length}`
        : false,
    ),
    sourceLinkOpened: check(
      googleSourceOpenAudits.length > 0,
      googleSourceOpenAudits.length > 0
        ? `audit:google-evidence.source_opened:count=${googleSourceOpenAudits.length}`
        : false,
    ),
    disconnectRevoked: check(
      auditCount(AUDIT_ACTIONS.PROVIDER_DISCONNECT_REVOKED) > 0,
      auditCount(AUDIT_ACTIONS.PROVIDER_DISCONNECT_REVOKED) > 0
        ? `audit:provider.disconnect_revoked:count=${auditCount(AUDIT_ACTIONS.PROVIDER_DISCONNECT_REVOKED)}`
        : false,
    ),
  };

  let outboundConnection: Awaited<ReturnType<typeof verifyOutboundEmailConnection>> = {
    ok: false,
    provider: "unconfigured",
  };
  try {
    outboundConnection = await dependencies.verifyOutbound();
  } catch {
    outboundConnection = { ok: false, provider: "unconfigured" };
  }

  const ownerOutreachRows = googleAccount?.userId
    ? await db
      .select({ id: outreachStatus.id })
      .from(outreachStatus)
      .innerJoin(cases, eq(outreachStatus.caseId, cases.id))
      .where(eq(cases.userId, googleAccount.userId))
    : [];
  const ownerOutreachIds = new Set(ownerOutreachRows.map((row) => row.id));
  const sentAudits = ownerAudits.filter((entry) => {
    if (entry.action !== AUDIT_ACTIONS.OUTREACH_STATUS_CHANGED || !entry.entityId) return false;
    const details = parsedAuditDetails(entry.details);
    return details.from === "Approved" && details.to === "Sent";
  });
  const sentIds = new Set(sentAudits.flatMap((entry) => entry.entityId ? [entry.entityId] : []));
  const sentAuditCountById = new Map<string, number>();
  for (const entry of sentAudits) {
    if (!entry.entityId) continue;
    sentAuditCountById.set(entry.entityId, (sentAuditCountById.get(entry.entityId) || 0) + 1);
  }
  const sentGuards = (await db
    .select({ key: systemConfig.configKey, value: systemConfig.configValue })
    .from(systemConfig))
    .filter((entry) => entry.key.startsWith("sent:"));
  const guardByOutreachId = new Map(
    sentGuards.map((entry) => [entry.key.slice("sent:".length), entry.value]),
  );
  const liveDeliveryProven = sentIds.size > 0 && [...sentIds].every((id) =>
    ownerOutreachIds.has(id) &&
    sentAuditCountById.get(id) === 1 &&
    ["sent", "true"].includes(guardByOutreachId.get(id) || ""),
  );

  const outboundChecks = {
    credentials: check(
      outboundConnection.ok,
      outboundConnection.ok ? `provider:${outboundConnection.provider}:authenticated-connection` : false,
    ),
    approvedSend: check(
      sentAudits.length > 0,
      sentAudits.length > 0 ? `audit:approved-outreach-send:count=${sentAudits.length}` : false,
    ),
    singleDelivery: check(
      liveDeliveryProven,
      liveDeliveryProven ? `database:single-finalized-delivery:count=${sentIds.size}` : false,
    ),
    auditRecorded: check(
      sentAudits.length > 0,
      sentAudits.length > 0 ? `audit:outreach.status_changed:sent=${sentAudits.length}` : false,
    ),
    duplicateBlocked: check(
      liveDeliveryProven,
      liveDeliveryProven ? "database:atomic-outreach-dispatch-guards" : false,
    ),
  };

  const providers = {
    google: providerResult(GOOGLE_REQUIREMENTS, googleChecks),
    outboundEmail: providerResult(OUTBOUND_REQUIREMENTS, outboundChecks),
  };
  const pendingChecks = Object.entries(providers).flatMap(([provider, result]) =>
    Object.entries(result.checks)
      .filter(([, outcome]) => !outcome.passed)
      .map(([name]) => `${provider}.${name}`),
  );

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: ENV.SERVER_ONLY ? "api-only" : "desktop",
    nonDestructive: true,
    sendsMessages: false,
    modifiesAcceptanceRecord: false,
    providers,
    summary: {
      status: pendingChecks.length === 0 ? "passed" : "pending",
      pendingChecks,
    },
  };
}

if (require.main === module) {
  const option = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index >= 0) return process.argv[index + 1];
    return process.argv.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
  };
  collectLiveProviderAcceptance({
    ...DEFAULT_DEPENDENCIES,
    targetUserId: option("--user-id"),
    targetGoogleAccountId: option("--google-account-id"),
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
