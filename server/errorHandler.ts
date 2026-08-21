import { TRPCError } from "@trpc/server";

/**
 * Centralized error handling utilities
 */

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500,
    public details?: any
  ) {
    super(message);
    this.name = "AppError";
  }
}

/**
 * Convert various error types to TRPCError
 */
export function handleError(error: unknown): TRPCError {
  // Already a TRPC error
  if (error instanceof TRPCError) {
    return error;
  }
  
  // Custom app error
  if (error instanceof AppError) {
    return new TRPCError({
      code: mapStatusCodeToTRPCCode(error.statusCode),
      message: error.message,
      cause: error.details,
    });
  }
  
  // Database errors
  if (error instanceof Error) {
    // MySQL duplicate key error
    if (error.message.includes("Duplicate entry")) {
      return new TRPCError({
        code: "CONFLICT",
        message: "A record with this information already exists.",
      });
    }
    
    // MySQL foreign key constraint
    if (error.message.includes("foreign key constraint")) {
      return new TRPCError({
        code: "BAD_REQUEST",
        message: "Cannot perform this operation due to related records.",
      });
    }
    
    // Connection errors
    if (error.message.includes("ECONNREFUSED") || error.message.includes("ETIMEDOUT")) {
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Database connection failed. Please try again later.",
      });
    }
  }
  
  // Generic error
  console.error("Unhandled error:", error);
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "An unexpected error occurred. Please try again.",
  });
}

/**
 * Map HTTP status codes to TRPC error codes
 */
function mapStatusCodeToTRPCCode(statusCode: number): TRPCError["code"] {
  switch (statusCode) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 500:
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

/**
 * Safely execute async operations with error handling
 */
export async function safeExecute<T>(
  operation: () => Promise<T>,
  errorMessage: string = "Operation failed"
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw handleError(error);
  }
}

/**
 * Validate required fields
 */
export function validateRequired(
  data: Record<string, any>,
  requiredFields: string[]
): void {
  const missing = requiredFields.filter(field => !data[field]);
  
  if (missing.length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Missing required fields: ${missing.join(", ")}`,
    });
  }
}

/**
 * Validate database connection
 */
export function validateDatabaseConnection(db: any): void {
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Database connection not available. Please try again later.",
    });
  }
}

/**
 * Sanitize error messages for logging (remove sensitive data)
 */
export function sanitizeErrorForLogging(error: unknown): string {
  if (error instanceof Error) {
    let message = error.message;
    
    // Remove potential sensitive data patterns
    message = message.replace(/password[=:]\s*\S+/gi, "password=***");
    message = message.replace(/token[=:]\s*\S+/gi, "token=***");
    message = message.replace(/api[_-]?key[=:]\s*\S+/gi, "api_key=***");
    message = message.replace(/secret[=:]\s*\S+/gi, "secret=***");
    message = message.replace(/\/bot[^/\s]+(?=\/)/gi, "/bot***");
    
    return message;
  }
  
  return String(error);
}

/**
 * Log error with context
 */
export function logError(
  error: unknown,
  context: {
    operation: string;
    userId?: string;
    metadata?: Record<string, any>;
  }
): void {
  const sanitized = sanitizeErrorForLogging(error);
  console.error(`[Error] ${context.operation}:`, {
    message: sanitized,
    userId: context.userId,
    metadata: context.metadata,
    timestamp: new Date().toISOString(),
  });
}

