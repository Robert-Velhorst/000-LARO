import { type Request, type Response } from "express";
import { SESSION_COOKIE_NAME as COOKIE_NAME } from "./sessionCookie";
import { getUser } from "./db";
import { isDesktopScannerRequest } from "./desktopScannerAuth";
import { verifySessionToken } from "./sessionAuth";

export type AuthScope = "session";

export interface TrpcContext {
  req: Request;
  res: Response;
  user: { id: string; name: string; role: string; email: string | null } | null;
  authScope?: AuthScope;
  desktopScanner: boolean;
}

export const createContext = async ({
  req,
  res,
}: {
  req: Request;
  res: Response;
}): Promise<TrpcContext> => {
  const sessionToken = req.cookies[COOKIE_NAME];
  let userId: string | null = null;
  let authScope: AuthScope | undefined;
  const desktopScanner = isDesktopScannerRequest(req);

  if (sessionToken) {
    const claims = await verifySessionToken(sessionToken);
    if (claims) {
      userId = claims.userId;
      authScope = "session";
    }
  }

  if (!userId) return { req, res, user: null, desktopScanner: false };

  try {
    const user = await getUser(userId);
    if (!user) return { req, res, user: null, desktopScanner: false };

    return {
      req,
      res,
      user: {
        id: user.id,
        name: user.name || "Anonymous",
        role: user.role || "user",
        email: user.email || null,
      },
      authScope,
      desktopScanner,
    };
  } catch (error) {
    console.error("[Auth] Session verification failed:", error);
    return { req, res, user: null, desktopScanner: false };
  }
};
