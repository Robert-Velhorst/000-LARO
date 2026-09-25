import crypto from "crypto";
import { ENV } from "./_core/env";

export const PASSWORD_RESET_MAX_FAILURES = 5;
export const PASSWORD_RESET_LOCK_MS = 15 * 60 * 1000;

export function hashPasswordResetCode(code: string): string {
  return crypto
    .createHmac("sha256", ENV.COOKIE_SECRET)
    .update(code)
    .digest("hex");
}

export function passwordResetLockTimestamp(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function passwordResetHashMatches(candidateHash: string, storedHash: string): boolean {
  const candidate = Buffer.from(candidateHash);
  const stored = Buffer.from(storedHash);
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}
