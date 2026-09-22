import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { z } from 'zod';
import { COOKIE_NAME } from '../../shared/const';
import { resolveScannerOwner } from '../../src-main/scannerOwner';

describe('authenticated scanner owner binding', () => {
  const sessions = new Map([
    ['session-a', 'owner-a'],
    ['session-b', 'owner-b'],
  ]);
  const cases = new Map([
    ['case-a', 'owner-a'],
    ['case-b', 'owner-b'],
  ]);
  const t = initTRPC.context<{ ownerId: string | null }>().create({ transformer: superjson });
  const router = t.router({
    auth: t.router({ me: t.procedure.query(({ ctx }) => ctx.ownerId ? { id: ctx.ownerId } : null) }),
    cases: t.router({
      byId: t.procedure.input(z.string()).query(({ ctx, input }) =>
        cases.get(input) === ctx.ownerId ? { id: input, userId: ctx.ownerId } : null),
    }),
  });
  let server: Server;
  let apiUrl: string;

  beforeAll(async () => {
    const handler = createHTTPHandler({
      router,
      createContext: ({ req }) => {
        const cookie = req.headers.cookie?.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))?.[1];
        return { ownerId: cookie ? sessions.get(cookie) ?? null : null };
      },
    });
    server = createServer((req, res) => {
      req.url = req.url?.replace(/^\/api\/trpc\//, '/');
      handler(req, res);
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Scanner owner test server did not listen');
    apiUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    });
  });

  it('captures the current account and refuses a live cookie replacement', async () => {
    let cookie = 'session-a';
    const cookieStore = { get: vi.fn(async () => [{ name: COOKIE_NAME, value: cookie }]) };
    const owner = await resolveScannerOwner({
      apiUrl, cookieStore, scannerSecret: '', remote: true, caseId: 'case-a',
    });
    expect(owner.ownerId).toBe('owner-a');
    expect(await owner.getAuth()).toEqual({ sessionCookie: `${COOKIE_NAME}=session-a`, scannerSecret: '' });

    cookie = 'session-b';
    await expect(owner.assertCurrent('case-a')).rejects.toThrow(/session changed/i);
    await expect(owner.getAuth()).rejects.toThrow(/session changed/i);
  });

  it('refuses another account\'s case and a revoked original session', async () => {
    let cookie = 'session-a';
    const cookieStore = { get: async () => [{ name: COOKIE_NAME, value: cookie }] };
    await expect(resolveScannerOwner({
      apiUrl, cookieStore, scannerSecret: '', remote: true, caseId: 'case-b',
    })).rejects.toThrow(/case is unavailable/i);

    const owner = await resolveScannerOwner({
      apiUrl, cookieStore, scannerSecret: '', remote: true, caseId: 'case-a',
    });
    sessions.delete('session-a');
    try {
      await expect(owner.assertCurrent('case-a')).rejects.toThrow(/no longer active/i);
    } finally {
      sessions.set('session-a', 'owner-a');
      cookie = 'session-a';
    }
  });
});
