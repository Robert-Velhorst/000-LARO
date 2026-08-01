import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppVersion } from '../../server/_core/version';

const manifestPath = resolve(process.cwd(), 'package.json');

describe('resolveAppVersion', () => {
  it('prefers a meaningful runtime version', () => {
    expect(resolveAppVersion({ LARO_APP_VERSION: '2.0.0' }, manifestPath)).toBe('2.0.0');
  });

  it('falls back to the packaged manifest when compose supplies unknown', () => {
    expect(resolveAppVersion({ LARO_APP_VERSION: 'unknown' }, manifestPath)).toBe('1.3.0');
  });

  it('fails closed when neither runtime nor manifest metadata is available', () => {
    expect(resolveAppVersion({}, resolve(process.cwd(), 'missing-package.json'))).toBe('unknown');
  });
});
