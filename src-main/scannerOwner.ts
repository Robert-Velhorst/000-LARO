import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '../server/routers';
import { getDesktopScannerAuth, getRemoteUploadAuth } from './scannerAuth';

interface CookieStore {
  get(filter: { url: string; name: string }): Promise<Array<{ name: string; value: string }>>;
}

export interface ScannerOwner {
  ownerId: string;
  assertCurrent: (caseId?: string) => Promise<void>;
  getAuth: () => Promise<{ sessionCookie: string; scannerSecret: string }>;
}

/** Resolve identity from the browser session, never from a renderer argument. */
export async function resolveScannerOwner(options: {
  apiUrl: string;
  cookieStore: CookieStore;
  cookieName?: string;
  scannerSecret: string;
  remote: boolean;
  caseId?: string;
}): Promise<ScannerOwner> {
  const resolveAuth = () => options.remote
    ? getRemoteUploadAuth({ cookieUrl: options.apiUrl, cookieStore: options.cookieStore })
    : getDesktopScannerAuth({
        cookieUrl: options.apiUrl,
        cookieName: options.cookieName,
        scannerSecret: options.scannerSecret,
        cookieStore: options.cookieStore,
      });
  const initialAuth = await resolveAuth();
  const client = createTRPCProxyClient<AppRouter>({
    transformer: superjson,
    links: [httpBatchLink({
      url: `${options.apiUrl.replace(/\/$/, '')}/api/trpc`,
      headers: () => ({ Cookie: initialAuth.sessionCookie }),
    })],
  });
  const user = await client.auth.me.query();
  if (!user?.id) throw new Error('Sign in to LARO before using the desktop scanner');
  const ownerId = user.id;

  const assertCurrent = async (caseId?: string): Promise<void> => {
    const currentAuth = await resolveAuth();
    if (currentAuth.sessionCookie !== initialAuth.sessionCookie) {
      throw new Error('Scanner session changed. Sign in and reopen the scan.');
    }
    const current = await client.auth.me.query();
    if (current?.id !== ownerId) throw new Error('Scanner session is no longer active');
    if (caseId) {
      const ownedCase = await client.cases.byId.query(caseId);
      if (!ownedCase || ownedCase.userId !== ownerId) throw new Error('Scanner case is unavailable');
    }
  };
  await assertCurrent(options.caseId);
  // Return the captured owner's credential, never a newly switched account's
  // cookie in the gap between an authorization check and request dispatch.
  const getAuth = async () => {
    await assertCurrent();
    return initialAuth;
  };
  return { ownerId, assertCurrent, getAuth };
}
