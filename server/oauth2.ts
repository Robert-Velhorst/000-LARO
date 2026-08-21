
import { getDb } from "./db";
import { emailAccounts } from "./schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import crypto from "crypto";
import { encryptToken, decryptToken } from "./emailOAuth";
import { ENV } from "./_core/env";
import { AUDIT_ACTIONS, createAuditLog } from "./audit";

export interface OAuth2Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface OAuth2Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number; // seconds
  tokenType: string;
  scope?: string;
}

export interface EmailAccountInfo {
  email: string;
  displayName?: string;
  profilePicture?: string;
}

type OAuthProvider = "gmail" | "outlook";

export class OAuthStateError extends Error {
  constructor() {
    super("Invalid or expired OAuth state");
    this.name = "OAuthStateError";
  }
}


interface OAuthStatePayload {
  userId: string;
  provider: OAuthProvider;
  codeVerifier: string;
  nonce: string;
  createdAt: number;
}

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OAUTH_STATE_MAX_LENGTH = 2_048;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]+$/;
const OAUTH_GCM_ENVELOPE_PATTERN = /^gcm1:[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})+$/;
const OAUTH_LEGACY_CBC_ENVELOPE_PATTERN = /^[0-9a-f]{32}:(?:[0-9a-f]{32})+$/;
const TOKEN_EXCHANGE_DNS_RETRY_DELAYS_MS = [250, 750, 1_500] as const;
const OAUTH_PROVIDER_TIMEOUT_MS = 20_000;

export function isRetryableOAuthNetworkError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = (current as Error & { code?: string }).code;
    if (code === "EAI_AGAIN" || code === "ENOTFOUND" || code === "EAI_FAIL") return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

async function fetchTokenEndpoint(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS) });
    } catch (error) {
      if (!isRetryableOAuthNetworkError(error) || attempt >= TOKEN_EXCHANGE_DNS_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const delayMs = TOKEN_EXCHANGE_DNS_RETRY_DELAYS_MS[attempt];
      console.warn(`[OAuth2] Token endpoint DNS lookup failed; retrying in ${delayMs}ms.`);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}

function getOAuthRedirectBaseUrl(): string {
  const raw = process.env.OAUTH_REDIRECT_BASE_URL || 'http://localhost:3000';
  // Support accidental full callback values in .env by trimming to origin.
  if (raw.includes('/api/oauth/')) {
    return raw.split('/api/oauth/')[0].replace(/\/$/, '');
  }
  return raw.replace(/\/$/, '');
}

/**
 * Get OAuth2 configuration for provider
 */
export function getOAuth2Config(provider: 'gmail' | 'outlook'): OAuth2Config {
  const redirectBase = getOAuthRedirectBaseUrl();
  if (provider === 'gmail') {
    return {
      clientId: ENV.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      clientSecret: ENV.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      redirectUri: `${redirectBase}/api/oauth/gmail/callback`,
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
    };
  } else {
    return {
      clientId: ENV.MICROSOFT_CLIENT_ID || process.env.MICROSOFT_OAUTH_CLIENT_ID || '',
      clientSecret: ENV.MICROSOFT_CLIENT_SECRET || process.env.MICROSOFT_OAUTH_CLIENT_SECRET || '',
      redirectUri: `${redirectBase}/api/oauth/outlook/callback`,
      scopes: [
        'https://graph.microsoft.com/Mail.Read',
        'https://graph.microsoft.com/User.Read',
        'offline_access',
      ],
    };
  }
}

function toBase64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): Buffer {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = toBase64Url(crypto.randomBytes(64));
  const codeChallenge = toBase64Url(
    crypto.createHash("sha256").update(codeVerifier).digest()
  );
  return { codeVerifier, codeChallenge };
}

/**
 * Build a self-contained, encrypted OAuth state. Everything the callback needs
 * (userId, provider, PKCE codeVerifier) is encrypted into the state itself, so
 * the flow survives server/process restarts without any server-side storage.
 */
function buildOAuthState(
  provider: OAuthProvider,
  userId: string,
  codeVerifier: string
): string {
  const payload: OAuthStatePayload = {
    provider,
    userId,
    codeVerifier,
    nonce: nanoid(),
    createdAt: Date.now(),
  };
  return toBase64Url(Buffer.from(encryptToken(JSON.stringify(payload)), "utf8"));
}

/**
 * Start OAuth flow with PKCE and state protection.
 */
