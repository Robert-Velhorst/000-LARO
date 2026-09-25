import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { AUDIT_ACTIONS, createAuditLog, writeAuditLogOrThrow } from "./audit";
import { ENV } from "./_core/env";
import { readBoundedResponseJson, withBoundedHttpResponse } from "./boundedHttpResponse";
import { getDb } from "./db";
import { decryptToken, encryptToken } from "./emailOAuth";
import {
  beginOAuthFlowAsync,
  consumeOAuthStateAsync,
  exchangeCodeForTokens,
  getAccountInfo,
  getOAuth2Config,
  isRetryableOAuthNetworkError,
  type EmailAccountInfo,
  type OAuth2Tokens,
} from "./oauth2";
import { autoCollectionSettings, cases, emailAccounts, evidenceSources } from "./schema";

export type OAuthProvider = "gmail" | "outlook";
export type ProviderConnectionStatus = "connected" | "reconnect_required";
export type ProviderConnectionErrorCode =
  | "not_found"
  | "not_connected"
  | "reconnect_required"
  | "provider_unavailable"
  | "transient_provider_failure"
  | "provider_configuration_failure"
  | "refresh_uncertain"
  | "impact_changed"
  | "upstream_revocation_failed";

export class ProviderConnectionError extends Error {
  constructor(
    public readonly code: ProviderConnectionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderConnectionError";
  }
}

export class ProviderCallbackError extends Error {
  constructor(
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super("The provider connection could not be completed", options);
    this.name = "ProviderCallbackError";
  }
}

export interface PublicProviderConnection {
  id: string;
  provider: OAuthProvider;
  email: string;
  displayName: string | null;
  status: string | null;
  connectedAt: Date | null;
  tokenExpiry: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
}

type StoredProviderConnection = typeof emailAccounts.$inferSelect;
type RevocationOutcome = "revoked" | "already_invalid" | "not_applicable";
export type GoogleDisconnectInitiator = "shared_google_grant" | "gmail" | "google_drive";
export type GoogleDisconnectCapability = "gmail" | "google_drive";

export interface GoogleDisconnectImpact {
  contractVersion: "google-disconnect-impact-v1";
  impactRevision: string;
  account: { id: string; email: string; status: string | null };
  credential: {
    provider: "google";
    kind: "shared_oauth_grant";
    stored: boolean;
    willRevoke: boolean;
    localConnectionWillRemove: true;
  };
  capabilities: Array<{
    id: GoogleDisconnectCapability;
    label: string;
    willRemove: true;
  }>;
  scheduledCollections: Array<{
    settingsId: string;
    caseId: string | null;
    caseLabel: string;
    enabled: boolean;
    capabilities: GoogleDisconnectCapability[];
  }>;
  localSourceRecords: Array<{
    sourceType: string;
    count: number;
    willRemove: boolean;
  }>;
  remainingGoogleAccountsAfter: number;
  collectedDocumentsWillRemain: true;
}

interface ScheduledCollectionRewrite {
  emailAccountIds: string;
  metadata: string;
  googleDriveFolderIds: string | null;
  autoDownloadAttachments: boolean;
  autoDownloadGoogleDriveFiles: boolean;
  updatedAt: Date;
}

const PROVIDER_TIMEOUT_MS = 20_000;
const PROVIDER_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_EXPIRY_SECONDS = 3_600;
const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
const DEFAULT_REFRESH_WINDOW_MS = 60_000;
const refreshFlights = new Map<string, Promise<string>>();
const GOOGLE_SOURCE_TYPES = ["Gmail", "GoogleDrive", "gmail", "google_drive"] as const;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
      : [];
  } catch {
    return [];
  }
}

function providerAuditName(provider: OAuthProvider): "google" | "microsoft" {
  return provider === "gmail" ? "google" : "microsoft";
}

function normalizeExpirySeconds(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_EXPIRY_SECONDS;
  return Math.min(MAX_EXPIRY_SECONDS, Math.max(MIN_EXPIRY_SECONDS, Math.floor(parsed)));
}

