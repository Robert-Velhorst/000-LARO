import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { systemConfig } from "./schema";
import type { RateLimitConsumeInput, RateLimitConsumeResult } from './rateLimitStore';
import { createRedisRateLimitStore } from './rateLimitStore';
import { getHostedRedisScriptClient } from './hostedRedis';
import { ENV } from './_core/env';

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

  bulkImport: {
    maxRequests: 5,
    windowMs: 15 * 60 * 1000,
    message: "Too many import requests. Please wait before importing another file.",
  },

  providerOperation: {
    maxRequests: 30,
    windowMs: 60 * 1000,
    message: "Too many provider requests. Please wait a moment.",
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

export async function enforceSharedRateLimit(options: {
  store: { consume(input: RateLimitConsumeInput): Promise<RateLimitConsumeResult> };
  key: string;
  config: RateLimitConfig;
}): Promise<void> {
  const result = await options.store.consume({
    key: options.key,
    maxRequests: options.config.maxRequests,
    windowMs: options.config.windowMs,
  });
  if (!result.allowed) {
    const resetIn = Math.max(1, Math.ceil(result.resetAfterMs / 1_000));
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: options.config.message || `Rate limit exceeded. Try again in ${resetIn} seconds.`,
    });
  }
}

/** Persist expensive-operation limits so a service restart cannot reset them. */
export async function enforcePersistentRateLimit(
  ctx: { user?: { id: string } | null; req: any },
  scope: string,
  config: RateLimitConfig,
): Promise<void> {
  const identifier = getRateLimitIdentifier(ctx as any);
  const digest = createHash("sha256").update(`${scope}:${identifier}`).digest("hex");
  const configKey = `rate-limit:${scope}:${digest}`;
  if (ENV.isHosted) {
    const client = await getHostedRedisScriptClient();
    await enforceSharedRateLimit({
      store: createRedisRateLimitStore(client),
      key: `laro:${configKey}`,
      config,
    });
    return;
  }

  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database not available" });
  const now = Date.now();

  db.transaction((tx) => {
    const row = tx.select({ value: systemConfig.configValue })
      .from(systemConfig)
      .where(eq(systemConfig.configKey, configKey))
      .get();
    let current: RateLimitEntry | null = null;
    try {
      const parsed = row?.value ? JSON.parse(row.value) as Partial<RateLimitEntry> : null;
      if (parsed && Number.isSafeInteger(parsed.count) && Number.isSafeInteger(parsed.resetAt)) {
        current = { count: Number(parsed.count), resetAt: Number(parsed.resetAt) };
      }
    } catch {
      current = null;
    }

    const next = !current || current.resetAt <= now
      ? { count: 1, resetAt: now + config.windowMs }
      : { count: current.count + 1, resetAt: current.resetAt };
    if (next.count > config.maxRequests) {
      const resetIn = Math.max(1, Math.ceil((next.resetAt - now) / 1000));
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: config.message || `Rate limit exceeded. Try again in ${resetIn} seconds.`,
      });
    }

    tx.insert(systemConfig).values({
      configKey,
      configValue: JSON.stringify(next),
      updatedAt: new Date(now),
    }).onConflictDoUpdate({
      target: systemConfig.configKey,
      set: { configValue: JSON.stringify(next), updatedAt: new Date(now) },
    }).run();
  });
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

