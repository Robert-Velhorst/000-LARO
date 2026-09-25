import type { NextFunction, Request, Response } from "express";

const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,256}$/;
const MAX_COOKIES = 100;

export function parseRequestCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (!header) return cookies;

  for (const item of header.split(";").slice(0, MAX_COOKIES)) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    const name = item.slice(0, separator).trim();
    if (!COOKIE_NAME_PATTERN.test(name) || Object.hasOwn(cookies, name)) continue;
    const encoded = item.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(encoded);
    } catch {
      cookies[name] = encoded;
    }
  }
  return cookies;
}

export function cookieMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.cookies = parseRequestCookies(req.headers.cookie);
  next();
}
