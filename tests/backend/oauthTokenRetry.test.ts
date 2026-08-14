import { afterEach, describe, expect, it, vi } from 'vitest';
import { exchangeCodeForTokens, isRetryableOAuthNetworkError } from '../../server/oauth2';

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
});
