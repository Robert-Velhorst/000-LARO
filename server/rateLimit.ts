import { TRPCError } from "@trpc/server";

/**
 * Simple in-memory rate limiter
 * For production, consider using Redis for distributed rate limiting
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);
cleanupTimer.unref?.();

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
  message?: string;
}

/**
 * Rate limit middleware for tRPC procedures
 * @param identifier - Unique identifier for rate limiting (e.g., user ID, IP address)
 * @param config - Rate limit configuration
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig
): void {
  const now = Date.now();
  const key = `ratelimit:${identifier}`;
  
  let entry = rateLimitStore.get(key);
  
  if (!entry || entry.resetAt < now) {
    // Create new entry or reset expired entry
    entry = {
      count: 1,
      resetAt: now + config.windowMs,
    };
    rateLimitStore.set(key, entry);
    return;
  }
  
  // Increment count
  entry.count++;
  
  if (entry.count > config.maxRequests) {
    const resetIn = Math.ceil((entry.resetAt - now) / 1000);
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: config.message || `Rate limit exceeded. Try again in ${resetIn} seconds.`,
    });
  }
}

/**
 * Default rate limit configurations
 */
export const RATE_LIMITS = {
  // Authentication endpoints
  auth: {
    maxRequests: 10,
    windowMs: 15 * 60 * 1000, // 15 minutes
    message: "Too many authentication attempts. Please try again later.",
  },

  // Sending reset messages is intentionally tighter than general auth. This
  // limits mailbox abuse while still allowing a user to request a replacement
  // code when delivery is delayed.
  passwordResetRequest: {
    maxRequests: 3,
    windowMs: 15 * 60 * 1000, // 15 minutes
    message: "Too many password reset requests. Please try again later.",
  },

  // A six-digit reset code must never be an unbounded online guessing oracle.
  passwordResetVerify: {
    maxRequests: 10,
    windowMs: 15 * 60 * 1000, // 15 minutes
    message: "Too many password reset attempts. Please try again later.",
  },
  
  // Case creation
  caseCreate: {
    maxRequests: 5,
    windowMs: 60 * 60 * 1000, // 1 hour
    message: "Too many cases created. Please wait before creating more.",
  },
  
  // Document upload
  documentUpload: {
    maxRequests: 50,
    windowMs: 60 * 60 * 1000, // 1 hour
    message: "Upload limit reached. Please wait before uploading more documents.",
  },
  
  // AI analysis (expensive operations)
  aiAnalysis: {
    maxRequests: 20,
    windowMs: 60 * 60 * 1000, // 1 hour
    message: "AI analysis limit reached. Please wait before requesting more analyses.",
  },

  evidenceExport: {
    maxRequests: 10,
    windowMs: 5 * 60 * 1000,
    message: "Too many evidence export requests. Please use an existing link or wait briefly.",
  },
  
  // General API calls
  general: {
    maxRequests: 100,
    windowMs: 60 * 1000, // 1 minute
    message: "Too many requests. Please slow down.",
  },
  
  // Lawyer search
  lawyerSearch: {
    maxRequests: 30,
    windowMs: 60 * 1000, // 1 minute
    message: "Too many search requests. Please wait a moment.",
  },
};

/**
 * Phase 018 — convenience wrapper: derive the identifier from the tRPC context
 * and enforce a named limit, throwing TOO_MANY_REQUESTS when exceeded. The
 * `scope` keeps different actions in separate buckets for the same user.
 */
export function enforceRateLimit(
  ctx: { user?: { id: string } | null; req: any },
  scope: string,
  config: RateLimitConfig
): void {
  const identifier = `${scope}:${getRateLimitIdentifier(ctx as any)}`;
  checkRateLimit(identifier, config);
}

/**
 * Get rate limit identifier from context
 * Uses user ID if authenticated, otherwise IP address
 */
export function getRateLimitIdentifier(ctx: { user?: { id: string }; req: any }): string {
  if (ctx.user?.id) {
    return `user:${ctx.user.id}`;
  }
  
  // Fallback to IP address for unauthenticated requests
  const forwarded = ctx.req.headers['x-forwarded-for'];
  const forwardedChain = (Array.isArray(forwarded) ? forwarded : [forwarded])
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  // The nearest trusted reverse proxy appends the immediate peer at the right
  // edge. Prefer that value so a client-supplied leftmost entry cannot rotate
  // rate-limit identities while traffic is routed through ngrok.
  const ip = forwardedChain.at(-1) || ctx.req.socket.remoteAddress;
  
  return `ip:${ip || 'unknown'}`;
}

