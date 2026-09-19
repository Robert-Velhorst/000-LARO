import { encryptSecret, decryptSecret, type DecryptSecretOptions } from './crypto';

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
