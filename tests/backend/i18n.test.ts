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
    expect(t('reconstruction.openSourceNamed', 'nl', { title: 'Besluit.pdf' })).toBe(
      'Brondocument Besluit.pdf openen',
    );
    expect(t('reconstruction.openSourceNamed', 'en', { title: 'Decision.pdf' })).toBe(
      'Open source document Decision.pdf',
    );
    expect(t('sources.accessVerified', 'nl', { kind: 'Gmail', time: '10:30' })).toBe(
      'Toegang tot Gmail gecontroleerd om 10:30',
    );
    expect(t('publicRecords.research.recordedMany', 'nl', { count: 2 })).toBe(
      '2 overeenkomende resultaten vastgelegd voor deze begrensde zoekopdracht.',
    );
    expect(t('coverage.tabs.records', 'nl', { count: 3 })).toBe('Mogelijke records (3)');
    expect(t('coverage.summary', 'en', {
      inputs: 3,
      available: 1,
      unavailable: 0,
      external: 1,
      unreviewed: 2,
    })).toBe(
      'Inventory — input records: 3; managed sources available: 1; unavailable: 0; external references unverified: 1; records without an explicit review marker: 2.',
    );
    expect(t('coverage.unknownDetail.missing_context', 'nl', { count: 1 })).toBe(
      'Te verifiëren items voor communicatie of mogelijk relevante records: 1.',
    );
    expect(t('search.appliedPreset', 'nl', { name: 'Deze week' })).toBe(
      'Snelkeuze toegepast: Deze week',
    );
    expect(t('search.saveFailed', 'en', { error: 'Network unavailable' })).toBe(
      'Failed to save search: Network unavailable',
    );
    expect(t('case.list.countOne', 'nl', { count: 1 })).toBe('1 dossier');
    expect(t('case.list.countMany', 'en', { count: 2 })).toBe('2 cases');
    expect(t('case.list.actions', 'nl', { name: 'Voorbeeldzaak' })).toBe(
      'Dossieracties: Voorbeeldzaak',
    );
    expect(t('inbox.progress', 'nl', { done: 1, total: 2 })).toBe('1 / 2 verwerkt');
    expect(t('inbox.lines', 'en', { start: 4, end: 8 })).toBe('Lines 4-8');
    expect(t('inbox.downloadNamed', 'nl', { name: 'besluit.pdf' })).toBe(
      'Downloaden: besluit.pdf',
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
