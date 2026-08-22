import { type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../shared/const";
import { ENV } from "./_core/env";
import { getUser } from "./db";
import { isDesktopScannerRequest } from "./desktopScannerAuth";

export type AuthScope = "session";

export interface TrpcContext {
  req: Request;
  res: Response;
  user: { id: string; name: string; role: string; email: string | null } | null;
  authScope?: AuthScope;
  desktopScanner: boolean;
}

type TokenClaims = { userId: string; iat?: number };

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
    try {
      const decoded = jwt.verify(sessionToken, ENV.JWT_SECRET, {
        algorithms: ["HS256"],
      }) as TokenClaims;
      const { isTokenRevoked } = await import("./sessionRevocation");
      if (!(await isTokenRevoked(decoded.userId, decoded.iat))) {
        userId = decoded.userId;
        authScope = "session";
      }
    } catch (error) {
      console.error("[Auth] Session verification failed:", error);
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