export function beginOAuthFlow(provider: OAuthProvider, userId: string): string {
  const { codeVerifier, codeChallenge } = generatePkcePair();
  const state = buildOAuthState(provider, userId, codeVerifier);

  const config = getOAuth2Config(provider);
  if (!config.clientId) {
    throw new Error(`${provider} OAuth client ID is not configured`);
  }

  if (provider === "gmail") {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: config.scopes.join(" "),
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    response_mode: "query",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Consume and validate one-time OAuth state.
 */
export function consumeOAuthState(
  state: string,
  provider: OAuthProvider
): { userId: string; codeVerifier: string } {
  if (
    !state ||
    state.length > OAUTH_STATE_MAX_LENGTH ||
    !OAUTH_STATE_PATTERN.test(state)
  ) {
    throw new OAuthStateError();
  }

  let payload: OAuthStatePayload;
  try {
    const encryptedState = fromBase64Url(state).toString("utf8");
    if (
      !OAUTH_GCM_ENVELOPE_PATTERN.test(encryptedState) &&
      !OAUTH_LEGACY_CBC_ENVELOPE_PATTERN.test(encryptedState)
    ) {
      throw new OAuthStateError();
    }
    const decrypted = decryptToken(encryptedState, { logFailure: false });
    payload = JSON.parse(decrypted) as OAuthStatePayload;
  } catch {
    throw new OAuthStateError();
  }

  if (
    !payload ||
    typeof payload.userId !== "string" ||
    typeof payload.codeVerifier !== "string" ||
    typeof payload.createdAt !== "number"
  ) {
    throw new OAuthStateError();
  }

  if (Date.now() - payload.createdAt > OAUTH_STATE_TTL_MS) {
    throw new OAuthStateError();
  }

  if (payload.provider !== provider) {
    throw new OAuthStateError();
  }

  return { userId: payload.userId, codeVerifier: payload.codeVerifier };
}

/**
 * Generate OAuth2 authorization URL
 */
export function getAuthorizationUrl(provider: 'gmail' | 'outlook', userId: string): string {
  return beginOAuthFlow(provider, userId);
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  provider: "gmail" | "outlook",
  code: string,
  codeVerifier?: string
): Promise<OAuth2Tokens> {
  const config = getOAuth2Config(provider);

  if (provider === "gmail") {
    const body = new URLSearchParams({
      code,
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    });
    if (codeVerifier) {
      body.set("code_verifier", codeVerifier);
    }
    if (config.clientSecret) {
      body.set("client_secret", config.clientSecret);
    }
    const res = await fetchTokenEndpoint("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as Record<string, string>;
    if (!res.ok) {
      throw new Error(data.error_description || data.error || "Gmail token exchange failed");
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: Number(data.expires_in) || 3600,
      tokenType: data.token_type || "Bearer",
      scope: data.scope,
    };
  }

  const body = new URLSearchParams({
    code,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    grant_type: "authorization_code",
  });
  if (codeVerifier) {
    body.set("code_verifier", codeVerifier);
  } else if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }
  const res = await fetchTokenEndpoint("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as Record<string, string>;
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Outlook token exchange failed");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: Number(data.expires_in) || 3600,
    tokenType: data.token_type || "Bearer",
    scope: data.scope,
  };
}

export async function getAccountInfo(
  provider: "gmail" | "outlook",
  accessToken: string
): Promise<EmailAccountInfo> {
  if (provider === "gmail") {
    const r = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`Google account lookup failed (${r.status})`);
    const d = (await r.json()) as { email?: string; name?: string; picture?: string };
    return {
      email: d.email || "",
      displayName: d.name,
      profilePicture: d.picture,
    };
  }
  const r = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`Microsoft account lookup failed (${r.status})`);
  const d = (await r.json()) as { mail?: string; userPrincipalName?: string; displayName?: string };
  return {
    email: d.mail || d.userPrincipalName || "",
    displayName: d.displayName,
  };
}

export async function saveEmailAccount(
  userId: string,
  provider: "gmail" | "outlook",
  tokens: OAuth2Tokens,
  accountInfo: EmailAccountInfo
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await db
    .select()
    .from(emailAccounts)
    .where(and(
      eq(emailAccounts.userId, userId),
      eq(emailAccounts.provider, provider),
      eq(emailAccounts.email, accountInfo.email),
    ))
    .limit(1);

  const row = {
    userId,
    provider,
    email: accountInfo.email,
    accessToken: encryptToken(tokens.accessToken),
    refreshToken: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
    tokenExpiry: new Date(Date.now() + tokens.expiresIn * 1000),
    status: "connected",
    connectedAt: new Date(),
    metadata: JSON.stringify({
      displayName: accountInfo.displayName,
      profilePicture: accountInfo.profilePicture,
      tokenType: tokens.tokenType,
      expiresIn: tokens.expiresIn,
    }),
    updatedAt: new Date(),
  };

  const accountId = existing[0]?.id ?? nanoid();
  if (existing[0]) {
    await db.update(emailAccounts).set(row).where(eq(emailAccounts.id, existing[0].id));
  } else {
    await db.insert(emailAccounts).values({ id: accountId, ...row, createdAt: new Date() });
  }

  await createAuditLog({
    userId,
    action: AUDIT_ACTIONS.PROVIDER_CONNECTED,
    entityType: "provider_connection",
    entityId: accountId,
    details: {
      provider: provider === "gmail" ? "google" : "microsoft",
      requestedScopes: getOAuth2Config(provider).scopes,
      tokenReportedScopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : [],
      refreshGrantStored: Boolean(tokens.refreshToken),
    },
  });

  return accountId;
}

export async function refreshAccessToken(
  provider: "gmail" | "outlook",
  refreshToken: string
): Promise<OAuth2Tokens> {
  const config = getOAuth2Config(provider);
  if (provider === "gmail") {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      grant_type: "refresh_token",
    });
    if (config.clientSecret) {
      body.set("client_secret", config.clientSecret);
    }
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as Record<string, string>;
    if (!res.ok) {
      throw new Error(data.error_description || data.error || "Gmail refresh failed");
    }
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresIn: Number(data.expires_in) || 3600,
      tokenType: data.token_type || "Bearer",
      scope: data.scope,
    };
  }

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "refresh_token",
    scope: config.scopes.join(" "),
  });
  const res = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as Record<string, string>;
  if (!res.ok) {
    throw new Error(data.error_description || data.error || "Outlook refresh failed");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: Number(data.expires_in) || 3600,
    tokenType: data.token_type || "Bearer",
    scope: data.scope,
  };
}
