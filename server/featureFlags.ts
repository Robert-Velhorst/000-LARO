/**
 * Typed registry for maintained runtime flags.
 *
 * A flag belongs here only when it has an owner, a conservative default, a
 * concrete runtime reader, and a two-state behavioral test. Retired flags are
 * removed from the API and storage by migration instead of remaining as inert
 * controls.
 */
import { eq } from "drizzle-orm";
import { writeAuditLogOrThrow } from "./audit";
import { getDb } from "./db";
import { systemConfig } from "./schema";

export const FEATURE_FLAG_KEYS = ["outreach.send.enabled"] as const;
export type FlagKey = (typeof FEATURE_FLAG_KEYS)[number];

type FeatureFlagDefinition = {
  owner: string;
  defaultValue: boolean;
  storageKey: `flag:${string}`;
  reader: string;
  runtimeConsumers: readonly string[];
  twoStateTest: string;
  description: string;
};

export const FEATURE_FLAG_REGISTRY = {
  "outreach.send.enabled": {
    owner: "outreach delivery",
    defaultValue: false,
    storageKey: "flag:outreach.send.enabled",
    reader: "isOutreachSendingEnabled",
    runtimeConsumers: [
      "server/outreachSend.ts",
      "server/routers/workflow.ts",
      "server/liveOutboundAcceptance.ts",
    ],
    twoStateTest: "tests/backend/realSend.test.ts",
    description: "Allows an already approved outreach draft to reach the provider send gate.",
  },
} as const satisfies Record<FlagKey, FeatureFlagDefinition>;

async function getFlag(key: FlagKey): Promise<boolean> {
  const definition = FEATURE_FLAG_REGISTRY[key];
  const db = await getDb();
  if (db) {
    try {
      const row = (await db.select({ value: systemConfig.configValue })
        .from(systemConfig)
        .where(eq(systemConfig.configKey, definition.storageKey))
        .limit(1))[0];
      if (row?.value != null) return row.value === "true";
    } catch {
      // The only maintained flag is fail-safe: a read failure keeps sending off.
    }
  }
  return definition.defaultValue;
}

/** Canonical reader used at every outreach-delivery decision point. */
export function isOutreachSendingEnabled(): Promise<boolean> {
  return getFlag("outreach.send.enabled");
}

export async function getAllFlags(): Promise<Record<FlagKey, boolean>> {
  const entries = await Promise.all(FEATURE_FLAG_KEYS.map(async (key) => [key, await getFlag(key)] as const));
  return Object.fromEntries(entries) as Record<FlagKey, boolean>;
}

/** Internal/acceptance setter. Operator mutations use setFlagWithAudit. */
export async function setFlag(key: FlagKey, value: boolean): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const definition = FEATURE_FLAG_REGISTRY[key];
  await db.insert(systemConfig)
    .values({ configKey: definition.storageKey, configValue: String(value), updatedAt: new Date() } as any)
    .onConflictDoUpdate({
      target: systemConfig.configKey,
      set: { configValue: String(value), updatedAt: new Date() },
    });
}

export async function setFlagWithAudit(
  key: FlagKey,
  value: boolean,
  actorUserId: string,
): Promise<{ changed: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const definition = FEATURE_FLAG_REGISTRY[key];
  return db.transaction((tx) => {
    const current = tx.select({ value: systemConfig.configValue })
      .from(systemConfig)
      .where(eq(systemConfig.configKey, definition.storageKey))
      .get();
    const previous = current?.value == null ? definition.defaultValue : current.value === "true";
    if (previous === value) return { changed: false };
    const changedAt = new Date();
    tx.insert(systemConfig)
      .values({ configKey: definition.storageKey, configValue: String(value), updatedAt: changedAt } as any)
      .onConflictDoUpdate({
        target: systemConfig.configKey,
        set: { configValue: String(value), updatedAt: changedAt },
      })
      .run();
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
