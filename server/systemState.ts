/**
 * Phase 104 — operator safety stop / emergency controls.
 *
 * A global, operator-controlled "emergency stop" backed by system_config. When
 * engaged it blocks all outbound/mutating outreach actions (prepare + approve),
 * regardless of feature flags or approvals. This is the kill switch a human
 * operator can hit to immediately halt the product's outreach machinery.
 *
 * Stored generically so other system-wide switches can reuse the same store.
 */
import { getDb } from "./db";
import { systemConfig } from "./schema";
import { eq } from "drizzle-orm";
import { writeAuditLogOrThrow } from "./audit";

const EMERGENCY_STOP_KEY = "system:emergency_stop";

/** Read a boolean system switch (default false if unset / DB unavailable). */
export async function getSystemSwitch(key: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  try {
    const row = (
      await db.select().from(systemConfig).where(eq(systemConfig.configKey, key)).limit(1)
    )[0];
    return row?.configValue === "true";
  } catch {
    return false;
  }
}

/** Set a boolean system switch. Requires the DB. */
export async function setSystemSwitch(key: string, value: boolean): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .insert(systemConfig)
    .values({ configKey: key, configValue: String(value), updatedAt: new Date() } as any)
    .onConflictDoUpdate({
      target: systemConfig.configKey,
      set: { configValue: String(value), updatedAt: new Date() } as any,
    });
}

/** Read an arbitrary string system value (null if unset). */
export async function getSystemValue(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  try {
    const row = (await db.select().from(systemConfig).where(eq(systemConfig.configKey, key)).limit(1))[0];
    return row?.configValue ?? null;
  } catch {
    return null;
  }
}

/** Write an arbitrary string system value. */
export async function setSystemValue(key: string, value: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .insert(systemConfig)
    .values({ configKey: key, configValue: value, updatedAt: new Date() } as any)
    .onConflictDoUpdate({ target: systemConfig.configKey, set: { configValue: value, updatedAt: new Date() } as any });
}

/** True when the operator has engaged the emergency stop. */
export function isEmergencyStopped(): Promise<boolean> {
  return getSystemSwitch(EMERGENCY_STOP_KEY);
}

/** Engage / release the emergency stop. */
export async function setEmergencyStop(engaged: boolean, actorUserId: string): Promise<{ changed: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction((tx) => {
    const current = tx.select().from(systemConfig).where(eq(systemConfig.configKey, EMERGENCY_STOP_KEY)).get();
    const previous = current?.configValue === "true";
    if (previous === engaged) return { changed: false };
    const changedAt = new Date();
    tx.insert(systemConfig)
      .values({ configKey: EMERGENCY_STOP_KEY, configValue: String(engaged), updatedAt: changedAt } as any)
      .onConflictDoUpdate({
        target: systemConfig.configKey,
        set: { configValue: String(engaged), updatedAt: changedAt } as any,
      }).run();
    writeAuditLogOrThrow(tx, {
      userId: actorUserId,
      action: engaged ? "emergency_stop.engaged" : "emergency_stop.released",
      entityType: "system",
      entityId: "emergency_stop",
      details: { from: previous, to: engaged },
    });
    return { changed: true };
  });
}

/**
 * Guard used by outbound/outreach mutations. Throws a clear error when the stop
 * is engaged so nothing proceeds. Callers should await this before side effects.
 */
export async function assertNotEmergencyStopped(): Promise<void> {
  if (await isEmergencyStopped()) {
    const { TRPCError } = await import("@trpc/server");
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Emergency stop is engaged. All outreach actions are halted by the operator. " +
        "Release the stop (admin) to resume.",
    });
  }
}

export const EMERGENCY_STOP_CONFIG_KEY = EMERGENCY_STOP_KEY;
