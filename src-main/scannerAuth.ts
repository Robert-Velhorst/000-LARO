import { COOKIE_NAME } from "../shared/const";
import {
  DESKTOP_SCANNER_HEADER,
  MIN_DESKTOP_SCANNER_SECRET_LENGTH,
} from "../shared/desktopScannerAuth";

interface CookieStore {
  get(filter: { url: string; name: string }): Promise<Array<{ name: string; value: string }>>;
}

export async function getDesktopScannerAuth(options: {
  cookieUrl: string;
  scannerSecret: string;
  cookieStore: CookieStore;
}): Promise<{ sessionCookie: string; scannerSecret: string }> {
  if (options.scannerSecret.length < MIN_DESKTOP_SCANNER_SECRET_LENGTH) {
    throw new Error("Desktop scanner authorization is unavailable");
  }
  const cookies = await options.cookieStore.get({ url: options.cookieUrl, name: COOKIE_NAME });
  const sessionCookie = cookies.find((cookie) => cookie.name === COOKIE_NAME)?.value;
  if (!sessionCookie) throw new Error("Sign in to LARO before uploading evidence");
  return {
    sessionCookie: `${COOKIE_NAME}=${sessionCookie}`,
    scannerSecret: options.scannerSecret,
  };
}

export function createDesktopScannerHeaders(
  resolveAuth: () => Promise<{ sessionCookie: string; scannerSecret: string }>,
): () => Promise<Record<string, string>> {
  return async () => {
    const auth = await resolveAuth();
    return {
      Cookie: auth.sessionCookie,
      [DESKTOP_SCANNER_HEADER]: auth.scannerSecret,
    };
  };
}
