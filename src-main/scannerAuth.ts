import { COOKIE_NAME } from "../shared/const";
import { MIN_DESKTOP_SCANNER_SECRET_LENGTH } from "../shared/desktopScannerAuth";

interface CookieStore {
  get(filter: { url: string; name: string }): Promise<Array<{ name: string; value: string }>>;
}

export async function getDesktopScannerAuth(options: {
  apiUrl: string;
  scannerSecret: string;
  cookieStore: CookieStore;
}): Promise<{ sessionCookie: string; scannerSecret: string }> {
  if (options.scannerSecret.length < MIN_DESKTOP_SCANNER_SECRET_LENGTH) {
    throw new Error("Desktop scanner authorization is unavailable");
  }
  const cookies = await options.cookieStore.get({ url: options.apiUrl, name: COOKIE_NAME });
  const sessionCookie = cookies.find((cookie) => cookie.name === COOKIE_NAME)?.value;
  if (!sessionCookie) throw new Error("Sign in to LARO before uploading evidence");
  return {
    sessionCookie: `${COOKIE_NAME}=${sessionCookie}`,
    scannerSecret: options.scannerSecret,
  };
}
