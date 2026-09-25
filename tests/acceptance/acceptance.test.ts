/**
 * Core product-path acceptance checks.
 *
 * The numbered release matrix lives in docs/ACCEPTANCE_TESTS.md and cites all
 * of its owning suites. This file keeps a compact user journey without reusing
 * stale AC numbers or treating constants/source strings as acceptance evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { verifiedErasureInput } from "../helpers/erasure";

const suite = sqliteAvailable ? describe : describe.skip;

suite("core product paths", () => {
  let app: TestApp;
  const owner = { id: "ACCEPTANCE_OWNER", name: "Acceptance owner", role: "user", email: "acceptance@example.test" };
  const erase = { id: "ACCEPTANCE_ERASE", name: "Erase owner", role: "user", email: "acceptance-erase@example.test" };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([buildUser(owner), buildUser(erase)]);
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "ACCEPTANCE_LAWYER",
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
  });

  afterAll(() => app?.cleanup());

  const createCase = (user: typeof owner, clientName: string) => app.makeCaller(user).cases.create({
    clientName,
    clientEmail: `${clientName.toLowerCase().replaceAll(" ", "-")}@example.test`,
    caseType: "Employment",
    caseSummary: "werknemer ontslag zonder opzegtermijn",
    urgency: "High",
  });

  it("creates and persists an owned case through intake", async () => {
    const created = await createCase(owner, "Intake Client");
    expect(created.success).toBe(true);
    await expect(app.makeCaller(owner).cases.byId(created.id)).resolves.toMatchObject({
      id: created.id,
      userId: owner.id,
      clientName: "Intake Client",
    });
  });

  it("persists the legal-area classification returned by intake", async () => {
    const created = await createCase(owner, "Classification Client");
    expect(created.legalAreas).toContain("Employment Law");
    const stored = await app.makeCaller(owner).cases.byId(created.id);
    expect(JSON.parse(stored!.legalAreas)).toContain("Employment Law");
  });

  it("returns suitable lawyers through the mounted matching route", async () => {
    const created = await createCase(owner, "Matching Client");
    const matches = await app.makeCaller(owner).matching.findLawyers({ caseId: created.id });
    expect(matches).toContainEqual(expect.objectContaining({
      id: "ACCEPTANCE_LAWYER",
      matchScore: expect.any(Number),
    }));
    expect(matches[0].matchScore).toBeGreaterThan(0);
  });

  it("requires review and records approval without sending", async () => {
    const created = await createCase(owner, "Approval Client");
    const caller = app.makeCaller(owner);
    await caller.workflow.prepareDrafts({ caseId: created.id });
    const [draft] = await caller.workflow.reviewQueue({ caseId: created.id });
    const review = await caller.workflow.preSendReview({ outreachId: draft.id });
    const approved = await caller.workflow.approveDraft({
      outreachId: draft.id,
      approvalHash: review.message.approvalHash,
    });
    expect(approved).toMatchObject({ status: "Approved", sent: false });
  });

  it("returns generated legal content with the required disclaimer", async () => {
    const { LEGAL_DISCLAIMER } = await import("../../shared/const");
    const created = await createCase(owner, "Document Client");
    const caller = app.makeCaller(owner);
    await caller.gapAnalysis.analyze({ caseId: created.id });
    const recipient = await caller.gapAnalysis.saveReviewedRecipient({
      caseId: created.id,
      name: "Acceptance Recipient",
      address: "Review Street 1\n1000 AA Amsterdam\nNetherlands",
      provenanceType: "owner_entered",
      confirmed: true,
    });
    const result = await caller.gapAnalysis.generateDocument({
      caseId: created.id,
      documentType: "demand_letter",
      recipientRevisionId: recipient.id,
    });

    expect(result.success).toBe(true);
    expect(result.disclaimer).toBe(LEGAL_DISCLAIMER);
    expect(result.document?.content).toContain(LEGAL_DISCLAIMER);
    const optionalUsageRows = await app.db.select().from(app.schema.usageTracking).where(and(
      eq(app.schema.usageTracking.userId, owner.id),
      eq(app.schema.usageTracking.caseId, created.id),
    ));
    expect(optionalUsageRows).toEqual([]);
  });

  it("exports owned data and erases it through the GDPR routes", async () => {
    const created = await createCase(erase, "Erase Client");
    const caller = app.makeCaller(erase);
    const exported = await caller.gdpr.exportData();
    expect(exported.data.cases).toContainEqual(expect.objectContaining({ id: created.id }));

    const deleted = await caller.gdpr.deleteData(await verifiedErasureInput(app, caller, erase.id));
    expect(deleted).toMatchObject({ success: true, deleted: { users: 1 } });
    await expect(caller.cases.byId(created.id)).resolves.toBeNull();
  });
});
