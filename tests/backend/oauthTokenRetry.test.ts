import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeCodeForTokens, getAccountInfo, isRetryableOAuthNetworkError, refreshAccessToken } from '../../server/oauth2';
import { refreshGmailToken, refreshOutlookToken } from '../../server/emailOAuth';

function networkError(code: string): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
}

describe('OAuth token exchange network resilience', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('recognizes only DNS failures as safe token-exchange retries', () => {
    expect(isRetryableOAuthNetworkError(networkError('EAI_AGAIN'))).toBe(true);
    expect(isRetryableOAuthNetworkError(networkError('ENOTFOUND'))).toBe(true);
    expect(isRetryableOAuthNetworkError(networkError('ECONNRESET'))).toBe(false);
  });

  it('retries a temporary DNS lookup failure and completes the exchange', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(networkError('EAI_AGAIN'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const exchange = exchangeCodeForTokens('gmail', 'authorization-code', 'pkce-verifier');
    await vi.runAllTimersAsync();

    await expect(exchange).resolves.toMatchObject({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 3600,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it('does not retry an ambiguous transport failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(networkError('ECONNRESET'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeCodeForTokens('gmail', 'authorization-code', 'pkce-verifier'))
      .rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds every OAuth refresh request with a provider timeout', async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'google-client';
    process.env.MICROSOFT_OAUTH_CLIENT_ID = 'microsoft-client';
    process.env.MICROSOFT_OAUTH_CLIENT_SECRET = 'microsoft-secret';
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      access_token: 'refreshed-access',
      refresh_token: 'refreshed-refresh',
      expires_in: 3_600,
      token_type: 'Bearer',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await refreshAccessToken('gmail', 'refresh-one');
    await refreshAccessToken('outlook', 'refresh-two');
    await refreshGmailToken('refresh-three');
    await refreshOutlookToken('refresh-four');

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, request] of fetchMock.mock.calls) {
      expect(request).toMatchObject({ signal: expect.any(AbortSignal) });
    }
  });

  it('rejects oversized OAuth provider responses before parsing tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-length': String(256 * 1024 + 1) },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(exchangeCodeForTokens('gmail', 'authorization-code', 'pkce-verifier'))
      .rejects.toThrow('Google OAuth response exceeds the 256 KB response limit');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['gmail' as const, 'Google account lookup failed (502)'],
    ['outlook' as const, 'Microsoft account lookup failed (502)'],
  ])('preserves %s account HTTP errors when the provider body is not JSON', async (provider, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>upstream error</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })));

    await expect(getAccountInfo(provider, 'access-token')).rejects.toThrow(expected);
  });
});
