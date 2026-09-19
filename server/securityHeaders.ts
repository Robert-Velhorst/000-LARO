import type { RequestHandler } from "express";
import { ENV } from "./_core/env";

/**
 * Security headers shared by the production server and its HTTP contract tests.
 * Keeping this as one middleware prevents a test-only replica from drifting from
 * the live Express path.
 */
export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader(
    "Cross-Origin-Opener-Policy",
    req.path.startsWith("/api/") ? "same-origin" : "same-origin-allow-popups",
  );
  res.setHeader(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=(), payment=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self' http://localhost:3000 ws://localhost:3000",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
  if (ENV.isProd && (req.secure || req.headers["x-forwarded-proto"] === "https")) {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
};
