import { createServer, type Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';
import oauth2CallbacksRouter from '../../server/oauth2Callbacks';
import { beginOAuthFlowAsync } from '../../server/oauth2';
import { cookieMiddleware } from '../../server/cookieMiddleware';

const suite = sqliteAvailable ? describe : describe.skip;
const nativeFetch = globalThis.fetch;

suite('OAuth initiating-browser binding', () => {
  let app: TestApp;
  let server: Server;
  let origin: string;
  const attacker = { id: 'OAUTH_INITIATOR', name: 'Initiator', role: 'user', email: 'initiator@example.com' };

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_ID = 'oauth-session-binding-client';
    process.env.GOOGLE_CLIENT_SECRET = 'oauth-session-binding-secret';
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'oauth-session-binding-client';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'oauth-session-binding-secret';
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(attacker));
    const expressApp = express();
    expressApp.use(cookieMiddleware);
    expressApp.use(oauth2CallbacksRouter);
    server = createServer(expressApp);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OAuth test server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    process.env.OAUTH_REDIRECT_BASE_URL = origin;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    app?.cleanup();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });

  it('rejects another browser, provider mismatch, start replay, and callback replay without linking credentials', async () => {
    const providerCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith(origin)) return nativeFetch(input, init);
      providerCalls.push(url);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({
          access_token: 'provider-access-token',
          refresh_token: 'provider-refresh-token',
          expires_in: '3600',
          token_type: 'Bearer',
          scope: 'openid email https://www.googleapis.com/auth/gmail.readonly',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        return new Response(JSON.stringify({ email: 'provider-owner@example.com', name: 'Provider Owner' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unexpected provider URL ${url}`);
    }));

    const startUrl = await beginOAuthFlowAsync('gmail', attacker.id, 'electron-renderer-session');
    const startResponse = await fetch(startUrl, { redirect: 'manual' });
    expect(startResponse.status).toBe(302);
    const bindingCookie = startResponse.headers.get('set-cookie')?.split(';')[0];
    expect(bindingCookie).toMatch(/^laro_oauth_gmail_binding=/);
    const providerUrl = new URL(startResponse.headers.get('location')!);
    expect(providerUrl.hostname).toBe('accounts.google.com');
    expect(providerUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = providerUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    const repeatedStart = await fetch(startUrl, { redirect: 'manual' });
    expect(repeatedStart.status).toBe(400);

    const victimCallback = await fetch(
      `${origin}/api/oauth/gmail/callback?code=victim-provider-code&state=${encodeURIComponent(state!)}`,
    );
    expect(victimCallback.status).toBe(400);
    expect(providerCalls).toHaveLength(0);

    const wrongProvider = await fetch(
      `${origin}/api/oauth/outlook/callback?code=victim-provider-code&state=${encodeURIComponent(state!)}`,
      { headers: { cookie: bindingCookie! } },
    );
    expect(wrongProvider.status).toBe(400);
    expect(providerCalls).toHaveLength(0);

    const ownerCallback = await fetch(
      `${origin}/api/oauth/gmail/callback?code=owner-provider-code&state=${encodeURIComponent(state!)}`,
      { headers: { cookie: bindingCookie! } },
    );
    expect(ownerCallback.status).toBe(200);
    expect(providerCalls).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://www.googleapis.com/oauth2/v2/userinfo',
    ]);
    const connected = await app.db.select().from(app.schema.emailAccounts).where(and(
      eq(app.schema.emailAccounts.userId, attacker.id),
      eq(app.schema.emailAccounts.provider, 'gmail'),
    ));
    expect(connected).toHaveLength(1);
    expect(connected[0].email).toBe('provider-owner@example.com');

    const replay = await fetch(
      `${origin}/api/oauth/gmail/callback?code=replayed-code&state=${encodeURIComponent(state!)}`,
      { headers: { cookie: bindingCookie! } },
    );
    expect(replay.status).toBe(400);
    expect(providerCalls).toHaveLength(2);
  });
});
