import { initTRPC, TRPCError } from "@trpc/server";
import { randomUUID } from 'crypto';
import superjson from 'superjson';
import { ZodError } from 'zod';
import type { TrpcContext } from '../context';
import { logError } from '../errorHandler';
import { roleSatisfies } from './roles';

const REVIEWED_DOMAIN_CODES = new Set<TRPCError['code']>([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_SUPPORTED',
  'CONFLICT',
  'PRECONDITION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'UNPROCESSABLE_CONTENT',
  'TOO_MANY_REQUESTS',
  'NOT_IMPLEMENTED',
]);

const REVIEWED_UNAVAILABLE_MESSAGES = new Set([
  'Database not available',
  'Database connection not available. Please try again later.',
  'Case storage is unavailable',
]);

type PublicError = {
  message: string;
  publicCode: string;
  unexpected: boolean;
  validation: ReturnType<ZodError['flatten']> | null;
};

function publicError(error: TRPCError): PublicError {
  if (error.cause instanceof ZodError) {
    return {
      message: 'The request contains invalid values.',
      publicCode: 'VALIDATION_ERROR',
      unexpected: false,
      validation: error.cause.flatten(),
    };
  }
  if (REVIEWED_DOMAIN_CODES.has(error.code)) {
    return {
      message: error.message,
      publicCode: error.code,
      unexpected: false,
      validation: null,
    };
  }
  if (error.code === 'INTERNAL_SERVER_ERROR' && REVIEWED_UNAVAILABLE_MESSAGES.has(error.message)) {
    return {
      message: error.message,
      publicCode: 'SERVICE_UNAVAILABLE',
      unexpected: false,
      validation: null,
    };
  }
  return {
    message: 'The request could not be completed. Please try again.',
    publicCode: 'UNEXPECTED_FAILURE',
    unexpected: true,
    validation: null,
  };
}

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
  errorFormatter({ shape, error, path, ctx }) {
    const publicResult = publicError(error);
    const correlationId = ctx?.correlationId || randomUUID();
    if (publicResult.unexpected) {
      logError(error.cause || error, {
        operation: 'trpc.request',
        correlationId,
        userId: ctx?.user?.id,
        metadata: {
          path: path || 'unknown',
          code: error.code,
        },
      });
    }
    const { stack: _stack, ...safeData } = shape.data;
    return {
      ...shape,
      message: publicResult.message,
      data: {
        ...safeData,
        publicCode: publicResult.publicCode,
        correlationId,
        validation: publicResult.validation,
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

/** Operational diagnostics are available to operators and administrators. */
export const operatorProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (!roleSatisfies(ctx.user.role, 'operator')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Operator access required' });
  }
  return next({ ctx });
});
