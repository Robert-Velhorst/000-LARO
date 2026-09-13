import { afterEach, describe, expect, it, vi } from 'vitest';
import { COOKIE_NAME } from '../../shared/const';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('workspace session isolation', () => {
  it('preserves the default cookie for existing installations', async () => {
    vi.stubEnv('LARO_SESSION_COOKIE_NAME', '');
    const { sessionCookieName } = await import('../../server/sessionCookie');
    expect(sessionCookieName()).toBe(COOKIE_NAME);
  });

  it('separates two workspaces on different localhost ports', async () => {
    const { sessionCookieName } = await import('../../server/sessionCookie');
    vi.stubEnv('LARO_SESSION_COOKIE_NAME', 'laro_preview_session');
    const preview = sessionCookieName();
    vi.stubEnv('LARO_SESSION_COOKIE_NAME', 'laro_owner_session');
    expect(sessionCookieName()).not.toBe(preview);
  });

  it('rejects invalid cookie configuration instead of falling back', async () => {
    const { sessionCookieName } = await import('../../server/sessionCookie');
    vi.stubEnv('LARO_SESSION_COOKIE_NAME', 'invalid; cookie');
    expect(() => sessionCookieName()).toThrow('cookie name');
  });
});
