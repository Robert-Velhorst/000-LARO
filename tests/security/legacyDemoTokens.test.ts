import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The legacy router and this regression share the same statically imported verifier.
const { authenticateToken } = createRequire(import.meta.url)('../../legacy-token-verifier.cjs');
const secret = 'legacy-demo-test-secret-with-at-least-32-bytes';
beforeAll(() => vi.stubEnv('JWT_SECRET', secret));
afterAll(() => vi.unstubAllEnvs());

function signedToken(role: string) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'user@example.com', role, exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

function verify(token: string) {
  const req: any = { cookies: { authToken: token } };
  let status: number | undefined;
  let accepted = false;
  const res = { status(value: number) { status = value; return this; }, json() { return this; } };
  authenticateToken(req, res, () => { accepted = true; });
  return { accepted, status, user: req.user };
}

describe('legacy demo token privileges', () => {
  it('rejects a correctly signed pre-upgrade investor token before its expiry', () => {
    const result = verify(signedToken('investor'));
    expect(result.accepted).toBe(false);
    expect(result.status).toBe(403);
    expect(result.user).toBeUndefined();
  });

  it('continues accepting correctly signed ordinary user tokens', () => {
    const result = verify(signedToken('user'));
    expect(result.accepted).toBe(true);
    expect(result.user).toEqual({ email: 'user@example.com', role: 'user' });
  });

  it('rejects a tampered signature even for an ordinary user claim', () => {
    expect(verify(`${signedToken('user')}tampered`).accepted).toBe(false);
  });
});
