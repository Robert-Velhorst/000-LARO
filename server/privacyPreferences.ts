import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from './db';
import { userPreferences } from './schema';

const PRIVACY_PREFERENCE_KEY = 'privacy-consent';

export interface PrivacyPreferences {
  marketing: boolean;
  analytics: boolean;
}

const DEFAULT_PRIVACY_PREFERENCES: PrivacyPreferences = {
  marketing: false,
  analytics: false,
};

function parsePreferences(value: string | null | undefined): PrivacyPreferences {
  if (!value) return { ...DEFAULT_PRIVACY_PREFERENCES };
  try {
    const parsed = JSON.parse(value) as Partial<PrivacyPreferences>;
    return {
      marketing: parsed.marketing === true,
      analytics: parsed.analytics === true,
    };
  } catch {
    return { ...DEFAULT_PRIVACY_PREFERENCES };
  }
}

export async function getPrivacyPreferences(userId: string): Promise<PrivacyPreferences> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PRIVACY_PREFERENCE_KEY)))
    .limit(1);
  return parsePreferences(row?.value);
}

export async function updatePrivacyPreferences(
  userId: string,
  updates: Partial<PrivacyPreferences>
): Promise<PrivacyPreferences> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db.transaction((tx) => {
    const row = tx
      .select({ value: userPreferences.value })
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PRIVACY_PREFERENCE_KEY)))
      .limit(1)
      .get();
    const current = parsePreferences(row?.value);
    const next: PrivacyPreferences = {
      marketing: updates.marketing ?? current.marketing,
      analytics: updates.analytics ?? current.analytics,
    };
    const now = new Date();
    tx.insert(userPreferences).values({
      id: nanoid(),
      userId,
      key: PRIVACY_PREFERENCE_KEY,
      value: JSON.stringify(next),
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value: JSON.stringify(next), updatedAt: now },
    }).run();
    return next;
  });
}

export const PRIVACY_CONSENT_PREFERENCE_KEY = PRIVACY_PREFERENCE_KEY;
