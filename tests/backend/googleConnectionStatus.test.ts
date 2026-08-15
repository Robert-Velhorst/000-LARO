import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('shared Google connection status', () => {
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

  it('reports the same connected accounts for Gmail and Drive', async () => {
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
    const gmail = await caller.gmailEnhanced.getStatus();
    const drive = await caller.googleDrive.checkConnection();

    expect(gmail).toMatchObject({
      connected: true,
      accountCount: 1,
      email: 'connected@example.com',
    });
    expect(drive).toEqual({
      connected: true,
      accounts: [{
        id: 'GOOGLE_CONNECTED',
        email: 'connected@example.com',
        displayName: 'Connected owner',
      }],
    });
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
    await expect(caller.gmailEnhanced.getStatus()).resolves.toMatchObject({
      connected: false,
      accountCount: 0,
    });
    await expect(caller.googleDrive.checkConnection()).resolves.toEqual({
      connected: false,
      accounts: [],
    });

    const otherRows = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.userId, other.id));
    expect(otherRows).toHaveLength(0);
  });
});
