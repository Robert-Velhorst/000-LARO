import { and, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from './db';
import { userPreferences } from './schema';
import { writeAuditLogOrThrow } from './audit';
import {
  PRIVACY_CONSENT_PREFERENCE_KEY,
  parsePrivacyPreferences,
  serializePrivacyPreferences,
  type PrivacyPreferences,
} from './privacyPreferenceValue';

function readPreferences(store: any, userId: string): { row: { id: string; value: string | null } | undefined; preferences: PrivacyPreferences } {
  const row = store
    .select({ id: userPreferences.id, value: userPreferences.value })
    .from(userPreferences)
    .where(and(
      eq(userPreferences.userId, userId),
      eq(userPreferences.key, PRIVACY_CONSENT_PREFERENCE_KEY),
    ))
    .limit(1)
    .get();
  return { row, preferences: parsePrivacyPreferences(row?.value) };
}

/** Read-only transaction helper used by optional-processing writers. */
export function isUsageAnalyticsEnabled(store: any, userId: string): boolean {
  return readPreferences(store, userId).preferences.analytics;
}

export async function getPrivacyPreferences(userId: string): Promise<PrivacyPreferences> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db.transaction((tx) => {
    const { row, preferences } = readPreferences(tx, userId);
    const canonicalValue = serializePrivacyPreferences(preferences);
    // Drop removed legacy fields (notably the unsupported marketing toggle)
    // without overwriting a newer concurrent preference revision.
    if (row && row.value !== canonicalValue) {
      tx.update(userPreferences)
        .set({ value: canonicalValue, updatedAt: new Date() })
        .where(eq(userPreferences.id, row.id))
        .run();
    }
    return preferences;
  });
}

export async function updatePrivacyPreferences(
  userId: string,
  updates: Partial<PrivacyPreferences>,
  options?: { mandatoryAudit?: boolean },
): Promise<PrivacyPreferences> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');
  return db.transaction((tx) => {
    const { row, preferences: current } = readPreferences(tx, userId);
    const next: PrivacyPreferences = {
      analytics: updates.analytics ?? current.analytics,
    };
    const value = serializePrivacyPreferences(next);
    const needsCanonicalization = Boolean(row && row.value !== value);
    if (next.analytics === current.analytics && !needsCanonicalization) return next;
    const now = new Date();
    tx.insert(userPreferences).values({
      id: nanoid(),
      userId,
      key: PRIVACY_CONSENT_PREFERENCE_KEY,
      value,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value, updatedAt: now },
    }).run();
    if (options?.mandatoryAudit && next.analytics !== current.analytics) {
      writeAuditLogOrThrow(tx, {
        userId,
        action: 'gdpr.consent_updated',
        entityType: 'user',
        entityId: userId,
        details: { from: current, to: next },
      });
    }
    return next;
  });
}

export { PRIVACY_CONSENT_PREFERENCE_KEY } from './privacyPreferenceValue';
export type { PrivacyPreferences } from './privacyPreferenceValue';
