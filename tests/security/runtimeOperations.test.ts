import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

describe('production runtime operations', () => {
  it('runs backup and live acceptance through compiled fallbacks', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const runner = readFileSync(path.join(ROOT, 'scripts/run-built-operation.mjs'), 'utf8');
    const serverConfig = JSON.parse(readFileSync(path.join(ROOT, 'tsconfig.server.json'), 'utf8'));
    const dockerfile = readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

    expect(pkg.scripts['db:backup']).toContain('run-built-operation.mjs backup');
    expect(pkg.scripts['acceptance:providers']).toContain('run-built-operation.mjs acceptance:providers');
    expect(runner).toContain('dist/server/scripts/backup.js');
    expect(runner).toContain('dist/server/server/liveProviderAcceptance.js');
    expect(serverConfig.include).toContain('scripts/backup.ts');
    expect(dockerfile).toContain('COPY scripts/run-built-operation.mjs ./scripts/run-built-operation.mjs');
  });

  it('packages and initializes the Windows DPAPI provider reader before the server import', () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const main = readFileSync(path.join(ROOT, 'src-main/index.ts'), 'utf8');
    const reader = readFileSync(path.join(ROOT, 'scripts/read-protected-provider-config.ps1'), 'utf8');
    const configuredResource = pkg.build.extraResources.find(
      (entry: { from?: string }) => entry.from === 'scripts/read-protected-provider-config.ps1',
    );

    expect(configuredResource).toBeTruthy();
    expect(main.indexOf('loadProtectedProviderConfig')).toBeLessThan(
      main.indexOf("await import('../server/index')"),
    );
    expect(reader).toContain('ConvertTo-SecureString');
    expect(reader).toContain('ConvertTo-Json -Compress');
  });
});
