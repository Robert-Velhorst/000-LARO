import { ENV } from './_core/env';
import { encryptSecret, decryptSecret, type DecryptSecretOptions } from './crypto';

const OAUTH_PROVIDER_TIMEOUT_MS = 15_000;

/**
 * Token Encryption & OAuth Refresh Utilities.
 *
 * Phase 007/030 (D4): token confidentiality now uses authenticated AES-256-GCM via
 * `server/crypto.ts` (previously unauthenticated AES-256-CBC with a weak key).
 * The function names are unchanged so all callers keep working; legacy CBC values
 * still decrypt transparently until they are re-saved (and thereby upgraded).
 */

/** Encrypt an OAuth token for storage (authenticated encryption). */
export function encryptToken(text: string): string {
  return encryptSecret(text);
}

/** Decrypt a stored OAuth token (handles both the current and legacy schemes). */
export function decryptToken(text: string, options?: DecryptSecretOptions): string {
  return decryptSecret(text, options);
}

/**
 * Revoke a Google OAuth grant. Google returns HTTP 400 when the supplied token
 * is already invalid, which is a safe terminal state for a disconnect request.
 */
export type GoogleRevocationOutcome = 'revoked' | 'already_invalid' | 'not_applicable';

export async function revokeGoogleToken(token: string): Promise<Exclude<GoogleRevocationOutcome, 'not_applicable'>> {
  if (!token) {
    throw new Error('Google token is unavailable for revocation');
  }

  const response = await fetch('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok && response.status !== 400) {
    throw new Error(`Google token revocation failed (HTTP ${response.status})`);
  }

  return response.status === 400 ? 'already_invalid' : 'revoked';
}

/** Revoke the refresh token when present; it represents the durable grant. */
export async function revokeStoredGoogleTokens(tokens: {
  accessToken?: string | null;
  refreshToken?: string | null;
}): Promise<GoogleRevocationOutcome> {
  const encryptedToken = tokens.refreshToken || tokens.accessToken;
  if (!encryptedToken) return 'not_applicable';

  const token = decryptToken(encryptedToken);
  if (!token) {
    throw new Error('Stored Google token could not be decrypted');
  }
  return revokeGoogleToken(token);
}

/**
 * Refresh a Gmail access token using the refresh token
 */
export async function refreshGmailToken(refreshToken: string) {
  const clientId = ENV.GOOGLE_CLIENT_ID || process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret =
    ENV.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  if (!clientId) {
    throw new Error("Missing Google OAuth client ID configuration");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gmail token refresh failed: ${data.error_description || data.error}`);
  }

  return {
    accessToken: data.access_token,
    expiryDate:  Date.now() + (data.expires_in * 1000),
  };
}

/**
 * Refresh an Outlook access token using the refresh token
 */
export async function refreshOutlookToken(refreshToken: string) {
  const clientId = ENV.MICROSOFT_CLIENT_ID || process.env.MICROSOFT_OAUTH_CLIENT_ID || "";
  const clientSecret = ENV.MICROSOFT_CLIENT_SECRET || process.env.MICROSOFT_OAUTH_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw new Error("Missing Microsoft OAuth client configuration");
  }

  const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
      scope:         'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access',
    }),
    signal: AbortSignal.timeout(OAUTH_PROVIDER_TIMEOUT_MS),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Outlook token refresh failed: ${data.error_description || data.error}`);
  }

  return {
    accessToken: data.access_token,
    expiryDate:  Date.now() + (data.expires_in * 1000),
  };
}
