import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { buildCase, buildUser } from '../factories';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { verifiedErasureInput } from '../helpers/erasure';
import { encryptToken } from '../../server/emailOAuth';
import { registerDesktopScannerPrivacyProvider } from '../../server/gdpr';

const suite = sqliteAvailable ? describe : describe.skip;

suite('verified account erasure', () => {
  let app: TestApp;

  beforeAll(async () => { app = await bootTestApp(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    registerDesktopScannerPrivacyProvider(null);
  });
  afterAll(() => app?.cleanup());

  async function passwordOwner(id: string) {
    const user = { id, role: 'user', email: `${id.toLowerCase()}@example.test` };
    await app.db.insert(app.schema.users).values(buildUser({ ...user, password: bcrypt.hashSync('Correct!2026', 4) }));
    return user;
  }

  it('rejects direct API bypass, wrong password, cross-session proof, stale proof, and replay', async () => {
    const owner = await passwordOwner('ERASURE_AUTH_OWNER');
    const caller = app.makeCaller(owner);
    await expect(caller.gdpr.deleteData({ confirm: true, expectedUserId: owner.id } as any))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller.gdpr.reauthenticateForErasure({ expectedUserId: owner.id, password: 'wrong' }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const { proof } = await caller.gdpr.reauthenticateForErasure({
      expectedUserId: owner.id, password: 'Correct!2026',
    });
    const input = { confirm: true as const, expectedUserId: owner.id, proof };
    await expect(app.makeCaller(owner).gdpr.deleteData(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const proofKey = `erasure:proof:${owner.id}`;
    const row = app.db.$client.prepare('SELECT configValue FROM system_config WHERE configKey = ?')
      .get(proofKey) as { configValue: string };
    app.db.$client.prepare('UPDATE system_config SET configValue = ? WHERE configKey = ?')
      .run(JSON.stringify({ ...JSON.parse(row.configValue), expiresAt: Date.now() - 1 }), proofKey);
    await expect(caller.gdpr.deleteData(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await app.db.select().from(app.schema.users).where(eq(app.schema.users.id, owner.id))).toHaveLength(1);

    const current = await caller.gdpr.reauthenticateForErasure({
      expectedUserId: owner.id, password: 'Correct!2026',
    });
    const approved = { ...input, proof: current.proof };
    await expect(caller.gdpr.deleteData(approved)).resolves.toMatchObject({ success: true, erasureStatus: 'completed' });
    await expect(caller.gdpr.deleteData(approved)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('verifies a passwordless account through a fresh, session-bound email code', async () => {
    const owner = { id: 'ERASURE_EMAIL_OWNER', role: 'user', email: 'erasure-email@example.test' };
    await app.db.insert(app.schema.users).values(buildUser(owner));
    const caller = app.makeCaller(owner);
    let deliveredCode = '';
    const email = await import('../../server/systemEmail');
    vi.spyOn(email, 'sendSystemEmail').mockImplementation(async (message) => {
      deliveredCode = message.text.match(/\b\d{8}\b/)?.[0] || '';
      return { delivered: true, provider: 'smtp' };
    });
    expect(await caller.gdpr.erasureAuthMethod()).toEqual({ method: 'email_code' });
    await caller.gdpr.requestErasureCode({ expectedUserId: owner.id });
    expect(deliveredCode).toMatch(/^\d{8}$/);
    await expect(caller.gdpr.reauthenticateForErasure({
      expectedUserId: owner.id, code: deliveredCode === '00000000' ? '11111111' : '00000000',
    }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(app.makeCaller(owner).gdpr.reauthenticateForErasure({ expectedUserId: owner.id, code: deliveredCode }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const { proof } = await caller.gdpr.reauthenticateForErasure({ expectedUserId: owner.id, code: deliveredCode });
    await expect(caller.gdpr.reauthenticateForErasure({ expectedUserId: owner.id, code: deliveredCode }))
      .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.gdpr.deleteData({ confirm: true, expectedUserId: owner.id, proof }))
      .resolves.toMatchObject({ success: true, erasureStatus: 'completed' });
  });

  it('retains all local stores on provider failure, exposes a retry state, then completes on retry', async () => {
    const owner = await passwordOwner('ERASURE_REVOKE_OWNER');
    await app.db.insert(app.schema.emailAccounts).values({
      id: 'ERASURE_REVOKE_GRANT',
      userId: owner.id,
      provider: 'gmail',
      email: owner.email,
      refreshToken: encryptToken('erasure-retry-refresh'),
      status: 'connected',
    } as any);
    await app.db.insert(app.schema.emailSyncJobs).values({ id: 'ERASURE_ACCOUNT_JOB', accountId: 'ERASURE_REVOKE_GRANT', status: 'queued' });
    await app.db.insert(app.schema.emailMessages).values({ id: 'ERASURE_ACCOUNT_MESSAGE', accountId: 'ERASURE_REVOKE_GRANT', subject: 'Private message' });
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'ERASURE_REVOKE_CASE', userId: owner.id }));
    await app.db.insert(app.schema.evidenceFiles).values({ id: 'ERASURE_FILE', userId: owner.id, caseId: 'ERASURE_REVOKE_CASE', fileName: 'source.txt' });
    await app.db.insert(app.schema.evidenceTags).values({ id: 'ERASURE_TAG', userId: owner.id, name: 'private' });
    await app.db.insert(app.schema.evidenceFileTags).values({ id: 'ERASURE_FILE_TAG', evidenceFileId: 'ERASURE_FILE', tagId: 'ERASURE_TAG' });
    await app.db.insert(app.schema.integrationAccessTokens).values({
      id: 'ERASURE_INTEGRATION_TOKEN', userId: owner.id, name: 'External reader',
      tokenPrefix: 'laro_', tokenHash: 'a'.repeat(64), scope: 'read', status: 'active',
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: new Date(),
    });
    app.db.$client.prepare('INSERT INTO system_config (configKey, configValue, updatedAt) VALUES (?, ?, ?)')
      .run(`caseDraft:${owner.id}`, JSON.stringify({ private: 'draft' }), Math.floor(Date.now() / 1_000));
    const scannerErase = vi.fn().mockResolvedValue({ scans: 1, files: 1 });
    registerDesktopScannerPrivacyProvider({ export: () => ({ scans: [], files: [] }), erase: scannerErase });
    const caller = app.makeCaller(owner);
    const exported = await caller.gdpr.exportData();
    expect(exported.data.email_sync_jobs).toHaveLength(1);
    expect(exported.data.email_messages).toHaveLength(1);
    expect(exported.data.evidence_file_tags).toHaveLength(1);
    expect(exported.data.system_config).toContainEqual(expect.objectContaining({ configKey: `caseDraft:${owner.id}` }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const first = await caller.gdpr.deleteData(await verifiedErasureInput(app, caller, owner.id));
    expect(first).toMatchObject({ success: false, erasureStatus: 'revocation_pending', providerRevocation: { failed: 1 } });
    expect(scannerErase).not.toHaveBeenCalled();
    expect(await app.db.select().from(app.schema.users).where(eq(app.schema.users.id, owner.id))).toHaveLength(1);
    expect(await app.db.select().from(app.schema.emailAccounts).where(eq(app.schema.emailAccounts.userId, owner.id))).toHaveLength(1);
    const pending = app.db.$client.prepare('SELECT configValue FROM system_config WHERE configKey = ?')
      .get(`erasure:pending:${owner.id}`) as { configValue: string };
    expect(JSON.parse(pending.configValue)).toMatchObject({ erasureStatus: 'revocation_pending', erasureRequestId: first.erasureRequestId });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const retried = await caller.gdpr.deleteData(await verifiedErasureInput(app, caller, owner.id));
    expect(retried).toMatchObject({ success: true, erasureStatus: 'completed', erasureRequestId: first.erasureRequestId });
    expect(scannerErase).toHaveBeenCalledOnce();
    expect(await app.db.select().from(app.schema.users).where(eq(app.schema.users.id, owner.id))).toHaveLength(0);
    expect(await app.db.select().from(app.schema.emailAccounts).where(eq(app.schema.emailAccounts.userId, owner.id))).toHaveLength(0);
    expect(await app.db.select().from(app.schema.emailSyncJobs).where(eq(app.schema.emailSyncJobs.accountId, 'ERASURE_REVOKE_GRANT'))).toHaveLength(0);
    expect(await app.db.select().from(app.schema.emailMessages).where(eq(app.schema.emailMessages.accountId, 'ERASURE_REVOKE_GRANT'))).toHaveLength(0);
    expect(await app.db.select().from(app.schema.evidenceFileTags).where(eq(app.schema.evidenceFileTags.id, 'ERASURE_FILE_TAG'))).toHaveLength(0);
    expect(await app.db.select().from(app.schema.integrationAccessTokens).where(eq(app.schema.integrationAccessTokens.userId, owner.id))).toHaveLength(0);
    expect(app.db.$client.prepare('SELECT configKey FROM system_config WHERE configKey = ?').get(`caseDraft:${owner.id}`)).toBeUndefined();
    const receipt = app.db.$client.prepare('SELECT configValue FROM system_config WHERE configKey = ?')
      .get(`erasure:request:${first.erasureRequestId}`) as { configValue: string };
    expect(JSON.parse(receipt.configValue)).toMatchObject({ erasureStatus: 'completed' });
  });

  it('does not destroy a legacy provider token without a proven revocation path', async () => {
    const owner = await passwordOwner('ERASURE_LEGACY_TOKEN_OWNER');
    await app.db.insert(app.schema.evidenceSources).values({
      id: 'ERASURE_LEGACY_SOURCE', userId: owner.id, provider: 'trello',
      sourceType: 'trello', accessToken: 'legacy-opaque-token', status: 'connected',
    });
    const caller = app.makeCaller(owner);
    const result = await caller.gdpr.deleteData(await verifiedErasureInput(app, caller, owner.id));
    expect(result).toMatchObject({ success: false, erasureStatus: 'revocation_pending', providerRevocation: { failed: 1 } });
    expect(await app.db.select().from(app.schema.users).where(eq(app.schema.users.id, owner.id))).toHaveLength(1);
    expect(await app.db.select().from(app.schema.evidenceSources).where(eq(app.schema.evidenceSources.id, 'ERASURE_LEGACY_SOURCE')))
      .toHaveLength(1);
  });
});
