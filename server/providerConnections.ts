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
import { emailAccounts, evidenceSources } from "./schema";

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

const PROVIDER_TIMEOUT_MS = 20_000;
const PROVIDER_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_EXPIRY_SECONDS = 3_600;
const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 24 * 60 * 60;
const DEFAULT_REFRESH_WINDOW_MS = 60_000;
const refreshFlights = new Map<string, Promise<string>>();

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
  bindingSecret: string;
}): Promise<{ accountId: string; email: string }> {
  const oauthState = await consumeOAuthStateAsync(input.state, input.provider, input.bindingSecret);
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
      "The stored provider grant could not be read for revocation.",
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
      "Google did not confirm token revocation.",
      { cause: error },
    );
  }
  if (!response.ok && response.status !== 400) {
    throw new ProviderConnectionError(
      "upstream_revocation_failed",
      "Google did not confirm token revocation.",
    );
  }
  return response.status === 400 ? "already_invalid" : "revoked";
}

export async function disconnectProviderConnection(input: {
  userId: string;
  accountId: string;
}): Promise<{ success: true; revocationOutcome: RevocationOutcome }> {
  const account = await requireOwnedConnection(input);
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
      },
    });
    throw error;
  }

  const db = await getDb();
  if (!db) throw new Error("Database not available");
  db.transaction((tx: any) => {
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
      eq(emailAccounts.status, "connected"),
    )).limit(1).get();
    let localSourcesRemoved = false;
    if (!remaining) {
      const sourceTypes = account.provider === "gmail"
        ? ["Gmail", "GoogleDrive", "gmail", "google_drive"]
        : ["Outlook", "OneDrive", "outlook", "one_drive"];
      const removed = tx.delete(evidenceSources).where(and(
        eq(evidenceSources.userId, input.userId),
        inArray(evidenceSources.sourceType, sourceTypes),
      )).run();
      localSourcesRemoved = Number(removed.changes || 0) > 0;
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
        localSourcesRemoved,
      },
    });
  });
  return { success: true, revocationOutcome };
}

export interface ProviderErasureRevocationSummary {
  attempted: number;
  revoked: number;
  alreadyInvalid: number;
  notApplicable: number;
  failed: number;
}

/**
 * Best-effort remote revocation before GDPR removes the only local copy of a
 * grant. Provider outages never block the owner's local right to erasure.
 */
export async function prepareProviderConnectionsForErasure(
  userId: string,
): Promise<ProviderErasureRevocationSummary> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const accounts = await db.select().from(emailAccounts).where(eq(emailAccounts.userId, userId));
  const summary: ProviderErasureRevocationSummary = {
    attempted: accounts.length,
    revoked: 0,
    alreadyInvalid: 0,
    notApplicable: 0,
    failed: 0,
  };
  for (const account of accounts) {
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
