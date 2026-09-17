/**
 * Phase 058 — feature flags and rollout controls.
 *
 * Boolean flags with three-layer resolution (highest wins):
 *   1. environment override  FEATURE_<UPPER_SNAKE>  (e.g. FEATURE_OUTREACH_SEND_ENABLED=true)
 *   2. persisted value in system_config  (flag:<key>)
 *   3. built-in default
 *
 * Flags gate risky/rollout features. Notably `outreach.send.enabled` defaults to
 * FALSE — the real outreach send (behind the approval gate) stays off until an
 * operator explicitly enables it, which upholds the "no third party contacted
 * without approval" safety boundary during rollout.
 */
import { getDb } from "./db";
import { systemConfig } from "./schema";
import { eq } from "drizzle-orm";
import { writeAuditLogOrThrow } from "./audit";

export const FLAG_DEFAULTS = {
  "outreach.send.enabled": false, // real send stays off until explicitly enabled
  "analytics.enabled": true,
  "demo.mode": false,
} as const;

export type FlagKey = keyof typeof FLAG_DEFAULTS;

function envOverride(key: string): boolean | undefined {
  const envName = "FEATURE_" + key.toUpperCase().replace(/[.\-]/g, "_");
  const v = process.env[envName];
  if (v === undefined) return undefined;
  return v === "true" || v === "1";
}

export async function getFlag(key: FlagKey): Promise<boolean> {
  const env = envOverride(key);
  if (env !== undefined) return env;

  const db = await getDb();
  if (db) {
    try {
      const row = (await db.select().from(systemConfig).where(eq(systemConfig.configKey, `flag:${key}`)).limit(1))[0];
      if (row?.configValue != null) return row.configValue === "true";
    } catch { /* fall through to default */ }
  }
  return FLAG_DEFAULTS[key];
}

export async function getAllFlags(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const key of Object.keys(FLAG_DEFAULTS) as FlagKey[]) {
    out[key] = await getFlag(key);
  }
  return out;
}

export async function setFlag(key: FlagKey, value: boolean): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db
    .insert(systemConfig)
    .values({ configKey: `flag:${key}`, configValue: String(value), updatedAt: new Date() } as any)
    .onConflictDoUpdate({ target: systemConfig.configKey, set: { configValue: String(value), updatedAt: new Date() } });
}

export async function setFlagWithAudit(
  key: FlagKey,
  value: boolean,
  actorUserId: string,
): Promise<{ changed: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction((tx) => {
    const configKey = `flag:${key}`;
    const current = tx.select().from(systemConfig).where(eq(systemConfig.configKey, configKey)).get();
    const previous = current?.configValue == null ? FLAG_DEFAULTS[key] : current.configValue === "true";
    if (previous === value) return { changed: false };
    const changedAt = new Date();
    tx.insert(systemConfig)
      .values({ configKey, configValue: String(value), updatedAt: changedAt } as any)
      .onConflictDoUpdate({
        target: systemConfig.configKey,
        set: { configValue: String(value), updatedAt: changedAt },
      }).run();
    writeAuditLogOrThrow(tx, {
      userId: actorUserId,
      action: "feature_flag.changed",
      entityType: "feature_flag",
      entityId: key,
      details: { from: previous, to: value },
    });
    return { changed: true };
  });
}
