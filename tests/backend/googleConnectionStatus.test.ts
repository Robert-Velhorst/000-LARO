import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('canonical Google connection status', () => {
  let app: TestApp;
  const owner = { id: 'USER_GOOGLE_STATUS', role: 'user' };
  const other = { id: 'USER_GOOGLE_STATUS_OTHER', role: 'user' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: owner.id }),
      buildUser({ id: other.id }),
    ]);
  });

  beforeEach(async () => {
    await app.db.delete(app.schema.emailAccounts);
  });

  afterAll(() => app?.cleanup());

  it('reports owner-scoped connected and reconnect-required accounts once', async () => {
    await app.db.insert(app.schema.emailAccounts).values([
      {
        id: 'GOOGLE_RECONNECT_REQUIRED',
        userId: owner.id,
        provider: 'gmail',
        email: 'stale@example.com',
        status: 'reconnect_required',
      },
      {
        id: 'GOOGLE_CONNECTED',
        userId: owner.id,
        provider: 'gmail',
        email: 'connected@example.com',
        displayName: 'Connected owner',
        status: 'connected',
      },
      {
        id: 'GOOGLE_OTHER_OWNER',
        userId: other.id,
        provider: 'gmail',
        email: 'other@example.com',
        status: 'connected',
      },
    ] as any);

    const caller = app.makeCaller(owner);
    const connections = await caller.providerConnections.list({ provider: 'gmail' });

    expect(connections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'GOOGLE_RECONNECT_REQUIRED',
        status: 'reconnect_required',
      }),
      expect.objectContaining({
        id: 'GOOGLE_CONNECTED',
        email: 'connected@example.com',
        displayName: 'Connected owner',
        status: 'connected',
      }),
    ]));
    expect(connections).toHaveLength(2);
  });

  it('does not present a retained non-connected row as usable Drive access', async () => {
    await app.db.insert(app.schema.emailAccounts).values({
      id: 'GOOGLE_FAILED_ONLY',
      userId: owner.id,
      provider: 'gmail',
      email: 'failed@example.com',
      status: 'reconnect_required',
    } as any);

    const caller = app.makeCaller(owner);
    await expect(caller.providerConnections.list({ provider: 'gmail' })).resolves.toEqual([
      expect.objectContaining({ id: 'GOOGLE_FAILED_ONLY', status: 'reconnect_required' }),
    ]);

    const otherRows = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.userId, other.id));
    expect(otherRows).toHaveLength(0);
  });
});
