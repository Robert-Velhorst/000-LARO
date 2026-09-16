import { sql } from "drizzle-orm";
import { users } from "./schema";

/** Canonical identity form used at every account-email boundary. */
export function normalizeAccountEmail(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export async function findUserByEmailIdentity(db: any, value: string) {
  const normalized = normalizeAccountEmail(value);
  return (await db
    .select()
    .from(users)
    .where(sql`lower(trim(${users.email})) = ${normalized}`)
    .limit(1))[0] ?? null;
}
