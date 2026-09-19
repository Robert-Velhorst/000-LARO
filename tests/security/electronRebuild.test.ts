import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('portable native SQLite packaging', () => {
  it('uses the N-API release that ships native binaries for every supported desktop platform', () => {
    const dependency = JSON.parse(readFileSync(
      path.join(ROOT, 'node_modules/better-sqlite3/package.json'),
      'utf8',
    ));
    const windows = readFileSync(path.join(
      ROOT,
      'node_modules/better-sqlite3/prebuilds/win32-x64.node',
    ));
    const linux = readFileSync(path.join(
      ROOT,
      'node_modules/better-sqlite3/prebuilds/linux-x64.node',
    ));

    expect(dependency.version).toMatch(/^13\./);
    expect(dependency.gypfile).toBe(false);
    expect(windows.subarray(0, 2).toString('ascii')).toBe('MZ');
    expect([...linux.subarray(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  });

  it('keeps electron-builder from replacing the shipped cross-platform N-API binaries', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies['better-sqlite3']).toMatch(/^\^13\./);
    expect(pkg.devDependencies['@electron/rebuild']).toBeUndefined();
    expect(pkg.scripts['rebuild:electron']).toBe('npm rebuild better-sqlite3');
    expect(pkg.scripts['verify:packaged:native']).toBe('node scripts/verify-packaged-native.mjs');
    expect(pkg.build.npmRebuild).toBe(false);
  });
});
