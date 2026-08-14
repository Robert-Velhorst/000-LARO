import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProtectedProviderConfig } from '../../src-main/providerConfig';

const temporaryDirectories: string[] = [];

function userDataDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'laro-provider-config-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows protected provider configuration', () => {
  it('does nothing on non-Windows platforms', () => {
    expect(loadProtectedProviderConfig({
      userDataPath: userDataDirectory(),
      isPackaged: false,
      resourcesPath: process.cwd(),
      platform: 'linux',
      environment: {},
    })).toEqual({ loaded: false, appliedKeys: [] });
  });

  it('loads the canonical user-data store without overriding explicit environment values', () => {
    const userDataPath = userDataDirectory();
    writeFileSync(path.join(userDataPath, 'provider-config.json'), '{}');
    const environment: NodeJS.ProcessEnv = { SMTP_HOST: 'explicit.example.test' };
    const result = loadProtectedProviderConfig({
      userDataPath,
      isPackaged: false,
      resourcesPath: process.cwd(),
      platform: 'win32',
      environment,
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify({
          GOOGLE_CLIENT_ID: '123-client.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'valid_secret_value_123',
          OAUTH_REDIRECT_BASE_URL: 'http://127.0.0.1:8768',
          EMAIL_PROVIDER: 'smtp',
          SMTP_HOST: 'protected.example.test',
          SMTP_PORT: '587',
          SMTP_USER: 'owner@example.test',
          SMTP_PASS: 'protected-password',
          SMTP_FROM: 'owner@example.test',
          SMTP_STARTTLS: 'true',
        }),
      }),
    });

    expect(result.loaded).toBe(true);
    expect(result.configPath).toBe(path.join(userDataPath, 'provider-config.json'));
    expect(result.appliedKeys).not.toContain('SMTP_HOST');
    expect(environment.SMTP_HOST).toBe('explicit.example.test');
    expect(environment.GOOGLE_CLIENT_ID).toBe('123-client.apps.googleusercontent.com');
    expect(environment.OAUTH_REDIRECT_BASE_URL).toBe('http://127.0.0.1:8768');
    expect(environment.SMTP_PASS).toBe('protected-password');
  });

  it('rejects non-loopback desktop OAuth callback origins', () => {
    const userDataPath = userDataDirectory();
    writeFileSync(path.join(userDataPath, 'provider-config.json'), '{}');
    expect(() => loadProtectedProviderConfig({
      userDataPath,
      isPackaged: false,
      resourcesPath: process.cwd(),
      platform: 'win32',
      environment: {},
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify({ OAUTH_REDIRECT_BASE_URL: 'https://example.test' }),
      }),
    })).toThrow('invalid OAuth redirect origin');
  });

  it('rejects fields that could inject arbitrary process environment', () => {
    const userDataPath = userDataDirectory();
    writeFileSync(path.join(userDataPath, 'provider-config.json'), '{}');
    expect(() => loadProtectedProviderConfig({
      userDataPath,
      isPackaged: false,
      resourcesPath: process.cwd(),
      platform: 'win32',
      environment: {},
      spawn: () => ({ status: 0, stdout: JSON.stringify({ NODE_OPTIONS: '--inspect' }) }),
    })).toThrow('unsupported field');
  });

  it('fails closed when an explicit provider path is missing', () => {
    const userDataPath = userDataDirectory();
    expect(() => loadProtectedProviderConfig({
      userDataPath,
      isPackaged: false,
      resourcesPath: process.cwd(),
      platform: 'win32',
      environment: { LARO_PROVIDER_CONFIG_PATH: path.join(userDataPath, 'missing.json') },
    })).toThrow('does not point to an existing file');
  });
});
