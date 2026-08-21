import { initTRPC, TRPCError } from "@trpc/server";
import superjson from 'superjson';
import { ZodError } from 'zod';
import type { TrpcContext } from '../context';

/**
 * Phase 009 — API contract and error envelope.
 *
 * Every error returned to the client carries a stable, predictable shape so the
 * frontend can render it consistently:
 *   error.data = {
 *     code:        tRPC code string (e.g. "UNAUTHORIZED", "FORBIDDEN"),
 *     httpStatus:  numeric HTTP status,
 *     path:        the procedure path that failed,
 *     validation:  flattened Zod field errors when the failure was input validation,
 *   }
 * Internal error details/stack are never leaked; validation errors are surfaced
 * in a structured `validation` field instead of a raw message.
 */
const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        validation:
          error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router          = t.router;
export const publicProcedure = t.procedure;
export const middleware       = t.middleware;
export const mergeRouters     = t.mergeRouters;

// Protected procedure — requires authenticated user
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const evidenceUploadProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Not authenticated' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Admin access required' });
  }
  return next({ ctx });
});