function expiryDate(expiresIn: unknown, now = Date.now()): Date {
  return new Date(now + normalizeExpirySeconds(expiresIn) * 1_000);
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function driveAccountIds(metadata: Record<string, unknown>): string[] {
  const sources = Array.isArray(metadata.googleDriveSources) ? metadata.googleDriveSources : [];
  const sourceIds = sources.flatMap((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return [];
    const accountId = (source as Record<string, unknown>).accountId;
    return typeof accountId === "string" && accountId.trim() ? [accountId.trim()] : [];
  });
  const legacyId = typeof metadata.googleDriveAccountId === "string"
    ? metadata.googleDriveAccountId.trim()
    : "";
  return [...new Set([...sourceIds, ...(legacyId ? [legacyId] : [])])];
}

function scheduledCapabilities(
  settings: typeof autoCollectionSettings.$inferSelect,
  accountId: string,
  isOnlyGoogleAccount: boolean,
): GoogleDisconnectCapability[] {
  const capabilities: GoogleDisconnectCapability[] = [];
  if (parseStringArray(settings.emailAccountIds).includes(accountId)) capabilities.push("gmail");
  const metadata = parseMetadata(settings.metadata);
  const explicitDriveAccountIds = driveAccountIds(metadata);
  const legacyImplicitDrive = explicitDriveAccountIds.length === 0
    && isOnlyGoogleAccount
    && Boolean(settings.autoDownloadGoogleDriveFiles)
    && parseStringArray(settings.googleDriveFolderIds).length > 0;
  if (explicitDriveAccountIds.includes(accountId) || legacyImplicitDrive) capabilities.push("google_drive");
  return capabilities;
}

function rewriteScheduledCollection(
  settings: typeof autoCollectionSettings.$inferSelect,
  accountId: string,
  isOnlyGoogleAccount: boolean,
): ScheduledCollectionRewrite | null {
  const affected = scheduledCapabilities(settings, accountId, isOnlyGoogleAccount);
  if (affected.length === 0) return null;

  const emailAccountIds = parseStringArray(settings.emailAccountIds).filter((id) => id !== accountId);
  const metadata = parseMetadata(settings.metadata);
  if (Array.isArray(metadata.googleDriveSources)) {
    metadata.googleDriveSources = metadata.googleDriveSources.filter((source) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) return true;
      return (source as Record<string, unknown>).accountId !== accountId;
    });
  }
  if (metadata.googleDriveAccountId === accountId) delete metadata.googleDriveAccountId;

  const remainingDriveIds = driveAccountIds(metadata);
  const removedGmail = affected.includes("gmail");
  const removedDrive = affected.includes("google_drive");
  const removedFinalDriveSelection = removedDrive && remainingDriveIds.length === 0;
  return {
    emailAccountIds: JSON.stringify(emailAccountIds),
    metadata: JSON.stringify(metadata),
    googleDriveFolderIds: removedFinalDriveSelection ? null : settings.googleDriveFolderIds,
    autoDownloadAttachments: removedGmail
      ? emailAccountIds.length > 0 && Boolean(settings.autoDownloadAttachments)
      : Boolean(settings.autoDownloadAttachments),
    autoDownloadGoogleDriveFiles: removedDrive
      ? remainingDriveIds.length > 0 && Boolean(settings.autoDownloadGoogleDriveFiles)
      : Boolean(settings.autoDownloadGoogleDriveFiles),
    updatedAt: new Date(),
  };
}

