import { randomUUID } from 'crypto';

export function createCaseId(): string {
  return `CASE-${randomUUID()}`;
}

export function createUserId(): string {
  return `USER-${randomUUID()}`;
}

export function createLawyerId(): string {
  return `LAW-${randomUUID()}`;
}

export function isGeneratedIdCollision(error: unknown, table: "users" | "lawyers"): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`UNIQUE constraint failed: ${table}.id`) ||
    message.includes(`duplicate key value violates unique constraint`) && message.includes(`${table}`);
}
