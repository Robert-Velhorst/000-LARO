/**
 * Phase 011/026/017 — real outreach send path, fully gated.
 * Uses an injected fake sender so no real lawyer is ever contacted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { bootTestApp, sqliteAvailable, type TestApp } from '../helpers/app';
import { buildUser, buildCase, buildLawyer } from '../factories';

const suite = sqliteAvailable ? describe : describe.skip;

suite('Real outreach send (011/026/017)', () => {
  let app: TestApp;
  const U = { id: 'USR_SEND', name: 'S', role: 'user', email: 's@example.com' };
  let outreachId: string;
  const approveReviewedDraft = async (caller: any, id: string) => {
    const review = await caller.workflow.preSendReview({ outreachId: id });
    return caller.workflow.approveDraft({ outreachId: id, approvalHash: review.message.approvalHash });
  };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser({ id: U.id, email: U.email }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({ id: 'LW_SEND', email: 'lawyer@law.example', legalAreas: JSON.stringify(['Employment Law']) }));
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_SEND', userId: U.id, caseType: 'Employment' }));
    // Create + approve a draft through the real API.
    await app.makeCaller(U).workflow.prepareDrafts({ caseId: 'CASE_SEND' });
    const q = await app.makeCaller(U).workflow.reviewQueue({ caseId: 'CASE_SEND' });
    outreachId = q[0].id;
    await approveReviewedDraft(app.makeCaller(U), outreachId);
  });
  afterAll(() => app?.cleanup());

  it('refuses to send while the feature flag is OFF (default)', async () => {
    await expect(app.makeCaller(U).workflow.sendApproved({ outreachId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('binds approval to the exact recipient, subject, and body shown for review', async () => {
    const caller = app.makeCaller(U);
    await app.db.insert(app.schema.cases).values(buildCase({
      id: 'CASE_SEND_BOUND',
      userId: U.id,
      caseType: 'Housing',
    }));
    await caller.workflow.prepareDrafts({ caseId: 'CASE_SEND_BOUND' });
    const queue = await caller.workflow.reviewQueue({ caseId: 'CASE_SEND_BOUND' });
    const boundId = queue[0].id;
    const review = await caller.workflow.preSendReview({ outreachId: boundId });
    expect(review).toMatchObject({
      message: {
        to: 'lawyer@law.example',
        subject: 'Legal assistance enquiry - Housing',
      },
    });
    expect(review.message.text).toContain('Housing matter');
    expect(review.message.approvalHash).toMatch(/^[a-f0-9]{64}$/);

    await caller.workflow.approveDraft({ outreachId: boundId, approvalHash: review.message.approvalHash });
    const [approvedRow] = await app.db.select().from(app.schema.outreachStatus).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.id, boundId),
    );
    expect(JSON.parse(approvedRow.metadata)).toMatchObject({
      approvedMessage: {
        to: review.message.to,
        subject: review.message.subject,
        text: review.message.text,
        approvalHash: review.message.approvalHash,
        approvedBy: U.id,
      },
    });

    await app.db.update(app.schema.lawyers).set({ email: 'changed@law.example', name: 'Changed Name' }).where(
      (await import('drizzle-orm')).eq(app.schema.lawyers.id, 'LW_SEND'),
    );
    await app.db.update(app.schema.cases).set({ caseType: 'Changed case type' }).where(
      (await import('drizzle-orm')).eq(app.schema.cases.id, 'CASE_SEND_BOUND'),
    );

    const { setFlag } = await import('../../server/featureFlags');
    await setFlag('outreach.send.enabled', true);
    const { sendApprovedOutreach } = await import('../../server/outreachSend');
    const sent: any[] = [];
    await sendApprovedOutreach(U.id, boundId, async (email) => {
      sent.push(email);
      return { delivered: true, provider: 'fake' };
    });
    expect(sent).toEqual([{
      to: review.message.to,
      subject: review.message.subject,
      text: review.message.text,
    }]);
    await setFlag('outreach.send.enabled', false);
    await app.db.update(app.schema.lawyers).set({ email: 'lawyer@law.example', name: 'Lawyer LW_SEND' }).where(
      (await import('drizzle-orm')).eq(app.schema.lawyers.id, 'LW_SEND'),
    );
  });

  it('rejects approval when the reviewed message changed before confirmation', async () => {
    const caller = app.makeCaller(U);
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_SEND_STALE_REVIEW', userId: U.id }));
    await caller.workflow.prepareDrafts({ caseId: 'CASE_SEND_STALE_REVIEW' });
    const queue = await caller.workflow.reviewQueue({ caseId: 'CASE_SEND_STALE_REVIEW' });
    const outreachId = queue[0].id;
    const review = await caller.workflow.preSendReview({ outreachId });
    await app.db.update(app.schema.lawyers).set({ email: 'new-recipient@law.example' }).where(
      (await import('drizzle-orm')).eq(app.schema.lawyers.id, 'LW_SEND'),
    );

    await expect(caller.workflow.approveDraft({
      outreachId,
      approvalHash: review.message.approvalHash,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    await app.db.update(app.schema.lawyers).set({ email: 'lawyer@law.example' }).where(
      (await import('drizzle-orm')).eq(app.schema.lawyers.id, 'LW_SEND'),
    );
  });

  it('rejects an approved message whose stored content was altered', async () => {
    const caller = app.makeCaller(U);
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_SEND_TAMPERED', userId: U.id }));
    await caller.workflow.prepareDrafts({ caseId: 'CASE_SEND_TAMPERED' });
    const queue = await caller.workflow.reviewQueue({ caseId: 'CASE_SEND_TAMPERED' });
    const outreachId = queue[0].id;
    await approveReviewedDraft(caller, outreachId);
    const [row] = await app.db.select().from(app.schema.outreachStatus).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.id, outreachId),
    );
    const metadata = JSON.parse(row.metadata);
    metadata.approvedMessage.to = 'attacker@example.com';
    await app.db.update(app.schema.outreachStatus).set({ metadata: JSON.stringify(metadata) }).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.id, outreachId),
    );

    const { setFlag } = await import('../../server/featureFlags');
    await setFlag('outreach.send.enabled', true);
    const { sendApprovedOutreach } = await import('../../server/outreachSend');
    await expect(sendApprovedOutreach(U.id, outreachId, async () => ({ delivered: true, provider: 'fake' })))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await setFlag('outreach.send.enabled', false);
  });

  it('does not allow rejection after an approved send has been claimed', async () => {
    const caller = app.makeCaller(U);
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_SEND_RACE', userId: U.id }));
    await caller.workflow.prepareDrafts({ caseId: 'CASE_SEND_RACE' });
    const queue = await caller.workflow.reviewQueue({ caseId: 'CASE_SEND_RACE' });
    const raceId = queue[0].id;
    await approveReviewedDraft(caller, raceId);

    const { setFlag } = await import('../../server/featureFlags');
    await setFlag('outreach.send.enabled', true);
    const { sendApprovedOutreach } = await import('../../server/outreachSend');
    let releaseSender!: () => void;
    let markStarted!: () => void;
    const senderStarted = new Promise<void>((resolve) => { markStarted = resolve; });
    const senderReleased = new Promise<void>((resolve) => { releaseSender = resolve; });
    const sendPromise = sendApprovedOutreach(U.id, raceId, async () => {
      markStarted();
      await senderReleased;
      return { delivered: true, provider: 'fake' };
    });
    await senderStarted;

    await expect(caller.workflow.rejectDraft({ outreachId: raceId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    releaseSender();
    await expect(sendPromise).resolves.toMatchObject({ sent: true });
    const [row] = await app.db.select().from(app.schema.outreachStatus).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.id, raceId),
    );
    expect(row.status).toBe('Sent');
    await setFlag('outreach.send.enabled', false);
  });

  it('sends via the real path when enabled + provider present, then is idempotent', async () => {
    const { setFlag } = await import('../../server/featureFlags');
    await setFlag('outreach.send.enabled', true);

    const { sendApprovedOutreach } = await import('../../server/outreachSend');
    const sent: any[] = [];
    const fakeSender = async (email: any) => {
      sent.push(email);
      await new Promise((resolve) => { setTimeout(resolve, 25); });
      return { delivered: true, provider: 'fake' };
    };

    const concurrent = await Promise.allSettled([
      sendApprovedOutreach(U.id, outreachId, fakeSender),
      sendApprovedOutreach(U.id, outreachId, fakeSender),
    ]);
    const successful = concurrent.filter((result) => result.status === 'fulfilled');
    const rejected = concurrent.filter((result) => result.status === 'rejected');
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((successful[0] as PromiseFulfilledResult<any>).value).toMatchObject({
      sent: true,
      to: 'lawyer@law.example',
    });
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'CONFLICT' });
    expect(sent.length).toBe(1);

    // Row is now Sent.
    const [row] = await app.db.select().from(app.schema.outreachStatus).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.id, outreachId)
    );
    expect(row.status).toBe('Sent');

    // Idempotent: a second send does NOT transmit again.
    const r2 = await sendApprovedOutreach(U.id, outreachId, fakeSender);
    expect(r2.alreadySent).toBe(true);
    expect(sent.length).toBe(1); // still one send

    const [guard] = await app.db.select().from(app.schema.systemConfig).where(
      (await import('drizzle-orm')).eq(app.schema.systemConfig.configKey, `sent:${outreachId}`)
    );
    expect(guard.configValue).toBe('sent');
    const auditRows = await app.db.select().from(app.schema.auditLogs).where(
      (await import('drizzle-orm')).and(
        (await import('drizzle-orm')).eq(app.schema.auditLogs.entityId, outreachId),
        (await import('drizzle-orm')).eq(app.schema.auditLogs.action, 'outreach.status_changed'),
      )
    );
    expect(auditRows).toHaveLength(2);
    expect(auditRows.filter((entry: any) => entry.details?.includes('"to":"Sent"'))).toHaveLength(1);

    await setFlag('outreach.send.enabled', false);
  });

  it('fails closed after an ambiguous provider exception', async () => {
    const { setFlag } = await import('../../server/featureFlags');
    await setFlag('outreach.send.enabled', true);
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_SEND_UNCERTAIN', userId: U.id }));
    await app.makeCaller(U).workflow.prepareDrafts({ caseId: 'CASE_SEND_UNCERTAIN' });
    const queue = await app.makeCaller(U).workflow.reviewQueue({ caseId: 'CASE_SEND_UNCERTAIN' });
    const uncertainId = queue[0].id;
    await approveReviewedDraft(app.makeCaller(U), uncertainId);

    const { sendApprovedOutreach } = await import('../../server/outreachSend');
    const ambiguousSender = async () => {
      throw new Error('SMTP connection closed after DATA');
    };
    await expect(sendApprovedOutreach(U.id, uncertainId, ambiguousSender)).rejects.toThrow(
      'SMTP connection closed after DATA',
    );

    let retryCalls = 0;
    const retrySender = async () => {
      retryCalls += 1;
      return { delivered: true, provider: 'fake' };
    };
    await expect(sendApprovedOutreach(U.id, uncertainId, retrySender)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('outcome is uncertain'),
    });
    expect(retryCalls).toBe(0);

    const [guard] = await app.db.select().from(app.schema.systemConfig).where(
      (await import('drizzle-orm')).eq(app.schema.systemConfig.configKey, `sent:${uncertainId}`)
    );
    expect(guard.configValue).toMatch(/^uncertain:/);

    await expect(app.makeCaller(U).admin.uncertainOutreachDispatches()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const ADMIN = { id: 'ADMIN_SEND_RECOVERY', name: 'Operator', role: 'admin', email: 'operator@example.com' };
    const pending = await app.makeCaller(ADMIN).admin.uncertainOutreachDispatches();
    expect(pending).toContainEqual(expect.objectContaining({ outreachId: uncertainId, outreachStatus: 'Dispatching' }));
    await app.makeCaller(ADMIN).admin.resolveUncertainOutreachDispatch({
      outreachId: uncertainId,
      outcome: 'not_delivered',
      providerVerified: true,
      note: 'SMTP provider logs confirm that the message was not accepted.',
    });

    const retryResult = await sendApprovedOutreach(U.id, uncertainId, retrySender);
    expect(retryResult.sent).toBe(true);
    expect(retryCalls).toBe(1);
    await setFlag('outreach.send.enabled', false);
  });

  it('lets an admin confirm an ambiguous provider delivery without retransmitting', async () => {
    const { setFlag } = await import('../../server/featureFlags');
    await setFlag('outreach.send.enabled', true);
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_SEND_CONFIRMED', userId: U.id }));
    await app.makeCaller(U).workflow.prepareDrafts({ caseId: 'CASE_SEND_CONFIRMED' });
    const queue = await app.makeCaller(U).workflow.reviewQueue({ caseId: 'CASE_SEND_CONFIRMED' });
    const confirmedId = queue[0].id;
    await approveReviewedDraft(app.makeCaller(U), confirmedId);

    const { sendApprovedOutreach } = await import('../../server/outreachSend');
    await expect(sendApprovedOutreach(U.id, confirmedId, async () => {
      throw new Error('Connection ended after the provider accepted DATA');
    })).rejects.toThrow('Connection ended');

    const ADMIN = { id: 'ADMIN_SEND_RECOVERY', name: 'Operator', role: 'admin', email: 'operator@example.com' };
    const resolved = await app.makeCaller(ADMIN).admin.resolveUncertainOutreachDispatch({
      outreachId: confirmedId,
      outcome: 'delivered',
      providerVerified: true,
      providerReference: 'provider-message-123',
      note: 'Provider activity confirms exactly one accepted message.',
    });
    expect(resolved).toMatchObject({ outcome: 'delivered', canRetry: false, status: 'Sent' });

    let retransmissions = 0;
    const repeat = await sendApprovedOutreach(U.id, confirmedId, async () => {
      retransmissions += 1;
      return { delivered: true, provider: 'fake' };
    });
    expect(repeat.alreadySent).toBe(true);
    expect(retransmissions).toBe(0);

    const { and, eq } = await import('drizzle-orm');
    const audits = await app.db.select().from(app.schema.auditLogs).where(and(
      eq(app.schema.auditLogs.entityId, confirmedId),
      eq(app.schema.auditLogs.action, 'outreach.dispatch_resolved'),
    ));
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].details)).toMatchObject({
      outcome: 'delivered',
      providerVerified: true,
      providerReference: 'provider-message-123',
    });
    await setFlag('outreach.send.enabled', false);
  });

  it('records an owned inbound response and feeds real outreach analytics', async () => {
    const other = { id: 'USR_OTHER_SEND', name: 'Other', role: 'user', email: 'other@example.com' };
    await expect(app.makeCaller(other).workflow.recordResponse({
      outreachId,
      response: 'Interested',
      notes: 'Available for an intake call next week.',
    })).rejects.toBeTruthy();

    const result = await app.makeCaller(U).workflow.recordResponse({
      outreachId,
      response: 'Interested',
      notes: 'Available for an intake call next week.',
    });
    expect(result.status).toBe('Interested');

    const [row] = await app.db.select().from(app.schema.outreachStatus).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.id, outreachId)
    );
    expect(row.status).toBe('Interested');
    expect(row.responseReceived).toBe('Yes');
    expect(Number(row.responseTimeHours)).toBeGreaterThanOrEqual(0);

    const [caseRow] = await app.db.select().from(app.schema.cases).where(
      (await import('drizzle-orm')).eq(app.schema.cases.id, 'CASE_SEND')
    );
    expect(caseRow.status).toBe('Matched');

    const metrics = await app.makeCaller(U).outreachAnalytics.getOverallMetrics();
    expect(metrics.sent).toBe(5);
    expect(metrics.responses).toBe(1);
    expect(metrics.interested).toBe(1);
    expect(metrics.overallResponseRate).toBeCloseTo(100 / 5);

    const lawyers = await app.makeCaller(U).outreachAnalytics.getResponseRateByLawyer({ limit: 10 });
    expect(lawyers[0]).toMatchObject({ lawyerId: 'LW_SEND', responses: 1 });
    expect(lawyers[0].responseRate).toBeCloseTo(100 / 5);
  });

  it('fails honestly (no fake success) when no provider is configured', async () => {
    const { setFlag } = await import('../../server/featureFlags');
    await setFlag('outreach.send.enabled', true);
    // Fresh approved draft.
    await app.db.insert(app.schema.cases).values(buildCase({ id: 'CASE_SEND2', userId: U.id }));
    await app.makeCaller(U).workflow.prepareDrafts({ caseId: 'CASE_SEND2' });
    const q = await app.makeCaller(U).workflow.reviewQueue({ caseId: 'CASE_SEND2' });
    const oid = q[0].id;
    await approveReviewedDraft(app.makeCaller(U), oid);

    const { sendApprovedOutreach } = await import('../../server/outreachSend');
    const noProvider = async () => ({ delivered: false, provider: 'console' });
    await expect(sendApprovedOutreach(U.id, oid, noProvider)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // NOT marked sent — no fake success.
    const [row] = await app.db.select().from(app.schema.outreachStatus).where(
      (await import('drizzle-orm')).eq(app.schema.outreachStatus.id, oid)
    );
    expect(row.status).toBe('Approved');
    const guards = await app.db.select().from(app.schema.systemConfig).where(
      (await import('drizzle-orm')).eq(app.schema.systemConfig.configKey, `sent:${oid}`)
    );
    expect(guards).toHaveLength(0);
    await setFlag('outreach.send.enabled', false);
  });
});