function publicConnection(row: StoredProviderConnection): PublicProviderConnection {
  return {
    id: row.id,
    provider: row.provider as OAuthProvider,
    email: row.email || "",
    displayName: row.displayName,
    status: row.status,
    connectedAt: row.connectedAt,
    tokenExpiry: row.tokenExpiry,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function providerConnectionAvailability(provider: OAuthProvider): {
  available: boolean;
  reason?: string;
} {
  if (provider === "gmail") {
    const configured = Boolean(
      (ENV.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID) &&
      (ENV.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET),
    );
    return configured
      ? { available: true }
      : { available: false, reason: "Google OAuth is not configured." };
  }
  return {
    available: false,
    reason: "Microsoft evidence collection is not release-capable yet; no account was connected.",
  };
}

export async function beginProviderConnection(
  provider: OAuthProvider,
  userId: string,
  initiatingSessionToken: string,
): Promise<string> {
  const availability = providerConnectionAvailability(provider);
  if (!availability.available) {
    throw new ProviderConnectionError(
      "provider_unavailable",
      availability.reason || "This provider is unavailable.",
    );
  }
  return beginOAuthFlowAsync(provider, userId, initiatingSessionToken);
}

export async function completeProviderConnectionCallback(input: {
  provider: OAuthProvider;
  code: string;
  state: string;
  bindingCookieValue: string;
}): Promise<{ accountId: string; email: string }> {
  const oauthState = await consumeOAuthStateAsync(input.state, input.provider, input.bindingCookieValue);
  let tokens: OAuth2Tokens;
  try {
    tokens = await exchangeCodeForTokens(input.provider, input.code, oauthState.codeVerifier);
  } catch (error) {
    throw new ProviderCallbackError(isRetryableOAuthNetworkError(error), { cause: error });
  }
  try {
    const accountInfo = await getAccountInfo(input.provider, tokens.accessToken);
    if (!accountInfo.email) throw new Error("Provider profile did not include an email address");
    const accountId = await storeProviderConnection(oauthState.userId, input.provider, tokens, accountInfo);
    return { accountId, email: accountInfo.email.trim().toLowerCase() };
  } catch (error) {
    throw new ProviderCallbackError(false, { cause: error });
  }
}

export async function storeProviderConnection(
  userId: string,
  provider: OAuthProvider,
  tokens: OAuth2Tokens,
  accountInfo: EmailAccountInfo,
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const normalizedEmail = accountInfo.email.trim().toLowerCase();
  if (
    !tokens.accessToken.trim() ||
    normalizedEmail.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    throw new Error("Provider connection did not return valid account credentials");
  }

  const now = new Date();
  const normalizedExpiresIn = normalizeExpirySeconds(tokens.expiresIn);
  return db.transaction((tx: any) => {
    const existing = tx.select()
      .from(emailAccounts)
      .where(and(
        eq(emailAccounts.userId, userId),
        eq(emailAccounts.provider, provider),
        sql`lower(trim(${emailAccounts.email})) = ${normalizedEmail}`,
      ))
      .limit(1)
      .get() as StoredProviderConnection | undefined;
    const accountId = existing?.id ?? nanoid();
    const refreshToken = tokens.refreshToken
      ? encryptToken(tokens.refreshToken)
      : existing?.refreshToken ?? null;
    const row = {
      userId,
      provider,
      email: normalizedEmail,
      displayName: accountInfo.displayName || null,
      accessToken: encryptToken(tokens.accessToken),
      refreshToken,
      tokenExpiry: expiryDate(normalizedExpiresIn, now.getTime()),
      status: "connected" satisfies ProviderConnectionStatus,
      connectedAt: now,
      metadata: JSON.stringify({
        ...parseMetadata(existing?.metadata ?? null),
        profilePicture: accountInfo.profilePicture,
        tokenType: tokens.tokenType,
        expiresIn: normalizedExpiresIn,
        tokenReportedScopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [],
      }),
      updatedAt: now,
    };

    if (existing) {
      tx.update(emailAccounts).set(row).where(and(
        eq(emailAccounts.id, existing.id),
        eq(emailAccounts.userId, userId),
      )).run();
    } else {
      tx.insert(emailAccounts).values({ id: accountId, ...row, createdAt: now }).run();
    }
    writeAuditLogOrThrow(tx, {
      userId,
      action: AUDIT_ACTIONS.PROVIDER_CONNECTED,
      entityType: "provider_connection",
      entityId: accountId,
      details: {
        provider: providerAuditName(provider),
        requestedScopes: getOAuth2Config(provider).scopes,
        tokenReportedScopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [],
        refreshGrantStored: Boolean(refreshToken),
      },
    });
    return accountId;
  });
}

export async function listProviderConnections(
  userId: string,
  provider?: OAuthProvider,
): Promise<PublicProviderConnection[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [eq(emailAccounts.userId, userId)];
  if (provider) conditions.push(eq(emailAccounts.provider, provider));
  const rows = await db.select().from(emailAccounts).where(and(...conditions));
  return rows
    .filter((row) => row.provider === "gmail" || row.provider === "outlook")
    .map(publicConnection);
}

export async function getGoogleDisconnectImpact(input: {
  userId: string;
  accountId: string;
}): Promise<GoogleDisconnectImpact> {
  const account = await requireOwnedConnection(input);
  if (account.provider !== "gmail") {
    throw new ProviderConnectionError("not_found", "The selected Google account was not found.");
  }
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [googleAccounts, settingsRows, sourceRows] = await Promise.all([
    db.select({
      id: emailAccounts.id,
      status: emailAccounts.status,
      connectedAt: emailAccounts.connectedAt,
      updatedAt: emailAccounts.updatedAt,
    }).from(emailAccounts).where(and(
      eq(emailAccounts.userId, input.userId),
      eq(emailAccounts.provider, "gmail"),
    )),
    db.select().from(autoCollectionSettings).where(eq(autoCollectionSettings.userId, input.userId)),
    db.select({
      id: evidenceSources.id,
      caseId: evidenceSources.caseId,
      sourceType: evidenceSources.sourceType,
      status: evidenceSources.status,
      connectionStatus: evidenceSources.connectionStatus,
    }).from(evidenceSources).where(and(
      eq(evidenceSources.userId, input.userId),
      inArray(evidenceSources.sourceType, [...GOOGLE_SOURCE_TYPES]),
    )),
  ]);
  const isOnlyGoogleAccount = googleAccounts.length === 1;
  const affectedSettings = settingsRows.flatMap((settings) => {
    const capabilities = scheduledCapabilities(settings, account.id, isOnlyGoogleAccount);
    return capabilities.length > 0 ? [{ settings, capabilities }] : [];
  });
  const scheduledCaseIds = [...new Set(affectedSettings
    .map(({ settings }) => settings.caseId)
    .filter((caseId): caseId is string => Boolean(caseId)))];
  const caseRows = scheduledCaseIds.length > 0
    ? await db.select({ id: cases.id, clientName: cases.clientName, caseType: cases.caseType })
      .from(cases)
      .where(and(eq(cases.userId, input.userId), inArray(cases.id, scheduledCaseIds)))
    : [];
  const caseLabels = new Map(caseRows.map((row) => [
    row.id,
    row.clientName?.trim() || row.caseType?.trim() || row.id,
  ]));
  const scheduledCollections = affectedSettings.map(({ settings, capabilities }) => ({
    settingsId: settings.id,
    caseId: settings.caseId,
    caseLabel: settings.caseId ? caseLabels.get(settings.caseId) || "Unnamed case" : "Not assigned to a case",
    enabled: Boolean(settings.isEnabled),
    capabilities,
  }));
  const sourceCounts = new Map<string, number>();
  for (const source of sourceRows) {
    const sourceType = source.sourceType || "unknown";
    sourceCounts.set(sourceType, (sourceCounts.get(sourceType) || 0) + 1);
  }
  const localSourceRecords = [...sourceCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceType, count]) => ({ sourceType, count, willRemove: isOnlyGoogleAccount }));
  const impactRevision = digest({
    account: {
      id: account.id,
      provider: account.provider,
      email: account.email,
      status: account.status,
      hasStoredAccessToken: Boolean(account.accessToken),
      hasStoredRefreshToken: Boolean(account.refreshToken),
      connectedAt: account.connectedAt?.toISOString() ?? null,
      updatedAt: account.updatedAt?.toISOString() ?? null,
    },
    googleAccounts: googleAccounts
      .map((row) => ({
        ...row,
        connectedAt: row.connectedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    settings: affectedSettings
      .map(({ settings: row, capabilities }) => ({
        id: row.id,
        caseId: row.caseId,
        capabilities,
        emailAccountIds: row.emailAccountIds,
        metadata: row.metadata,
        googleDriveFolderIds: row.googleDriveFolderIds,
        autoDownloadAttachments: row.autoDownloadAttachments,
        autoDownloadGoogleDriveFiles: row.autoDownloadGoogleDriveFiles,
        isEnabled: row.isEnabled,
        updatedAt: row.updatedAt?.toISOString() ?? null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    cases: caseRows.slice().sort((left, right) => left.id.localeCompare(right.id)),
    sources: sourceRows
      .map((row) => ({ ...row }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });

  return {
    contractVersion: "google-disconnect-impact-v1",
    impactRevision,
    account: { id: account.id, email: account.email || "", status: account.status },
    credential: {
      provider: "google",
      kind: "shared_oauth_grant",
      stored: Boolean(account.refreshToken || account.accessToken),
      willRevoke: Boolean(account.refreshToken || account.accessToken),
      localConnectionWillRemove: true,
    },
    capabilities: [
      { id: "gmail", label: "Gmail evidence collection", willRemove: true },
      { id: "google_drive", label: "Google Drive evidence collection", willRemove: true },
    ],
    scheduledCollections,
    localSourceRecords,
    remainingGoogleAccountsAfter: Math.max(0, googleAccounts.length - 1),
    collectedDocumentsWillRemain: true,
  };
}

/** Internal acceptance signal; never returns either credential value. */
export async function inspectProviderCredentialStorage(input: {
  userId: string;
  accountId: string;
}): Promise<{ accessTokenDecryptable: boolean; refreshGrantDecryptable: boolean }> {
  const account = await requireOwnedConnection(input);
  const canDecrypt = (value: string | null): boolean => {
    if (!value) return false;
    try {
      return Boolean(decryptToken(value));
    } catch {
      return false;
    }
  };
  return {
    accessTokenDecryptable: canDecrypt(account.accessToken),
    refreshGrantDecryptable: canDecrypt(account.refreshToken),
  };
}

async function requireOwnedConnection(input: {
  userId: string;
  accountId?: string;
  provider?: OAuthProvider;
}): Promise<StoredProviderConnection> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const conditions = [eq(emailAccounts.userId, input.userId)];
  if (input.accountId) conditions.push(eq(emailAccounts.id, input.accountId));
  if (input.provider) conditions.push(eq(emailAccounts.provider, input.provider));
  const rows = await db.select().from(emailAccounts).where(and(...conditions)).limit(input.accountId ? 1 : 2);
  if (!rows.length) {
    throw new ProviderConnectionError("not_found", "The selected provider account was not found.");
  }
  if (!input.accountId && rows.length > 1) {
    throw new ProviderConnectionError("not_found", "Multiple provider accounts are connected; select one account.");
  }
  return rows[0];
}

async function requestRefreshGrant(
  provider: OAuthProvider,
  refreshToken: string,
): Promise<OAuth2Tokens> {
  const config = getOAuth2Config(provider);
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    grant_type: "refresh_token",
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  if (provider === "outlook") body.set("scope", config.scopes.join(" "));
  const endpoint = provider === "gmail"
    ? "https://oauth2.googleapis.com/token"
    : "https://login.microsoftonline.com/common/oauth2/v2.0/token";

  let response: Response;
  let data: Record<string, unknown>;
  try {
    const result = await withBoundedHttpResponse(
      () => fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      }),
      async (providerResponse) => ({
        response: providerResponse,
        data: await readBoundedResponseJson<Record<string, unknown>>(providerResponse, {
          maxBytes: PROVIDER_MAX_RESPONSE_BYTES,
          label: `${providerAuditName(provider)} OAuth refresh response`,
        }),
      }),
    );
    response = result.response;
    data = result.data;
  } catch (error) {
    throw new ProviderConnectionError(
      "transient_provider_failure",
      "The provider could not be reached. The saved connection was not changed.",
      { cause: error },
    );
  }

  if (!response.ok) {
    const providerCode = typeof data.error === "string" ? data.error : "";
    if (providerCode === "invalid_grant") {
      throw new ProviderConnectionError(
        "reconnect_required",
        "The provider grant is no longer valid. Reconnect this account.",
      );
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      throw new ProviderConnectionError(
        "transient_provider_failure",
        "The provider temporarily rejected the refresh. The saved connection was not changed.",
      );
    }
    throw new ProviderConnectionError(
      "provider_configuration_failure",
      "The provider rejected the configured OAuth client. The saved connection was not changed.",
    );
  }

  const accessToken = typeof data.access_token === "string" ? data.access_token : "";
  if (!accessToken) {
    throw new ProviderConnectionError(
      "provider_configuration_failure",
      "The provider refresh response did not include an access token.",
    );
  }
  return {
    accessToken,
    refreshToken: typeof data.refresh_token === "string" && data.refresh_token
      ? data.refresh_token
      : undefined,
    expiresIn: normalizeExpirySeconds(data.expires_in),
    tokenType: typeof data.token_type === "string" ? data.token_type : "Bearer",
    scope: typeof data.scope === "string" ? data.scope : undefined,
  };
}

async function markReconnectRequired(
  account: StoredProviderConnection,
  reason: "invalid_grant" | "missing_refresh_grant",
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  db.transaction((tx: any) => {
    const update = tx.update(emailAccounts).set({
      accessToken: null,
      refreshToken: null,
      tokenExpiry: null,
      status: "reconnect_required" satisfies ProviderConnectionStatus,
      updatedAt: new Date(),
    }).where(and(
      eq(emailAccounts.id, account.id),
      eq(emailAccounts.userId, account.userId),
      eq(emailAccounts.status, "connected"),
    )).run();
    if (Number(update.changes || 0) !== 1) {
      throw new ProviderConnectionError(
        "not_connected",
        "The provider connection changed while its status was being updated.",
      );
    }
    writeAuditLogOrThrow(tx, {
      userId: account.userId,
      action: AUDIT_ACTIONS.PROVIDER_CREDENTIALS_INVALIDATED,
      entityType: "provider_connection",
      entityId: account.id,
      details: { provider: providerAuditName(account.provider as OAuthProvider), reason },
    });
  });
}

async function refreshOwnedConnection(account: StoredProviderConnection): Promise<string> {
  if (!account.refreshToken) {
    await markReconnectRequired(account, "missing_refresh_grant");
    throw new ProviderConnectionError(
      "reconnect_required",
      "The provider account has no refresh grant. Reconnect this account.",
    );
  }
  const encryptedRefreshGrant = account.refreshToken;
  let refreshToken: string;
  try {
    refreshToken = decryptToken(encryptedRefreshGrant);
  } catch (error) {
    await markReconnectRequired(account, "invalid_grant");
    throw new ProviderConnectionError(
      "reconnect_required",
      "The saved provider grant cannot be used. Reconnect this account.",
      { cause: error },
    );
  }

  let next: OAuth2Tokens;
  try {
    next = await requestRefreshGrant(account.provider as OAuthProvider, refreshToken);
  } catch (error) {
    if (error instanceof ProviderConnectionError && error.code === "reconnect_required") {
      await markReconnectRequired(account, "invalid_grant");
    }
    throw error;
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const refreshedAt = new Date();
  const tokenExpiry = expiryDate(next.expiresIn, refreshedAt.getTime());
  try {
    db.transaction((tx: any) => {
      const update = tx.update(emailAccounts).set({
        accessToken: encryptToken(next.accessToken),
        refreshToken: next.refreshToken ? encryptToken(next.refreshToken) : encryptedRefreshGrant,
        tokenExpiry,
        status: "connected" satisfies ProviderConnectionStatus,
        updatedAt: refreshedAt,
      }).where(and(
        eq(emailAccounts.id, account.id),
        eq(emailAccounts.userId, account.userId),
        eq(emailAccounts.status, "connected"),
        eq(emailAccounts.refreshToken, encryptedRefreshGrant),
      )).run();
      if (Number(update.changes || 0) !== 1) {
        throw new ProviderConnectionError(
          "not_connected",
          "The provider connection changed while credentials were refreshing.",
        );
      }
      writeAuditLogOrThrow(tx, {
        userId: account.userId,
        action: AUDIT_ACTIONS.PROVIDER_CREDENTIALS_REFRESHED,
        entityType: "provider_connection",
        entityId: account.id,
        details: {
          provider: providerAuditName(account.provider as OAuthProvider),
          refreshGrantRotated: Boolean(next.refreshToken && next.refreshToken !== refreshToken),
          expiresAt: tokenExpiry.toISOString(),
        },
      });
    });
  } catch (error) {
    console.error("[Provider][REFRESH_UNCERTAIN] Credential refresh was not durably saved", {
      accountId: account.id,
      userId: account.userId,
    });
    throw new ProviderConnectionError(
      "refresh_uncertain",
      "Credential refresh could not be saved and audited. The provider may have rotated the grant; reconnect this account before relying on sync.",
      { cause: error },
    );
  }
  return next.accessToken;
}

export async function getProviderAccessToken(input: {
  userId: string;
  accountId?: string;
  provider?: OAuthProvider;
  refreshWindowMs?: number;
  forceRefresh?: boolean;
}): Promise<string> {
  const account = await requireOwnedConnection(input);
  if (account.provider !== "gmail" && account.provider !== "outlook") {
    throw new ProviderConnectionError("not_found", "The selected provider account is unsupported.");
  }
  if (account.status !== "connected") {
    throw new ProviderConnectionError("reconnect_required", "Reconnect the selected provider account.");
  }
  const expiryMs = account.tokenExpiry?.getTime() ?? Number.POSITIVE_INFINITY;
  const refreshWindowMs = Math.max(0, input.refreshWindowMs ?? DEFAULT_REFRESH_WINDOW_MS);
  const shouldRefresh = Boolean(input.forceRefresh || !account.accessToken || expiryMs <= Date.now() + refreshWindowMs);
  if (!shouldRefresh) {
    try {
      const accessToken = decryptToken(account.accessToken!);
      if (accessToken) return accessToken;
    } catch {
      // A corrupt access token can still recover through a valid refresh grant.
    }
  }

  const flightKey = `${account.userId}\0${account.id}`;
  const existingFlight = refreshFlights.get(flightKey);
  if (existingFlight) return existingFlight;
  const flight = refreshOwnedConnection(account).finally(() => {
    if (refreshFlights.get(flightKey) === flight) refreshFlights.delete(flightKey);
  });
  refreshFlights.set(flightKey, flight);
  return flight;
}

async function revokeProviderGrant(account: StoredProviderConnection): Promise<RevocationOutcome> {
  if (account.provider !== "gmail") return "not_applicable";
  const encryptedToken = account.refreshToken || account.accessToken;
  if (!encryptedToken) return "not_applicable";
  let token: string;
  try {
    token = decryptToken(encryptedToken);
  } catch (error) {
    throw new ProviderConnectionError(
      "upstream_revocation_failed",
      "The shared Google grant could not be read for revocation. Gmail, Drive, scheduled collection, credentials, and local source records were retained. Retry after reconnecting the account.",
      { cause: error },
    );
  }
  let response: Response;
  try {
    response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderConnectionError(
      "upstream_revocation_failed",
      "Google did not confirm revocation. Gmail, Drive, scheduled collection, credentials, and local source records were retained. Retry disconnect.",
      { cause: error },
    );
  }
  if (!response.ok && response.status !== 400) {
    throw new ProviderConnectionError(
      "upstream_revocation_failed",
      "Google did not confirm revocation. Gmail, Drive, scheduled collection, credentials, and local source records were retained. Retry disconnect.",
    );
  }
  return response.status === 400 ? "already_invalid" : "revoked";
}

export async function disconnectProviderConnection(input: {
  userId: string;
  accountId: string;
  impactRevision: string;
  acknowledgeSharedGoogleGrant: true;
  initiatedFrom: GoogleDisconnectInitiator;
}): Promise<{
  success: true;
  revocationOutcome: RevocationOutcome;
  removedCapabilities: GoogleDisconnectCapability[];
  scheduledCollectionsUpdated: number;
  localSourceRecordsRemoved: number;
  localSourceRecordsRetained: number;
  remainingGoogleAccounts: number;
  collectedDocumentsRetained: true;
}> {
  const account = await requireOwnedConnection(input);
  if (account.provider !== "gmail" || input.acknowledgeSharedGoogleGrant !== true) {
    throw new ProviderConnectionError(
      "impact_changed",
      "Review and confirm the shared Gmail and Google Drive disconnect before continuing.",
    );
  }
  const impact = await getGoogleDisconnectImpact(input);
  if (impact.impactRevision !== input.impactRevision) {
    throw new ProviderConnectionError(
      "impact_changed",
      "The Google account, scheduled collection, or local source state changed. Review the disconnect impact again.",
    );
  }
  let revocationOutcome: RevocationOutcome;
  try {
    revocationOutcome = await revokeProviderGrant(account);
  } catch (error) {
    await createAuditLog({
      userId: input.userId,
      action: AUDIT_ACTIONS.PROVIDER_DISCONNECT_FAILED,
      entityType: "provider_connection",
      entityId: account.id,
      details: {
        provider: providerAuditName(account.provider as OAuthProvider),
        reason: "upstream_revocation_failed",
        localStateRetained: true,
        initiatedFrom: input.initiatedFrom,
        affectedCapabilities: ["gmail", "google_drive"],
      },
    });
    throw error;
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = db.transaction((tx: any) => {
    const deletion = tx.delete(emailAccounts).where(and(
      eq(emailAccounts.id, account.id),
      eq(emailAccounts.userId, input.userId),
    )).run();
    if (Number(deletion.changes || 0) !== 1) {
      throw new ProviderConnectionError(
        "not_found",
        "The provider connection changed before it could be removed.",
      );
    }
    const remaining = tx.select({ id: emailAccounts.id }).from(emailAccounts).where(and(
      eq(emailAccounts.userId, input.userId),
      eq(emailAccounts.provider, account.provider!),
    )).all();
    const isOnlyGoogleAccount = remaining.length === 0;
    const settingsRows = tx.select().from(autoCollectionSettings)
      .where(eq(autoCollectionSettings.userId, input.userId)).all();
    let scheduledCollectionsUpdated = 0;
    for (const settings of settingsRows) {
      const update = rewriteScheduledCollection(settings, account.id, isOnlyGoogleAccount);
      if (!update) continue;
      tx.update(autoCollectionSettings).set(update).where(and(
        eq(autoCollectionSettings.id, settings.id),
        eq(autoCollectionSettings.userId, input.userId),
      )).run();
      scheduledCollectionsUpdated += 1;
    }
    let localSourceRecordsRemoved = 0;
    const localSourceRecordsRetained = impact.localSourceRecords.reduce((total, row) => total + row.count, 0);
    if (isOnlyGoogleAccount) {
      const removed = tx.delete(evidenceSources).where(and(
        eq(evidenceSources.userId, input.userId),
        inArray(evidenceSources.sourceType, [...GOOGLE_SOURCE_TYPES]),
      )).run();
      localSourceRecordsRemoved = Number(removed.changes || 0);
    }
    writeAuditLogOrThrow(tx, {
      userId: input.userId,
      action: revocationOutcome === "revoked" || revocationOutcome === "already_invalid"
        ? AUDIT_ACTIONS.PROVIDER_DISCONNECT_REVOKED
        : AUDIT_ACTIONS.PROVIDER_DISCONNECTED,
      entityType: "provider_connection",
      entityId: account.id,
      details: {
        provider: providerAuditName(account.provider as OAuthProvider),
        revocationOutcome,
        localCredentialsRemoved: true,
        affectedCapabilities: ["gmail", "google_drive"],
        initiatedFrom: input.initiatedFrom,
        scheduledCollectionsUpdated,
        localSourceRecordsRemoved,
        localSourceRecordsRetained: isOnlyGoogleAccount ? 0 : localSourceRecordsRetained,
        remainingGoogleAccounts: remaining.length,
        collectedDocumentsRetained: true,
      },
    });
    return {
      scheduledCollectionsUpdated,
      localSourceRecordsRemoved,
      localSourceRecordsRetained: isOnlyGoogleAccount ? 0 : localSourceRecordsRetained,
      remainingGoogleAccounts: remaining.length,
    };
  });
  return {
    success: true,
    revocationOutcome,
    removedCapabilities: ["gmail", "google_drive"],
    ...result,
    collectedDocumentsRetained: true,
  };
}

export interface ProviderErasureRevocationSummary {
  attempted: number;
  revoked: number;
  alreadyInvalid: number;
  notApplicable: number;
  failed: number;
}

/**
 * Attempt remote revocation while credentials still exist. A failure is
 * reported to GDPR, which must retain the account and credentials for retry.
 */
export async function prepareProviderConnectionsForErasure(
  userId: string,
): Promise<ProviderErasureRevocationSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const accounts = await db.select().from(emailAccounts).where(eq(emailAccounts.userId, userId));
  // An older source row can still carry a provider token outside the canonical
  // email_accounts vault. No maintained revocation path can prove that legacy
  // grant invalid, so retain it and require operator remediation.
  const legacyTokens = await db.select({ id: evidenceSources.id, accessToken: evidenceSources.accessToken })
    .from(evidenceSources).where(eq(evidenceSources.userId, userId));
  const unresolvedLegacyTokens = legacyTokens.filter((source) => Boolean(source.accessToken?.trim())).length;
  const summary: ProviderErasureRevocationSummary = {
    attempted: accounts.length + unresolvedLegacyTokens,
    revoked: 0,
    alreadyInvalid: 0,
    notApplicable: 0,
    failed: unresolvedLegacyTokens,
  };
  for (const account of accounts) {
    const hasCredential = Boolean(account.refreshToken || account.accessToken);
    // Only Google has a supported revocation contract today. Treat a stored
    // Outlook/unknown grant (or a connected Google row without a usable token)
    // as unresolved; "not applicable" must never mean "safe to delete".
    if ((account.provider !== 'gmail' && (hasCredential || account.status === 'connected')) ||
        (account.provider === 'gmail' && account.status === 'connected' && !hasCredential)) {
      summary.failed += 1;
      continue;
    }
    try {
      const outcome = await revokeProviderGrant(account);
      if (outcome === "revoked") summary.revoked += 1;
      else if (outcome === "already_invalid") summary.alreadyInvalid += 1;
      else summary.notApplicable += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
