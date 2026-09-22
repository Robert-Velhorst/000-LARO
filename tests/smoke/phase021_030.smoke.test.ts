/**
 * Phases 021-030 through maintained product boundaries.
 *
 * These checks intentionally use the real tRPC router, migrated SQLite schema,
 * persistence services, and Express middleware. Packaging-only invariants such
 * as excluding .env files remain in the blocking account-safety scan instead of
 * being presented as product acceptance tests.
 */
import { createServer, type Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { securityHeaders } from "../../server/securityHeaders";
import { listenHttpServer } from "../../server/listen";
import { buildCase, buildLawyer, buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("Phases 021-030 - live product contracts", () => {
  let app: TestApp;
  let server: Server;
  let origin: string;
  const owner = { id: "PHASE_021_OWNER", name: "Phase owner", role: "user", email: "phase-owner@example.test" };
  const other = { id: "PHASE_021_OTHER", name: "Other owner", role: "user", email: "phase-other@example.test" };
  const erase = { id: "PHASE_028_ERASE", name: "Erase owner", role: "user", email: "phase-erase@example.test" };
  const workflowCase = buildCase({ id: "PHASE_026_CASE", userId: owner.id });
  const eraseCase = buildCase({ id: "PHASE_028_CASE", userId: erase.id });

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values([
      buildUser(owner),
      buildUser(other),
      buildUser(erase),
    ]);
    await app.db.insert(app.schema.cases).values([workflowCase, eraseCase]);
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "PHASE_026_LAWYER",
      legalAreas: JSON.stringify(["Employment Law"]),
    }));

    const httpApp = express();
    httpApp.use(securityHeaders);
    httpApp.get("/api/contract", (_request, response) => response.status(204).end());
    server = createServer(httpApp);
    const port = await listenHttpServer(server, 0, "127.0.0.1");
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    app?.cleanup();
  });

  it("Phase 021 - enforces intake validation at the live case procedure", async () => {
    const caller = app.makeCaller(owner);
    const valid = {
      clientName: "Jane Doe",
      clientEmail: "jane@example.test",
      caseType: "Employment",
      urgency: "High" as const,
    };

    await expect(caller.cases.create({ ...valid, clientEmail: "not-an-email" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.cases.create({ ...valid, clientName: "J" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(caller.cases.create({ ...valid, urgency: "Whenever" }))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });

    const created = await caller.cases.create(valid);
    const stored = await caller.cases.byId(created.id);
    expect(stored).toMatchObject({
      id: created.id,
      clientPhone: "",
      caseSummary: "",
      urgency: "High",
    });
  });

  it("Phase 024 - creates, updates, lists, and deletes an owner-scoped message template", async () => {
    const caller = app.makeCaller(owner);
    const created = await caller.messageTemplates.create({
      name: "Initial outreach",
      body: "Please review this request.",
    });
    expect(created.success).toBe(true);
    await expect(app.makeCaller(other).messageTemplates.update({
      id: created.id,
      name: "Cross-owner change",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(caller.messageTemplates.update({
      id: created.id,
      name: "Reviewed outreach",
    })).resolves.toEqual({ success: true });
    await expect(caller.messageTemplates.list()).resolves.toContainEqual(expect.objectContaining({
      id: created.id,
      userId: owner.id,
      name: "Reviewed outreach",
      body: "Please review this request.",
    }));

    await expect(caller.messageTemplates.delete({ id: created.id }))
      .resolves.toEqual({ success: true });
    await expect(caller.messageTemplates.list()).resolves.not.toContainEqual(
      expect.objectContaining({ id: created.id }),
    );
  });

  it("Phase 026 - persists approval without dispatching outreach", async () => {
    const caller = app.makeCaller(owner);
    const prepared = await caller.workflow.prepareDrafts({ caseId: workflowCase.id });
    expect(prepared.created).toBe(1);
    const [draft] = await caller.workflow.reviewQueue({ caseId: workflowCase.id });
    expect(draft).toMatchObject({ caseId: workflowCase.id, status: "PendingApproval" });

    const review = await caller.workflow.preSendReview({ outreachId: draft.id });
    const approved = await caller.workflow.approveDraft({
      outreachId: draft.id,
      approvalHash: review.message.approvalHash,
    });
    expect(approved).toMatchObject({ status: "Approved", sent: false });
    const [stored] = await app.db.select().from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, draft.id));
    expect(stored.status).toBe("Approved");
  });

  it("Phase 028 - exports owned rows and then erases them from persistence", async () => {
    const caller = app.makeCaller(erase);
    const exported = await caller.gdpr.exportData();
    expect(exported.success).toBe(true);
    expect(exported.data.cases).toContainEqual(expect.objectContaining({ id: eraseCase.id }));

    const { verifiedErasureInput } = await import('../helpers/erasure');
    const deleted = await caller.gdpr.deleteData(await verifiedErasureInput(app, caller, erase.id));
    expect(deleted).toMatchObject({ success: true, erasureStatus: "completed" });
    const remainingUsers = await app.db.select().from(app.schema.users)
      .where(eq(app.schema.users.id, erase.id));
    const remainingCases = await app.db.select().from(app.schema.cases)
      .where(eq(app.schema.cases.id, eraseCase.id));
    expect(remainingUsers).toHaveLength(0);
    expect(remainingCases).toHaveLength(0);
  });

  it("Phase 029 - emits the production security headers on a real HTTP response", async () => {
    const response = await fetch(`${origin}/api/contract`);
    expect(response.status).toBe(204);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
  });
});
