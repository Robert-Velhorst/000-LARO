
import { nanoid } from "nanoid";
import crypto from "crypto";
import { encryptToken, decryptToken } from "./emailOAuth";
import { ENV } from "./_core/env";
import { readBoundedResponseJson, withBoundedHttpResponse } from "./boundedHttpResponse";
import { getHostedRedisOAuthStateClient } from "./hostedRedis";
import { createRedisOAuthStateStore, type StoredOAuthFlow } from "./oauthStateStore";
import { createLocalOAuthStateStore } from "./localOAuthStateStore";

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
  flowId: string;
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
const OAUTH_PROVIDER_MAX_RESPONSE_BYTES = 256 * 1024;

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

function fetchOAuthJson<T>(
  request: () => Promise<Response>,
  label: string,
): Promise<{ response: Response; data: T }> {
  return withBoundedHttpResponse(request, async (response) => ({
    response,
    data: await readBoundedResponseJson<T>(response, {
      maxBytes: OAUTH_PROVIDER_MAX_RESPONSE_BYTES,
      label,
    }),
  }));
}

function fetchOAuthAccountJson<T>(
  request: () => Promise<Response>,
  label: string,
  errorLabel: string,
): Promise<T> {
  return withBoundedHttpResponse(request, async (response) => {
    if (!response.ok) throw new Error(`${errorLabel} (${response.status})`);
    return readBoundedResponseJson<T>(response, {
      maxBytes: OAUTH_PROVIDER_MAX_RESPONSE_BYTES,
      label,
    });
  });
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

/** The portable state contains PKCE material and an opaque flow ID, never user authority. */
function buildOAuthState(provider: OAuthProvider, flowId: string, codeVerifier: string): string {
  const payload: OAuthStatePayload = {
    provider,
    flowId,
    codeVerifier,
    nonce: nanoid(),
    createdAt: Date.now(),
  };
  return toBase64Url(Buffer.from(encryptToken(JSON.stringify(payload)), "utf8"));
}

function providerAuthorizationUrl(
  provider: OAuthProvider,
  state: string,
  codeVerifier: string,
): string {
  const codeChallenge = toBase64Url(crypto.createHash("sha256").update(codeVerifier).digest());
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
      prompt: "consent select_account",
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

function digestProof(value: string): string {
  return crypto.createHmac('sha256', ENV.JWT_SECRET)
    .update('LARO OAuth flow proof v1\0')
    .update(value)
    .digest('hex');
}

function callbackUsesLoopback(): boolean {
  try {
    const hostname = new URL(getOAuthRedirectBaseUrl()).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

async function oauthFlowStore() {
  if (ENV.isHosted) {
    return createRedisOAuthStateStore(await getHostedRedisOAuthStateClient());
  }
  return createLocalOAuthStateStore();
}

function decodeOAuthState(state: string, provider: OAuthProvider): OAuthStatePayload {
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
    typeof payload.flowId !== "string" ||
    typeof payload.codeVerifier !== "string" ||
    typeof payload.createdAt !== "number" ||
    typeof payload.nonce !== "string" ||
    payload.flowId.length < 20 ||
    payload.codeVerifier.length < 43
  ) {
    throw new OAuthStateError();
  }
  if (Date.now() - payload.createdAt > OAUTH_STATE_TTL_MS || payload.createdAt > Date.now() + 30_000) {
    throw new OAuthStateError();
  }
  if (payload.provider !== provider) throw new OAuthStateError();
  return payload;
}

/**
 * Start with a one-time server-held record. The renderer receives only the
 * local/public start route; the provider URL is issued after that browser has
 * received its HttpOnly flow binding.
 */
export async function beginOAuthFlowAsync(
  provider: OAuthProvider,
  userId: string,
  initiatingSessionToken = '',
): Promise<string> {
  const { codeVerifier } = generatePkcePair();
  const flowId = toBase64Url(crypto.randomBytes(24));
  const state = buildOAuthState(provider, flowId, codeVerifier);
  const startTicket = toBase64Url(crypto.randomBytes(32));
  // Validate provider configuration before leaving a durable pending record.
  if (!getOAuth2Config(provider).clientId) {
    throw new Error(`${provider} OAuth client ID is not configured`);
  }
  const allowLoopbackHandoff = !ENV.isHosted && callbackUsesLoopback();
  if (!initiatingSessionToken && !allowLoopbackHandoff) {
    throw new Error('OAuth flow requires an authenticated initiating browser session.');
  }
  const flow: StoredOAuthFlow = {
    flowId,
    userId,
    provider,
    initiatingSessionHash: digestProof(initiatingSessionToken),
    allowLoopbackHandoff,
    startTicketHash: digestProof(startTicket),
    bindingHash: null,
    status: 'pending',
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  };
  try {
    const store = await oauthFlowStore();
    await store.record(state, flow, OAUTH_STATE_TTL_MS);
  } catch {
    throw new Error("OAuth flow could not be started safely because one-time flow storage is unavailable.");
  }
  const startUrl = new URL(`${getOAuthRedirectBaseUrl()}/api/oauth/${provider}/start`);
  startUrl.searchParams.set('state', state);
  startUrl.searchParams.set('ticket', startTicket);
  return startUrl.toString();
}

/**
 * Redeem the one-time start ticket and bind this flow to the browser that will
 * return from the provider. A copied provider URL never contains this proof.
 */
export async function activateOAuthStateAsync(
  state: string,
  provider: OAuthProvider,
  startTicket: string,
  initiatingSessionToken = '',
  loopbackRequest = false,
): Promise<{ authorizationUrl: string; bindingCookieValue: string }> {
  const payload = decodeOAuthState(state, provider);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(startTicket)) throw new OAuthStateError();
  const bindingCookieValue = toBase64Url(crypto.randomBytes(32));
  try {
    const store = await oauthFlowStore();
    const flow = await store.activate(state, {
      startTicketHash: digestProof(startTicket),
      bindingHash: digestProof(bindingCookieValue),
      provider,
      flowId: payload.flowId,
      now: Date.now(),
      initiatingSessionHash: digestProof(initiatingSessionToken),
      loopbackRequest,
    });
    if (!flow) throw new OAuthStateError();
  } catch (error) {
    if (error instanceof OAuthStateError) throw error;
    throw new OAuthStateError();
  }
  return {
    authorizationUrl: providerAuthorizationUrl(provider, state, payload.codeVerifier),
    bindingCookieValue,
  };
}

/**
 * Validate and atomically consume the browser-bound flow before exchanging the
 * provider code. Missing proof, another browser/session, expiry, or replay all
 * fail identically without revealing flow ownership.
 */
export async function consumeOAuthStateAsync(
  state: string,
  provider: OAuthProvider,
  bindingCookieValue: string,
): Promise<{ userId: string; codeVerifier: string }> {
  const payload = decodeOAuthState(state, provider);
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(bindingCookieValue)) throw new OAuthStateError();
  try {
    const store = await oauthFlowStore();
    const flow = await store.consume(state, {
      bindingHash: digestProof(bindingCookieValue),
      provider,
      flowId: payload.flowId,
      now: Date.now(),
    });
    if (!flow) throw new OAuthStateError();
    return { userId: flow.userId, codeVerifier: payload.codeVerifier };
  } catch (error) {
    if (error instanceof OAuthStateError) throw error;
    throw new OAuthStateError();
  }
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
    const { response: res, data } = await fetchOAuthJson<Record<string, string>>(
      () => fetchTokenEndpoint("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }),
      "Google OAuth response",
    );
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
  const { response: res, data } = await fetchOAuthJson<Record<string, string>>(
    () => fetchTokenEndpoint("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }),
    "Microsoft OAuth response",
  );
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
    const d = await fetchOAuthAccountJson<{
      email?: string;
      name?: string;
      picture?: string;
    }>(() => fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
      }), "Google account response", "Google account lookup failed");
    return {
      email: d.email || "",
      displayName: d.name,
      profilePicture: d.picture,
    };
  }
  const d = await fetchOAuthAccountJson<{
    mail?: string;
    userPrincipalName?: string;
    displayName?: string;
  }>(() => fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
    }), "Microsoft account response", "Microsoft account lookup failed");
  return {
    email: d.mail || d.userPrincipalName || "",
    displayName: d.displayName,
  };
}
