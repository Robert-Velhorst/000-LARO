import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { normalizeDesktopServerUrl, remoteScannerDatabaseName, resolveDesktopConnection } from '../../src-main/remoteConnection';

const directories: string[] = [];
function profile() {
  const directory = mkdtempSync(path.join(tmpdir(), 'laro-remote-connection-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('desktop server selection', () => {
  it('keeps an unconfigured installation local and remembers an explicit server', () => {
    const userDataPath = profile();
    expect(resolveDesktopConnection({ userDataPath, argv: [] })).toBeNull();
    expect(resolveDesktopConnection({ userDataPath, argv: ['--server-url=https://laro.example.test/'] })).toBe('https://laro.example.test');
    expect(resolveDesktopConnection({ userDataPath, argv: [] })).toBe('https://laro.example.test');
    expect(resolveDesktopConnection({ userDataPath, argv: ['--local'] })).toBeNull();
    expect(resolveDesktopConnection({ userDataPath, argv: [] })).toBeNull();
  });

  it.each([
    'http://remote.example.test', 'file:///tmp/app', 'javascript:alert(1)',
    'https://user:password@laro.example.test', 'https://laro.example.test/path',
    'https://laro.example.test/?token=secret', 'https://laro.example.test/#fragment',
  ])('rejects an unsafe or unsupported server address: %s', (address) => {
    expect(() => normalizeDesktopServerUrl(address)).toThrow();
  });

  it('allows loopback HTTP for an isolated runtime verification', () => {
    expect(normalizeDesktopServerUrl('http://127.0.0.1:3199/')).toBe('http://127.0.0.1:3199');
    expect(normalizeDesktopServerUrl('http://[::1]:3199')).toBe('http://[::1]:3199');
  });

  it('fails closed on corrupt configuration without replacing local user data', () => {
    const userDataPath = profile();
    const database = path.join(userDataPath, 'laro-server.sqlite');
    writeFileSync(database, 'existing local workspace');
    writeFileSync(path.join(userDataPath, 'server-connection.json'), '{invalid');
    expect(() => resolveDesktopConnection({ userDataPath, argv: [] })).toThrow();
    resolveDesktopConnection({ userDataPath, argv: ['--server-url=https://laro.example.test'] });
    expect(readFileSync(database, 'utf8')).toBe('existing local workspace');
  });

  it('separates local scanner state by server and rejects conflicting selections', () => {
    expect(remoteScannerDatabaseName('https://one.example.test')).not.toBe(remoteScannerDatabaseName('https://two.example.test'));
    expect(remoteScannerDatabaseName('https://one.example.test/')).toBe(remoteScannerDatabaseName('https://one.example.test'));
    expect(() => resolveDesktopConnection({ userDataPath: profile(), argv: ['--local', '--server-url=https://one.example.test'] })).toThrow();
  });
});
