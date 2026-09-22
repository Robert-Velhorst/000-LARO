import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { getDb } from './db';
import { systemConfig, users } from './schema';
import { SESSION_COOKIE_NAME } from './sessionCookie';
import { sendSystemEmail } from './systemEmail';

const CODE_TTL_MS = 10 * 60_000;
const PROOF_TTL_MS = 5 * 60_000;
const MAX_CODE_FAILURES = 5;

type StoredCode = { digest: string; expiresAt: number; failures: number; sessionDigest: string };
type StoredProof = { digest: string; expiresAt: number; sessionDigest: string };

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function equalDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

function codeKey(userId: string): string { return `erasure:code:${userId}`; }
function proofKey(userId: string): string { return `erasure:proof:${userId}`; }

function sessionDigest(cookies: Record<string, unknown> | undefined): string {
  const cookie = cookies?.[SESSION_COOKIE_NAME];
  if (typeof cookie !== 'string' || cookie.length < 16 || cookie.length > 8_192) {
    throw new Error('A current browser session is required for account erasure');
  }
  return digest(cookie);
}

function parseStored<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try { return JSON.parse(value) as T; } catch { return null; }
}

export async function getErasureAuthMethod(userId: string): Promise<'password' | 'email_code'> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const user = db.select({ password: users.password, email: users.email })
    .from(users).where(eq(users.id, userId)).get();
  if (!user) throw new Error('Account not found');
  if (user.password) return 'password';
  if (user.email) return 'email_code';
  throw new Error('This account has no available reauthentication method');
}

/** Passwordless legacy accounts must prove fresh control of their account mailbox. */
export async function requestErasureCode(userId: string, cookies: Record<string, unknown> | undefined): Promise<void> {
  const binding = sessionDigest(cookies);
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const user = db.select({ password: users.password, email: users.email })
    .from(users).where(eq(users.id, userId)).get();
  if (!user || user.password || !user.email) throw new Error('Email verification is unavailable for this account');
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  const challenge: StoredCode = {
    digest: digest(`${userId}:${code}`),
    expiresAt: Date.now() + CODE_TTL_MS,
    failures: 0,
    sessionDigest: binding,
  };
  db.insert(systemConfig).values({ configKey: codeKey(userId), configValue: JSON.stringify(challenge), updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemConfig.configKey, set: { configValue: JSON.stringify(challenge), updatedAt: new Date() } }).run();
  try {
    const result = await sendSystemEmail({
      to: user.email,
      subject: 'Your LARO account-erasure verification code',
      text: `Your account-erasure verification code is ${code}. It expires in 10 minutes. If you did not request account deletion, ignore this message.`,
    });
    // The existing development console email transport is useful for local
    // testing, but production must have a configured, accepting email provider.
    if (result.provider === 'unconfigured') throw new Error('Account-erasure email delivery is unavailable');
  } catch (error) {
    db.transaction((tx) => {
      const current = tx.select({ configValue: systemConfig.configValue }).from(systemConfig)
        .where(eq(systemConfig.configKey, codeKey(userId))).get();
      if (parseStored<StoredCode>(current?.configValue)?.digest === challenge.digest) {
        tx.delete(systemConfig).where(eq(systemConfig.configKey, codeKey(userId))).run();
      }
    });
    throw error;
  }
}

export async function reauthenticateForErasure(input: {
  userId: string;
  cookies: Record<string, unknown> | undefined;
  password?: string;
  code?: string;
}): Promise<{ proof: string; expiresAt: number }> {
  const binding = sessionDigest(input.cookies);
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const user = db.select({ password: users.password }).from(users).where(eq(users.id, input.userId)).get();
  if (!user) throw new Error('Account not found');
  if (user.password) {
    if (!input.password || input.code || !await bcrypt.compare(input.password, user.password)) {
      throw new Error('Current password is incorrect');
    }
  } else {
    if (!input.code || input.password) throw new Error('Verification code is required');
    const verified = db.transaction((tx) => {
      const row = tx.select({ configValue: systemConfig.configValue }).from(systemConfig)
        .where(eq(systemConfig.configKey, codeKey(input.userId))).get();
      const challenge = parseStored<StoredCode>(row?.configValue);
      if (!challenge || challenge.expiresAt <= Date.now() || challenge.sessionDigest !== binding || challenge.failures >= MAX_CODE_FAILURES) {
        return false;
      }
      const matches = equalDigest(challenge.digest, digest(`${input.userId}:${input.code}`));
      if (matches) {
        tx.delete(systemConfig).where(eq(systemConfig.configKey, codeKey(input.userId))).run();
      } else {
        challenge.failures += 1;
        tx.update(systemConfig).set({ configValue: JSON.stringify(challenge), updatedAt: new Date() })
          .where(eq(systemConfig.configKey, codeKey(input.userId))).run();
      }
      return matches;
    });
    if (!verified) throw new Error('Verification code is invalid or expired');
  }
  const proof = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + PROOF_TTL_MS;
  const stored: StoredProof = { digest: digest(proof), expiresAt, sessionDigest: binding };
  db.insert(systemConfig).values({ configKey: proofKey(input.userId), configValue: JSON.stringify(stored), updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemConfig.configKey, set: { configValue: JSON.stringify(stored), updatedAt: new Date() } }).run();
  return { proof, expiresAt };
}

/** Consume once before any provider, scanner, or relational erasure side effect. */
export async function consumeErasureProof(userId: string, cookies: Record<string, unknown> | undefined, proof: string): Promise<boolean> {
  const binding = sessionDigest(cookies);
  if (!/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db.transaction((tx) => {
    const row = tx.select({ configValue: systemConfig.configValue }).from(systemConfig)
      .where(eq(systemConfig.configKey, proofKey(userId))).get();
    const stored = parseStored<StoredProof>(row?.configValue);
    if (!stored || stored.expiresAt <= Date.now() || stored.sessionDigest !== binding || !equalDigest(stored.digest, digest(proof))) {
      return false;
    }
    return tx.delete(systemConfig).where(eq(systemConfig.configKey, proofKey(userId))).run().changes === 1;
  });
}
