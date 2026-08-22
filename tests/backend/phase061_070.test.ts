/**
 * Phases 061–070 — DB-backed behavioural tests (real temp DB).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser, buildLawyer, buildCase, buildEvidence } from '../factories';
import { encryptToken } from '../../server/emailOAuth';
import { saveEmailAccount } from '../../server/oauth2';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Phases 061–070', () => {
  let app: TestApp;
  const ADMIN = { id: 'USER_ADMIN61', name: 'Admin', role: 'admin', email: 'admin61@example.com' };
  const U = { id: 'USER_61', name: 'U61', role: 'user', email: 'u61@example.com' };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: ADMIN.id, email: ADMIN.email }));
    await app.db.insert(app.schema.users).values(buildUser({ id: U.id, email: U.email }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: 'LWYR_61', legalAreas: JSON.stringify(['Employment Law']) }));
  });
  afterAll(() => app?.cleanup());
  afterEach(() => vi.unstubAllGlobals());

  it('Phase 061 — invariants pass on a clean DB', async () => {
    const res = await app.makeCaller(ADMIN).admin.invariants();
    expect(res.ok).toBe(true);
    expect(res.invariants.find((i: any) => i.name.includes('email'))?.ok).toBe(true);
  });

  it('Phase 061 — invariant check is admin-only', async () => {
    await expect(app.makeCaller(U).admin.invariants()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('Phase 063 — provider checklist reports configured/unconfigured without secrets', async () => {
    const res = await app.makeCaller(U).system.providerChecklist();
    expect(res.total).toBeGreaterThan(0);
    expect(Array.isArray(res.items)).toBe(true);
    // No item leaks a secret value — only booleans + env-var names.
    for (const item of res.items) {
      expect(typeof item.configured).toBe('boolean');
      expect(Array.isArray(item.requiredEnv)).toBe(true);
    }
  });

  it('disconnects a shared Google connection without retaining owner tokens or cross-owner deletion', async () => {
    const revoke = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', revoke);
    await app.db.insert(app.schema.emailAccounts).values([
      {
        id: 'GOOGLE_U61', userId: U.id, provider: 'gmail', email: U.email,
        accessToken: encryptToken('access-u'), refreshToken: encryptToken('refresh-u'), status: 'connected',
      },
      {
        id: 'GOOGLE_ADMIN61', userId: ADMIN.id, provider: 'gmail', email: ADMIN.email,
        accessToken: encryptToken('access-admin'), refreshToken: encryptToken('refresh-admin'), status: 'connected',
      },
    ] as any);
    await app.db.insert(app.schema.evidenceSources).values([
      { id: 'SOURCE_GMAIL_U61', userId: U.id, sourceType: 'Gmail', status: 'connected' },
      { id: 'SOURCE_DRIVE_U61', userId: U.id, sourceType: 'GoogleDrive', status: 'connected' },
      { id: 'SOURCE_LOCAL_U61', userId: U.id, sourceType: 'LocalFolder', status: 'connected' },
      { id: 'SOURCE_GMAIL_ADMIN61', userId: ADMIN.id, sourceType: 'Gmail', status: 'connected' },
    ] as any);

    await app.makeCaller(U).gmailEnhanced.disconnect();

    expect(revoke).toHaveBeenCalledTimes(1);
    const revokeBody = revoke.mock.calls[0][1]?.body as URLSearchParams;
    expect(revokeBody.get('token')).toBe('refresh-u');

    const ownAccounts = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.userId, U.id));
    const otherAccounts = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.userId, ADMIN.id));
    const ownGoogleSources = await app.db.select().from(app.schema.evidenceSources)
      .where(and(
        eq(app.schema.evidenceSources.userId, U.id),
        inArray(app.schema.evidenceSources.sourceType, ['Gmail', 'GoogleDrive']),
      ));
    const ownLocalSources = await app.db.select().from(app.schema.evidenceSources)
      .where(and(eq(app.schema.evidenceSources.userId, U.id), eq(app.schema.evidenceSources.sourceType, 'LocalFolder')));
    const otherSources = await app.db.select().from(app.schema.evidenceSources)
      .where(eq(app.schema.evidenceSources.userId, ADMIN.id));

    expect(ownAccounts).toHaveLength(0);
    expect(ownGoogleSources).toHaveLength(0);
    expect(ownLocalSources).toHaveLength(1);
    expect(otherAccounts).toHaveLength(1);
    expect(otherSources).toHaveLength(1);

    const [audit] = await app.db.select().from(app.schema.auditLogs)
      .where(and(
        eq(app.schema.auditLogs.userId, U.id),
        eq(app.schema.auditLogs.action, 'provider.disconnect_revoked'),
      ));
    expect(audit).toBeTruthy();
    expect(JSON.parse(audit.details)).toMatchObject({
      provider: 'google',
      accountCount: 1,
      revocationOutcomes: ['revoked'],
      localCredentialsRemoved: true,
      localSourcesRemoved: true,
    });
    expect(audit.details).not.toContain('refresh-u');

    await app.makeCaller(U).gmailEnhanced.disconnect();
    const revocationAudits = await app.db.select().from(app.schema.auditLogs)
      .where(and(
        eq(app.schema.auditLogs.userId, U.id),
        eq(app.schema.auditLogs.action, 'provider.disconnect_revoked'),
      ));
    expect(revocationAudits).toHaveLength(1);
  });

  it('rejects new Outlook OAuth connections while its collector is unavailable', async () => {
    await expect(
      app.makeCaller(U).emailAccounts.getAuthUrl({ provider: 'outlook' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('retains Google credentials and sources when upstream revocation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await app.db.insert(app.schema.emailAccounts).values({
      id: 'GOOGLE_U61_RETRY', userId: U.id, provider: 'gmail', email: U.email,
      accessToken: encryptToken('access-retry'), refreshToken: encryptToken('refresh-retry'), status: 'connected',
    } as any);
    await app.db.insert(app.schema.evidenceSources).values({
      id: 'SOURCE_GMAIL_U61_RETRY', userId: U.id, sourceType: 'Gmail', status: 'connected',
    } as any);

    await expect(app.makeCaller(U).gmailEnhanced.disconnect()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });

    const accounts = await app.db.select().from(app.schema.emailAccounts)
      .where(and(eq(app.schema.emailAccounts.userId, U.id), eq(app.schema.emailAccounts.provider, 'gmail')));
    const sources = await app.db.select().from(app.schema.evidenceSources)
      .where(and(eq(app.schema.evidenceSources.userId, U.id), eq(app.schema.evidenceSources.sourceType, 'Gmail')));
    expect(accounts).toHaveLength(1);
    expect(sources).toHaveLength(1);

    const [audit] = await app.db.select().from(app.schema.auditLogs)
      .where(and(
        eq(app.schema.auditLogs.userId, U.id),
        eq(app.schema.auditLogs.action, 'provider.disconnect_failed'),
      ));
    expect(JSON.parse(audit.details)).toMatchObject({
      provider: 'google',
      reason: 'upstream_revocation_failed',
      localStateRetained: true,
    });
    expect(audit.details).not.toContain('refresh-retry');
  });

  it('removes a Google connection when the upstream token is already invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }));
    await app.db.insert(app.schema.emailAccounts).values({
      id: 'GOOGLE_U61_INVALID', userId: U.id, provider: 'gmail', email: 'already-invalid@example.com',
      accessToken: encryptToken('already-invalid'), status: 'connected',
    } as any);

    await app.makeCaller(U).emailAccounts.revoke({ accountId: 'GOOGLE_U61_INVALID' });

    const account = await app.db.select().from(app.schema.emailAccounts)
      .where(eq(app.schema.emailAccounts.id, 'GOOGLE_U61_INVALID'));
    expect(account).toHaveLength(0);

    const [audit] = await app.db.select().from(app.schema.auditLogs)
      .where(and(
        eq(app.schema.auditLogs.userId, U.id),
        eq(app.schema.auditLogs.entityId, 'GOOGLE_U61_INVALID'),
      ));
    expect(JSON.parse(audit.details).revocationOutcome).toBe('already_invalid');
  });

  it('records a Google connection without tokens or account PII in audit details', async () => {
    const accountId = await saveEmailAccount(
      U.id,
      'gmail',
      {
        accessToken: 'connection-access-secret',
        refreshToken: 'connection-refresh-secret',
        expiresIn: 3600,
        tokenType: 'Bearer',
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/drive.readonly',
      },
      { email: 'private-google-account@example.com', displayName: 'Private Owner' },
    );

    const [audit] = await app.db.select().from(app.schema.auditLogs)
      .where(and(
        eq(app.schema.auditLogs.userId, U.id),
        eq(app.schema.auditLogs.entityId, accountId),
      ));
    const details = JSON.parse(audit.details);
    expect(audit.action).toBe('provider.connected');
    expect(details).toMatchObject({ provider: 'google', refreshGrantStored: true });
    expect(details.requestedScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(details.tokenReportedScopes).toContain('https://www.googleapis.com/auth/drive.readonly');
    expect(audit.details).not.toContain('connection-access-secret');
    expect(audit.details).not.toContain('connection-refresh-secret');
    expect(audit.details).not.toContain('private-google-account@example.com');
    expect(audit.details).not.toContain('Private Owner');
  });

  it('records a timeline source open only for owner-accessible evidence without storing its URL', async () => {
    const caseId = 'CASE_SOURCE_AUDIT_61';
    const evidenceId = 'EVIDENCE_SOURCE_AUDIT_61';
    await app.db.insert(app.schema.cases).values(buildCase({ id: caseId, userId: U.id }));
    await app.db.insert(app.schema.evidence).values(buildEvidence({
      id: evidenceId,
      caseId,
      userId: U.id,
      fileUrl: 'https://private.example.test/legal-document?id=secret',
    }));

    await expect(app.makeCaller(ADMIN).evidenceFiles.recordSourceOpened({ id: evidenceId }))
      .rejects.toThrow('File not found');
    await app.makeCaller(U).evidenceFiles.recordSourceOpened({ id: evidenceId });

    const rows = await app.db.select().from(app.schema.auditLogs)
      .where(eq(app.schema.auditLogs.action, 'evidence.source_opened'));
    const audit = rows.find((row: any) => row.entityId === evidenceId);
    expect(audit?.userId).toBe(U.id);
    expect(JSON.parse(audit.details)).toEqual({
      caseId,
      accessMethod: 'source_url',
      dispatchConfirmed: true,
    });
    expect(audit.details).not.toContain('private.example.test');
  });

  it('Phase 062 — pre-send review returns safety facts and never sends', async () => {
    const caller = app.makeCaller(U);
    const c = await caller.cases.create({
      clientName: 'PreSend', clientEmail: 'p@x.com', caseType: 'Employment',
      caseSummary: 'werknemer ontslag', urgency: 'High',
    });
    const list = await caller.cases.list({});
    const caseId = list.cases[0].id;
    await caller.workflow.prepareDrafts({ caseId });
    const q = await caller.workflow.reviewQueue({ caseId });

    const review = await caller.workflow.preSendReview({ outreachId: q[0].id });
    expect(review.externalAction).toBe(true);
    expect(review.reversible).toBe(false);
    expect(review.requiresExplicitApproval).toBe(true);
    expect(review.sendEnabled).toBe(false); // flag default off
    expect(review.disclaimer.length).toBeGreaterThan(0);
    void c;
  });

  it('Phase 062 — pre-send review enforces ownership', async () => {
    const caller = app.makeCaller(U);
    const list = await caller.cases.list({});
    const caseId = list.cases[0].id;
    const q = await caller.workflow.reviewQueue({ caseId });
    // A different user cannot review this draft.
    await expect(app.makeCaller({ id: 'OTHER61', role: 'user', name: 'o', email: 'o@x.com' }).workflow.preSendReview({ outreachId: q[0].id })).rejects.toBeTruthy();
  });
});
