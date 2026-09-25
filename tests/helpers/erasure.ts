import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import type { TestApp } from './app';

/** Exercise the real password reauthentication API in erasure integration tests. */
export async function verifiedErasureInput(app: TestApp, caller: any, userId: string) {
  const password = 'ErasureTest!2026';
  await app.db.update(app.schema.users).set({ password: bcrypt.hashSync(password, 4) })
    .where(eq(app.schema.users.id, userId));
  const { proof } = await caller.gdpr.reauthenticateForErasure({ expectedUserId: userId, password });
  return { confirm: true as const, expectedUserId: userId, proof };
}
