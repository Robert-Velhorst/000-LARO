import crypto from 'crypto';
import { and, eq, gte, lte } from 'drizzle-orm';
import { getDb } from './db';
import { usageTracking } from './schema';
import { isUsageAnalyticsEnabled } from './privacyPreferences';

/**
 * Optional owner-scoped product-usage analytics.
 *
 * LARO does not enforce paid tiers or block core actions. Historical billing
 * columns remain nullable for installed-database compatibility, but new usage
 * records contain quantities and provenance only. Required audit, security,
 * and resource-budget state use separate stores and are never gated here.
 */
export const RESOURCE_TYPES = [
  'ai_model_invocation',
  'ai_email_analysis',
  'ai_document_analysis',
  'ai_legal_inference',
  'email_sync',
  'lawyer_outreach',
  'document_generation',
  'case_analysis',
  'other',
] as const;

export type ResourceType = typeof RESOURCE_TYPES[number];

export type UsageTrackingResult =
  | { success: true; recorded: true; usageId: string; quantity: number }
  | { success: true; recorded: false; usageId: null; quantity: number; reason: 'analytics_disabled' };

export async function trackUsage(params: {
  userId: string;
  resourceType: ResourceType;
  quantity?: number;
  metadata?: Record<string, unknown>;
  caseId?: string;
}): Promise<UsageTrackingResult> {
  const db = await getDb();
  if (!db) throw new Error('Database not available');

  const quantity = params.quantity ?? 1;
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error('Usage quantity must be a positive integer');
  }

  const usageId = crypto.randomBytes(16).toString('hex');
  const recorded = db.transaction((tx) => {
    // The consent read and optional write share one SQLite transaction. A
    // concurrent opt-out therefore linearizes before or after this operation;
    // no writer can observe disabled consent and still insert a row.
    if (!isUsageAnalyticsEnabled(tx, params.userId)) return false;
    tx.insert(usageTracking).values({
      id: usageId,
      userId: params.userId,
      resourceType: params.resourceType,
      quantity,
      baseCost: null,
      billedCost: null,
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      caseId: params.caseId,
      timestamp: new Date(),
    }).run();
    return true;
  });

  if (!recorded) {
    return { success: true, recorded: false, usageId: null, quantity, reason: 'analytics_disabled' };
  }

  console.log(`[USAGE_TRACKING] Tracked ${params.resourceType} for user ${params.userId}: ${quantity} units`);
  return { success: true, recorded: true, usageId, quantity };
}

export async function getUserUsage(
  userId: string,
  periodStart?: Date,
  periodEnd?: Date
): Promise<{
  total: number;
  byResourceType: Record<string, { quantity: number }>;
  records: Array<typeof usageTracking.$inferSelect>;
}> {
  const db = await getDb();
  if (!db) return { total: 0, byResourceType: {}, records: [] };

  const now = new Date();
  const start = periodStart || new Date(now.getFullYear(), now.getMonth(), 1);
  const end = periodEnd || new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  const records = await db
    .select()
    .from(usageTracking)
    .where(and(
      eq(usageTracking.userId, userId),
      gte(usageTracking.timestamp, start),
      lte(usageTracking.timestamp, end)
    ))
    .orderBy(usageTracking.timestamp);

  let total = 0;
  const byResourceType: Record<string, { quantity: number }> = {};
  for (const record of records) {
    const quantity = record.quantity ?? 0;
    total += quantity;
    if (!record.resourceType) continue;
    byResourceType[record.resourceType] ??= { quantity: 0 };
    byResourceType[record.resourceType].quantity += quantity;
  }

  return { total, byResourceType, records };
}

export async function getUsageSummary(userId: string): Promise<{
  totalOperations: number;
  byResourceType: Record<string, number>;
}> {
  const usage = await getUserUsage(userId);
  return {
    totalOperations: usage.total,
    byResourceType: Object.fromEntries(
      Object.entries(usage.byResourceType).map(([type, value]) => [type, value.quantity])
    ),
  };
}
