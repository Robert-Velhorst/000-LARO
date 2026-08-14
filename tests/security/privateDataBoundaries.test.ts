import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildEvidence, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("private data boundaries", () => {
  let app: TestApp;
  const A = { id: "BOUNDARY_A", name: "A", role: "user", email: "boundary-a@example.com" };
  const B = { id: "BOUNDARY_B", name: "B", role: "user", email: "boundary-b@example.com" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser({ id: A.id, email: A.email }),
      buildUser({ id: B.id, email: B.email }),
    ]);
    await app.db.insert(app.schema.cases).values([
      buildCase({ id: "BOUNDARY_CASE_A", userId: A.id, caseType: "ConfidentialAlpha" }),
      buildCase({ id: "BOUNDARY_CASE_B", userId: B.id, caseType: "ConfidentialBeta" }),
    ]);
    await app.db.insert(app.schema.documents).values([
      { id: "BOUNDARY_DOC_A", caseId: "BOUNDARY_CASE_A", userId: A.id, name: "Secret Alpha", type: "letter" },
      { id: "BOUNDARY_DOC_B", caseId: "BOUNDARY_CASE_B", userId: B.id, name: "Secret Beta", type: "letter" },
    ]);
    await app.db.insert(app.schema.emailAccounts).values([
      { id: "BOUNDARY_ACCOUNT_A", userId: A.id, provider: "gmail", email: A.email, accessToken: "encrypted-access-a", refreshToken: "encrypted-refresh-a", status: "connected" },
      { id: "BOUNDARY_ACCOUNT_B", userId: B.id, provider: "gmail", email: B.email, accessToken: "encrypted-access-b", refreshToken: "encrypted-refresh-b", status: "connected", metadata: JSON.stringify({ accessToken: "nested-access-b", label: "connected account" }) },
    ]);
    await app.db.insert(app.schema.emailSyncJobs).values([
      { id: "BOUNDARY_JOB_A", accountId: "BOUNDARY_ACCOUNT_A", caseId: "BOUNDARY_CASE_A", status: "completed" },
      { id: "BOUNDARY_JOB_B", accountId: "BOUNDARY_ACCOUNT_B", caseId: "BOUNDARY_CASE_B", status: "completed" },
    ]);
    await app.db.insert(app.schema.conversationThreads).values({
      id: "BOUNDARY_THREAD_A",
      userId: A.id,
      caseId: "BOUNDARY_CASE_A",
      title: "A private thread",
      status: "active",
      channels: JSON.stringify(["internal"]),
      messageCount: 0,
      unreadCount: 0,
    });
    await app.db.insert(app.schema.evidence).values(
      buildEvidence({ id: "BOUNDARY_EVIDENCE_A", userId: A.id, caseId: "BOUNDARY_CASE_A" })
    );
    await app.db.insert(app.schema.evidenceItems).values({
      id: "BOUNDARY_ITEM_A",
      userId: A.id,
      caseId: "BOUNDARY_CASE_A",
      title: "A private collected item",
      relevanceScore: 10,
    });
    await app.db.insert(app.schema.deadlines).values({
      id: "BOUNDARY_DEADLINE_A",
      userId: A.id,
      caseId: "BOUNDARY_CASE_A",
      title: "A private deadline",
      dueDate: new Date("2030-01-01T00:00:00Z"),
      completed: false,
    });
  });

  afterAll(() => app?.cleanup());

  it("redacts stored credentials and returns only the caller's sync jobs", async () => {
    const accounts = await app.makeCaller(B).emailAccounts.list();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe("BOUNDARY_ACCOUNT_B");
    expect(accounts[0]).not.toHaveProperty("accessToken");
    expect(accounts[0]).not.toHaveProperty("refreshToken");

    const jobs = await app.makeCaller(B).emailAccounts.syncJobs();
    expect(jobs.map((job: any) => job.id)).toEqual(["BOUNDARY_JOB_B"]);
    expect(await app.makeCaller(B).emailMessages.getSyncJob({ jobId: "BOUNDARY_JOB_A" })).toBeNull();
    expect((await app.makeCaller(B).emailMessages.getSyncJob({ jobId: "BOUNDARY_JOB_B" }))?.id).toBe("BOUNDARY_JOB_B");
  });

  it("omits connected-account credentials from GDPR exports", async () => {
    const { data: exported } = await app.makeCaller(B).gdpr.exportData();
    const account = exported.email_accounts?.find((row: any) => row.id === "BOUNDARY_ACCOUNT_B");

    expect(account).toMatchObject({ id: "BOUNDARY_ACCOUNT_B", email: B.email, status: "connected" });
    expect(account).not.toHaveProperty("accessToken");
    expect(account).not.toHaveProperty("refreshToken");
    expect(JSON.stringify(exported)).not.toContain("encrypted-access-b");
    expect(JSON.stringify(exported)).not.toContain("encrypted-refresh-b");
    expect(JSON.stringify(exported)).not.toContain("nested-access-b");
    expect(JSON.parse(account.metadata)).toEqual({ label: "connected account" });
  });

  it("persists privacy preferences per owner and includes them in export", async () => {
    expect(await app.makeCaller(B).gdpr.getConsent()).toMatchObject({ marketing: false, analytics: false });
    await Promise.all([
      app.makeCaller(B).gdpr.updateConsent({ marketing: true }),
      app.makeCaller(B).gdpr.updateConsent({ analytics: true }),
    ]);
    expect(await app.makeCaller(B).gdpr.getConsent()).toMatchObject({ marketing: true, analytics: true });
    expect(await app.makeCaller(A).gdpr.getConsent()).toMatchObject({ marketing: false, analytics: false });

    const { data: exported } = await app.makeCaller(B).gdpr.exportData();
    expect(exported.user_preferences?.some((row: any) =>
      row.key === 'privacy-consent' && JSON.parse(row.value).marketing === true && JSON.parse(row.value).analytics === true
    )).toBe(true);
  });

  it("keeps private documents and case-derived suggestions owner-scoped", async () => {
    const results = await app.makeCaller(B).search.global({ query: "Secret", types: ["document"] });
    expect(results.results.map((result: any) => result.id)).toEqual(["BOUNDARY_DOC_B"]);

    const suggestions = await app.makeCaller(B).search.suggestions({ query: "Confidential", limit: 10 });
    expect(suggestions.suggestions).toContain("ConfidentialBeta");
    expect(suggestions.suggestions).not.toContain("ConfidentialAlpha");
  });

  it("cannot append to another user's thread or attach a new thread to another user's case", async () => {
    await expect(app.makeCaller(B).unifiedInbox.createMessageWithThreading({
      threadId: "BOUNDARY_THREAD_A",
      channel: "internal",
      body: "cross-user write",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(app.makeCaller(B).unifiedInbox.createMessageWithThreading({
      caseId: "BOUNDARY_CASE_A",
      channel: "internal",
      body: "cross-case write",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [thread] = await app.db.select().from(app.schema.conversationThreads).where(eq(app.schema.conversationThreads.id, "BOUNDARY_THREAD_A"));
    expect(thread.messageCount).toBe(0);
  });

  it("creates an owned inbox message as a draft and preserves the case link", async () => {
    const result = await app.makeCaller(B).unifiedInbox.createMessageWithThreading({
      caseId: "BOUNDARY_CASE_B",
      channel: "internal",
      subject: "Review note",
      body: "Prepared for review",
    });
    expect(result.status).toBe("draft");

    const [message] = await app.db.select().from(app.schema.unifiedMessages).where(eq(app.schema.unifiedMessages.id, result.id));
    expect(message.userId).toBe(B.id);
    expect(message.caseId).toBe("BOUNDARY_CASE_B");
    expect(message.status).toBe("draft");
  });

  it("reports no-op owner-scoped mutations honestly and validates case states", async () => {
    expect(await app.makeCaller(B).bulkFileOperations.setRelevanceScore({ ids: ["BOUNDARY_ITEM_A"], score: 80 })).toEqual({ updated: 0 });
    expect(await app.makeCaller(B).caseManagement.organizeDocument({ id: "BOUNDARY_ITEM_A", folder: "other" })).toEqual({ ok: false });
    expect(await app.makeCaller(B).caseManagement.completeDeadline({ id: "BOUNDARY_DEADLINE_A" })).toEqual({ ok: false });
    await expect(app.makeCaller(A).caseManagement.updateStatus({ caseId: "BOUNDARY_CASE_A", status: "archived" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stamps case exports with a real timestamp", async () => {
    const exported = await app.makeCaller(B).cases.export({ caseId: "BOUNDARY_CASE_B" });
    expect(Number.isNaN(Date.parse(exported.exportedAt))).toBe(false);
  });
});
