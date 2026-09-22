import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;
const ROOT = process.cwd();

suite('optional local usage analytics without fabricated billing', () => {
  let app: TestApp;
  const user = { id: 'USER_USAGE_LOCAL', name: 'Local owner', role: 'user', email: 'usage-local@example.com' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: user.id, email: user.email }));
  });

  afterAll(() => app?.cleanup());

  it('persists operation counts without inventing charges', async () => {
    const { trackUsage, getUsageSummary } = await import('../../server/usageTracking');
    const skipped = await trackUsage({
      userId: user.id,
      resourceType: 'document_generation',
      quantity: 1,
    });
    expect(skipped).toEqual({
      success: true,
      recorded: false,
      usageId: null,
      quantity: 1,
      reason: 'analytics_disabled',
    });

    await app.makeCaller(user).gdpr.updateConsent({ analytics: true, expectedUserId: user.id });
    const tracked = await trackUsage({
      userId: user.id,
      resourceType: 'document_generation',
      quantity: 3,
      metadata: { documentType: 'demand_letter' },
    });
    expect(tracked).toMatchObject({ success: true, recorded: true, quantity: 3 });
    if (!tracked.recorded) throw new Error('Expected opted-in usage analytics to be recorded');

    const [row] = await app.db
      .select()
      .from(app.schema.usageTracking)
      .where(eq(app.schema.usageTracking.id, tracked.usageId));
    expect(row.quantity).toBe('3');
    expect(row.baseCost).toBeNull();
    expect(row.billedCost).toBeNull();

    await expect(trackUsage({
      userId: user.id,
      resourceType: 'document_generation',
      quantity: -1,
    })).rejects.toThrow('positive integer');

    await expect(getUsageSummary(user.id)).resolves.toEqual({
      totalOperations: 3,
      byResourceType: { document_generation: 3 },
    });
  });

  it('reports local unmetered operation and exposes no Stripe provider', async () => {
    const caller = app.makeCaller(user);
    await expect(caller.billing.status()).resolves.toMatchObject({
      plan: 'local',
      billingConfigured: false,
      forcedBilling: false,
      usage: {
        totalOperations: 3,
        byResourceType: { document_generation: 3 },
      },
    });
    const providers = await caller.system.providerChecklist();
    expect(providers.items.some((item: { provider: string }) => item.provider.includes('Stripe'))).toBe(false);
  });

  it('keeps core document generation free of quota and checkout gates', () => {
    const generation = readFileSync(join(ROOT, 'server/routers/gapAnalysis.ts'), 'utf8');
    expect(generation).not.toContain('checkUsageLimit');
    expect(generation).not.toContain('Upgrade to Pro');
    for (const file of [
      'src/renderer/components/BillingDashboard.tsx',
      'src/renderer/components/Pricing.tsx',
      'src/renderer/components/UsageAlertBanner.tsx',
      'src/renderer/components/UpgradeDialog.tsx',
    ]) {
      expect(existsSync(join(ROOT, file))).toBe(false);
    }
  });
});
