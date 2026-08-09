import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("HAI integration", () => {
  let tmpDir: string;
  let db: any;
  let schema: any;
  let integration: any;
  const ownerId = "USER_HAI_OWNER";
  const otherId = "USER_HAI_OTHER";

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    tmpDir = mkdtempSync(join(tmpdir(), "laro-hai-"));
    process.env.DATABASE_URL = join(tmpDir, "test.sqlite");
    process.env.LOCAL_STORAGE_DIR = join(tmpDir, "uploads");
    process.env.LARO_PUBLIC_BASE_URL = "https://laro.example.test/laro";

    const dbModule = await import("../../server/db");
    schema = await import("../../server/schema");
    integration = await import("../../server/haiIntegration");
    db = await dbModule.getDb();

    await db.insert(schema.users).values([
      { id: ownerId, name: "Owner", email: "owner@example.test" },
      { id: otherId, name: "Other", email: "other@example.test" },
    ]);
    await db.insert(schema.cases).values([
      {
        id: "CASE_HAI_OWNER",
        userId: ownerId,
        clientName: "Must Not Leave LARO",
        clientEmail: "private@example.test",
        caseType: "Administrative law",
        caseSummary: "A municipal decision is disputed.",
        status: "active",
        urgency: "high",
        legalAreas: JSON.stringify(["Administrative Law"]),
        createdAt: new Date("2026-08-01T08:00:00Z"),
        updatedAt: new Date("2026-08-01T08:00:00Z"),
      },
      {
        id: "CASE_HAI_OTHER",
        userId: otherId,
        caseType: "Private other-owner matter",
        caseSummary: "This record must not cross the owner boundary.",
        createdAt: new Date("2026-08-01T09:00:00Z"),
        updatedAt: new Date("2026-08-01T09:00:00Z"),
      },
    ]);
    await db.insert(schema.evidence).values({
      id: "EVIDENCE_HAI_OWNER",
      caseId: "CASE_HAI_OWNER",
      userId: ownerId,
      type: "document",
      title: "Municipal decision.pdf",
      description: "Source bytes remain in LARO",
      createdAt: new Date("2026-08-02T08:00:00Z"),
      updatedAt: new Date("2026-08-02T08:00:00Z"),
    });
    await db.insert(schema.documentAnalyses).values({
      id: "ANALYSIS_HAI_OWNER",
      evidenceId: "EVIDENCE_HAI_OWNER",
      caseId: "CASE_HAI_OWNER",
      userId: ownerId,
      analysisVersion: "v2",
      contentHash: "content-hash",
      status: "complete",
      extractionMethod: "text",
      providerStatus: "local",
      documentType: "Decision",
      confidence: 91,
      summary: "The municipality issued a decision and set an objection deadline.",
      result: JSON.stringify({
        claims: [{ text: "The decision lacks sufficient reasons." }],
        obligations: [{ text: "File an objection within six weeks." }],
        legalIssues: [{ text: "Administrative-law reasoning duty." }],
        timelineEvents: [{ date: "2026-08-02", actor: "Municipality", title: "Decision issued" }],
        citations: [{ quote: "Raw source quotation must not be synchronized." }],
      }),
      analyzedChars: 1200,
      createdAt: new Date("2026-08-02T08:00:00Z"),
      updatedAt: new Date("2026-08-02T08:00:00Z"),
    });
  }, 180_000);

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* database closes at process exit */ }
  });

  it("creates a one-time hashed credential and reports the configured route", async () => {
    const created = await integration.createHaiToken(ownerId, "HAI test", 30);
    expect(created.token).toMatch(/^laro_hai_/);
    expect(JSON.stringify(created.credential)).not.toContain(created.token);

    const stored = await db.select().from(schema.integrationAccessTokens);
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).not.toContain(created.token);
    expect(stored[0].tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(integration.haiPublicBaseUrl()).toBe("https://laro.example.test/laro");
  });

  it("exports only owner-scoped minimized records with a bounded cursor", async () => {
    const first = await integration.buildHaiFeed(ownerId, undefined, 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();

    const second = await integration.buildHaiFeed(ownerId, first.nextCursor, 1);
    expect(second.items).toHaveLength(1);
    const combined = JSON.stringify([...first.items, ...second.items]);
    expect(combined).toContain("CASE_HAI_OWNER");
    expect(combined).toContain("ANALYSIS_HAI_OWNER");
    expect(combined).not.toContain("CASE_HAI_OTHER");
    expect(combined).not.toContain("Must Not Leave LARO");
    expect(combined).not.toContain("private@example.test");
    expect(combined).not.toContain("Raw source quotation must not be synchronized");
    expect(combined).toContain("review_required=true");
  });

  it("rejects malformed cursors and revoked credentials", async () => {
    await expect(integration.buildHaiFeed(ownerId, "not-a-cursor", 50)).rejects.toMatchObject({ status: 400 });
    const created = await integration.createHaiToken(ownerId, "Revocation test", 30);
    await expect(integration.authenticateHaiToken(created.token)).resolves.toMatchObject({ userId: ownerId });
    await integration.revokeHaiToken(ownerId, created.credential.id);
    await expect(integration.authenticateHaiToken(created.token)).rejects.toMatchObject({ status: 401 });
    await expect(integration.revokeHaiToken(otherId, created.credential.id)).rejects.toMatchObject({ status: 404 });
  });
});
