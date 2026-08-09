/**
 * Phase 057 — i18n foundation tests (pure).
 */
import { describe, it, expect } from 'vitest';
import { t, normalizeLocale, isLocale, localeTag, messages } from '../../shared/i18n';

describe('Phase 057 — i18n', () => {
  it('translates the same key to NL and EN', () => {
    expect(t('case.create', 'nl')).toBe('Zaak aanmaken');
    expect(t('case.create', 'en')).toBe('Create case');
  });
  it('falls back to English then the key for unknown/missing', () => {
    expect(t('unknown.key', 'nl')).toBe('unknown.key');
  });
  it('interpolates variables', () => {
    expect(t('scanner.filesFound', 'en', { count: 3, size: '9 KB' })).toBe(
      '3 eligible files found (9 KB)',
    );
  });
  it('normalizes locale strings', () => {
    expect(normalizeLocale('nl-NL')).toBe('nl');
    expect(normalizeLocale('en_US')).toBe('en');
    expect(normalizeLocale('fr')).toBe('nl'); // default
    expect(normalizeLocale(undefined)).toBe('nl');
  });
  it('every catalog entry has both nl and en', () => {
    for (const [k, v] of Object.entries(messages)) {
      expect(v.nl, `nl missing for ${k}`).toBeTruthy();
      expect(v.en, `en missing for ${k}`).toBeTruthy();
    }
  });
  it('isLocale guards correctly', () => {
    expect(isLocale('nl')).toBe(true);
    expect(isLocale('de')).toBe(false);
  });
  it('maps application locales to stable Intl language tags', () => {
    expect(localeTag('nl')).toBe('nl-NL');
    expect(localeTag('en')).toBe('en-US');
  });
});
