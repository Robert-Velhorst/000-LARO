export const PRIVACY_CONSENT_PREFERENCE_KEY = "privacy-consent";

export interface PrivacyPreferences {
  analytics: boolean;
}

export const DEFAULT_PRIVACY_PREFERENCES: Readonly<PrivacyPreferences> = {
  analytics: false,
};

export function parsePrivacyPreferences(value: string | null | undefined): PrivacyPreferences {
  if (!value) return { ...DEFAULT_PRIVACY_PREFERENCES };
  try {
    const parsed = JSON.parse(value) as Partial<PrivacyPreferences>;
    return { analytics: parsed.analytics === true };
  } catch {
    return { ...DEFAULT_PRIVACY_PREFERENCES };
  }
}

export function serializePrivacyPreferences(preferences: PrivacyPreferences): string {
  return JSON.stringify({ analytics: preferences.analytics === true });
}
