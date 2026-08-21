import crypto from 'crypto';
import { ENV } from './_core/env';

/**
 * Phase 007/030 (D4) — authenticated symmetric encryption for stored secrets
 * (OAuth tokens). Replaces the previous AES-256-CBC scheme, which had:
 *   - a weak key (`Buffer.alloc(32, secret)` — the secret repeated to 32 bytes),
 *   - NO integrity/authentication (CBC is malleable; tampering was undetectable).
 *
 * This module uses AES-256-GCM (authenticated) with a key derived via scrypt from
 * the install secret. Ciphertext is self-describing and versioned so we can rotate
 * schemes later, and legacy CBC values still decrypt for backward compatibility.
 */

const GCM_ALGO = 'aes-256-gcm';
const LEGACY_CBC_ALGO = 'aes-256-cbc';
const IV_LEN = 12; // 96-bit nonce, recommended for GCM
const KDF_SALT = 'laro-token-kdf-v1';
const PREFIX = 'gcm1'; // scheme version marker

function secret(): string {
  return ENV.JWT_SECRET || ENV.COOKIE_SECRET || 'insecure-dev-secret-change-me-please';
}

// Derive once while the server module graph is loading. Repeating this
// memory-hard operation inside public OAuth callback requests can block the
// event loop and turn malformed callback traffic into resource exhaustion.
const TOKEN_KEY = crypto.scryptSync(secret(), KDF_SALT, 32);

/** Encrypt a UTF-8 string with AES-256-GCM. Returns `gcm1:iv:tag:ciphertext` (hex). */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(GCM_ALGO, TOKEN_KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

/** Decrypt a value produced by encryptSecret, transparently handling legacy CBC. */
export interface DecryptSecretOptions {
  logFailure?: boolean;
}

export function decryptSecret(value: string, options: DecryptSecretOptions = {}): string {
  if (!value) return '';
  try {
    if (value.startsWith(PREFIX + ':')) {
      const [, ivHex, tagHex, dataHex] = value.split(':');
      const decipher = crypto.createDecipheriv(GCM_ALGO, TOKEN_KEY, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
    }
    // Legacy AES-256-CBC (`iv:ciphertext`), decrypted with the OLD key scheme so
    // previously-stored tokens keep working until they are re-saved (and upgraded).
    const parts = value.split(':');
    if (parts.length >= 2) {
      const iv = Buffer.from(parts.shift()!, 'hex');
      const legacyKey = Buffer.alloc(32, secret());
      const decipher = crypto.createDecipheriv(LEGACY_CBC_ALGO, legacyKey, iv);
      return Buffer.concat([decipher.update(Buffer.from(parts.join(':'), 'hex')), decipher.final()]).toString('utf8');
    }
  } catch (err) {
    if (options.logFailure !== false) {
      console.error('[crypto] decryptSecret failed:', err instanceof Error ? err.message : err);
    }
  }
  return '';
}

/** True when a stored value uses the current (authenticated) scheme. */
export function isCurrentScheme(value: string): boolean {
  return !!value && value.startsWith(PREFIX + ':');
}
