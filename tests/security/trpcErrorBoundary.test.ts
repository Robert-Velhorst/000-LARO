import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, router } from '../../server/_core/trpc';

const boundaryRouter = router({
  routeFailure: publicProcedure.query(() => {
    throw new Error('Route crashed at /home/operator/private/case.ts:44');
  }),
  storageFailure: publicProcedure.query(() => {
    throw new Error('ENOENT: /srv/laro/evidence/client-secret/letter.pdf');
  }),
  databaseFailure: publicProcedure.query(() => {
    throw new Error('SQLITE_ERROR: SELECT password FROM users near private_table');
  }),
  providerFailure: publicProcedure.query(() => {
    throw new Error('HTTP 500 body={"private":"upstream body"} token=provider-secret');
  }),
  conflict: publicProcedure.query(() => {
    throw new TRPCError({ code: 'CONFLICT', message: 'The case changed; reload and try again.' });
  }),
  unavailable: publicProcedure.query(() => {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Database not available' });
  }),
  validation: publicProcedure
    .input(z.object({ email: z.string().email() }))
    .query(() => ({ ok: true })),
});

async function requestProcedure(path: keyof typeof boundaryRouter['_def']['procedures'], input?: unknown) {
  const suffix = input === undefined
    ? ''
    : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const correlationId = `corr-${String(path)}`;
  const req = new Request(`http://localhost/trpc/${String(path)}${suffix}`);
  const response = await fetchRequestHandler({
    endpoint: '/trpc',
    req,
    router: boundaryRouter,
    createContext: () => ({
      req: {} as never,
      res: {} as never,
      user: null,
      desktopScanner: false,
      correlationId,
    }),
  });
  return {
    response,
    body: await response.json() as any,
    correlationId,
  };
}

function errorJson(body: any) {
  return body.error?.json || body.error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('canonical tRPC client error boundary', () => {
  it.each([
    ['routeFailure', '/home/operator/private/case.ts:44'],
    ['storageFailure', '/srv/laro/evidence/client-secret/letter.pdf'],
    ['databaseFailure', 'SELECT password FROM users'],
    ['providerFailure', 'upstream body'],
  ] as const)('hides %s diagnostics and correlates the sanitized server log', async (path, secretDetail) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { response, body, correlationId } = await requestProcedure(path);
    const error = errorJson(body);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(500);
    expect(error.message).toBe('The request could not be completed. Please try again.');
    expect(error.data.publicCode).toBe('UNEXPECTED_FAILURE');
    expect(error.data.correlationId).toBe(correlationId);
    expect(error.data.stack).toBeUndefined();
    expect(serialized).not.toContain(secretDetail);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls[0])).toContain(correlationId);
  });

  it('preserves reviewed conflict and unavailable-state messages', async () => {
    const conflict = errorJson((await requestProcedure('conflict')).body);
    const unavailable = errorJson((await requestProcedure('unavailable')).body);
    expect(conflict.message).toBe('The case changed; reload and try again.');
    expect(conflict.data.publicCode).toBe('CONFLICT');
    expect(unavailable.message).toBe('Database not available');
    expect(unavailable.data.publicCode).toBe('SERVICE_UNAVAILABLE');
  });

  it('returns structured validation without the framework stack', async () => {
    const error = errorJson((await requestProcedure('validation', { email: 'not-an-email' })).body);
    expect(error.message).toBe('The request contains invalid values.');
    expect(error.data.publicCode).toBe('VALIDATION_ERROR');
    expect(error.data.validation.fieldErrors.email).toBeDefined();
    expect(error.data.stack).toBeUndefined();
  });
});
