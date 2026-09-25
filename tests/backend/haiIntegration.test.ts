import crypto from "crypto";
import { readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HaiGrantReview } from "../../shared/haiGrant";

describe("HAI reviewed grants", () => {
  let tmpDir: string;
  let db: any;
  let schema: any;
  let integration: any;
  const ownerId = "USER_HAI_OWNER";
  const otherId = "USER_HAI_OTHER";
  const selectedCaseId = "CASE_HAI_SELECTED";
  const unselectedCaseId = "CASE_HAI_UNSELECTED";

  const review = (overrides: Partial<HaiGrantReview> = {}): HaiGrantReview => ({
    caseIds: [selectedCaseId],
    fieldCategories: ["case_overview", "analysis_summary"],
    includeFutureCases: false,
    includeFutureAnalyses: false,
    acknowledgeCaseScope: true,
    acknowledgeFieldScope: true,
    acknowledgeFutureRecords: true,
    ...overrides,
  });

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
        id: selectedCaseId,
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
        id: unselectedCaseId,
        userId: ownerId,
        caseType: "Existing owner case outside the grant",
        caseSummary: "This current case was not selected.",
        createdAt: new Date("2026-08-01T08:30:00Z"),
        updatedAt: new Date("2026-08-01T08:30:00Z"),
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
      id: "EVIDENCE_HAI_SELECTED",
      caseId: selectedCaseId,
      userId: ownerId,
      type: "document",
      title: "Municipal decision.pdf",
      description: "Source bytes remain in LARO",
      createdAt: new Date("2026-08-02T08:00:00Z"),
      updatedAt: new Date("2026-08-02T08:00:00Z"),
    });
    await db.insert(schema.documentAnalyses).values({
      id: "ANALYSIS_HAI_SELECTED",
      evidenceId: "EVIDENCE_HAI_SELECTED",
      caseId: selectedCaseId,
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

  it("requires a reviewed owned case and field scope before issuing a hashed credential", async () => {
    await expect(integration.createHaiToken(ownerId, "Missing review", 30, {
      ...review(),
      acknowledgeFieldScope: false,
    })).rejects.toMatchObject({ status: 400 });
    await expect(integration.createHaiToken(ownerId, "Foreign case", 30, review({
      caseIds: ["CASE_HAI_OTHER"],
    }))).rejects.toMatchObject({ status: 403 });

    const created = await integration.createHaiToken(ownerId, "HAI reviewed", 30, review({
      fieldCategories: ["case_overview", "analysis_claims"],
    }));
    expect(created.token).toMatch(/^laro_hai_/);
    expect(JSON.stringify(created.credential)).not.toContain(created.token);
    expect(created.credential.grant).toMatchObject({
      caseIds: [selectedCaseId],
      fieldCategories: ["case_overview", "analysis_claims"],
      caseCount: 1,
      includeFutureCases: false,
      includeFutureAnalyses: false,
      revision: 1,
    });

    const [stored] = await db.select().from(schema.integrationAccessTokens)
      .where(eq(schema.integrationAccessTokens.id, created.credential.id));
    expect(stored.tokenHash).not.toContain(created.token);
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.grantId).toBe(created.credential.grant.id);
    expect(integration.haiPublicBaseUrl()).toBe("https://laro.example.test/laro");

    const listed = await integration.listHaiTokens(ownerId);
    expect(listed.find((item: any) => item.id === created.credential.id)).toMatchObject({
      status: "active",
      grant: { caseCount: 1, reviewedAt: expect.any(Date) },
    });
  });

  it("exports only selected cases and selected field categories", async () => {
    const created = await integration.createHaiToken(ownerId, "Projected feed", 30, review({
      fieldCategories: ["case_overview", "analysis_claims"],
    }));
    const auth = await integration.authenticateHaiToken(created.token);
    const first = await integration.buildHaiFeed(auth, undefined, 1);
    const second = await integration.buildHaiFeed(auth, first.nextCursor, 1);
    const combined = JSON.stringify([...first.items, ...second.items]);

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(combined).toContain(selectedCaseId);
    expect(combined).toContain("ANALYSIS_HAI_SELECTED");
    expect(combined).toContain("The decision lacks sufficient reasons.");
    expect(combined).not.toContain(unselectedCaseId);
    expect(combined).not.toContain("CASE_HAI_OTHER");
    expect(combined).not.toContain("Must Not Leave LARO");
    expect(combined).not.toContain("private@example.test");
    expect(combined).not.toContain("The municipality issued a decision");
    expect(combined).not.toContain("File an objection within six weeks");
    expect(combined).not.toContain("Administrative-law reasoning duty");
    expect(combined).not.toContain("Raw source quotation must not be synchronized");
    expect(combined).toContain("review_required=true");
    expect(combined).toContain(`grant_id=${created.credential.grant.id}`);
  });

  it("excludes future records until reviewed scope permits them and invalidates stale cursors", async () => {
    const created = await integration.createHaiToken(ownerId, "Future boundary", 30, review());
    const oldAuth = await integration.authenticateHaiToken(created.token);
    const oldPage = await integration.buildHaiFeed(oldAuth, undefined, 1);
    const futureAt = new Date("2099-01-01T00:00:00Z");
    await db.insert(schema.cases).values({
      id: "CASE_HAI_FUTURE",
      userId: ownerId,
      caseType: "Future expressly permitted case",
      caseSummary: "Created after the review.",
      createdAt: futureAt,
      updatedAt: futureAt,
    });
    await db.insert(schema.evidence).values({
      id: "EVIDENCE_HAI_FUTURE_ANALYSIS",
      caseId: selectedCaseId,
      userId: ownerId,
      type: "document",
      title: "Later document.pdf",
      createdAt: futureAt,
      updatedAt: futureAt,
    });
    await db.insert(schema.documentAnalyses).values({
      id: "ANALYSIS_HAI_FUTURE",
      evidenceId: "EVIDENCE_HAI_FUTURE_ANALYSIS",
      caseId: selectedCaseId,
      userId: ownerId,
      analysisVersion: "future-v1",
      contentHash: "future-content-hash",
      status: "complete",
      extractionMethod: "text",
      providerStatus: "local",
      documentType: "Later filing",
      confidence: 80,
      summary: "A later analysis that needs future-analysis permission.",
      result: JSON.stringify({ claims: [] }),
      analyzedChars: 200,
      createdAt: futureAt,
      updatedAt: futureAt,
    });

    const before = JSON.stringify((await integration.buildHaiFeed(oldAuth, undefined, 100)).items);
    expect(before).not.toContain("CASE_HAI_FUTURE");
    expect(before).not.toContain("ANALYSIS_HAI_FUTURE");

    const updated = await integration.updateHaiGrant(
      ownerId,
      created.credential.id,
      1,
      review({ includeFutureCases: true, includeFutureAnalyses: true }),
    );
    expect(updated.grant).toMatchObject({
      revision: 2,
      includeFutureCases: true,
      includeFutureAnalyses: true,
    });
    await expect(integration.buildHaiFeed(oldAuth, undefined, 100)).rejects.toMatchObject({ status: 409 });
    const newAuth = await integration.authenticateHaiToken(created.token);
    await expect(integration.buildHaiFeed(newAuth, oldPage.nextCursor, 100)).rejects.toMatchObject({ status: 409 });
    const after = JSON.stringify((await integration.buildHaiFeed(newAuth, undefined, 100)).items);
    expect(after).toContain("CASE_HAI_FUTURE");
    expect(after).toContain("ANALYSIS_HAI_FUTURE");
    expect(after).not.toContain(unselectedCaseId);

    const updates = await db.select().from(schema.auditLogs).where(and(
      eq(schema.auditLogs.action, "integration.hai_grant_updated"),
      eq(schema.auditLogs.entityId, created.credential.grant.id),
    ));
    expect(updates).toHaveLength(1);
    expect(JSON.parse(updates[0].details)).toMatchObject({
      previousRevision: 1,
      grantRevision: 2,
      includeFutureCases: true,
      includeFutureAnalyses: true,
    });
  });

  it("fails closed for malformed cursors, expired, revoked, and unreviewed legacy credentials", async () => {
    const cursorToken = await integration.createHaiToken(ownerId, "Cursor test", 30, review());
    const cursorAuth = await integration.authenticateHaiToken(cursorToken.token);
    await expect(integration.buildHaiFeed(cursorAuth, "not-a-cursor", 50)).rejects.toMatchObject({ status: 400 });

    const revoked = await integration.createHaiToken(ownerId, "Revocation test", 30, review());
    await integration.revokeHaiToken(ownerId, revoked.credential.id);
    await expect(integration.authenticateHaiToken(revoked.token)).rejects.toMatchObject({ status: 401 });
    await expect(integration.revokeHaiToken(otherId, revoked.credential.id)).rejects.toMatchObject({ status: 404 });

    const expired = await integration.createHaiToken(ownerId, "Expiry test", 30, review());
    await db.update(schema.integrationAccessTokens).set({ expiresAt: new Date(0) })
      .where(eq(schema.integrationAccessTokens.id, expired.credential.id));
    await expect(integration.authenticateHaiToken(expired.token)).rejects.toMatchObject({ status: 401 });

    const legacyRawToken = `laro_hai_${"x".repeat(43)}`;
    await db.insert(schema.integrationAccessTokens).values({
      id: "HAI_LEGACY_UNREVIEWED",
      userId: ownerId,
      name: "Legacy unrestricted",
      tokenPrefix: "laro_hai_xxxxxxxx",
      tokenHash: crypto.createHash("sha256").update(legacyRawToken).digest("hex"),
      grantId: null,
      scope: "hai:read",
      status: "active",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      createdAt: new Date(),
    });
    await expect(integration.authenticateHaiToken(legacyRawToken)).rejects.toMatchObject({ status: 401 });
    const listed = await integration.listHaiTokens(ownerId);
    expect(listed.find((item: any) => item.id === "HAI_LEGACY_UNREVIEWED")).toMatchObject({
      status: "revoked",
      grant: null,
    });
  });

  it("revokes unrestricted active credentials when the grant migration is applied", () => {
    const migrationDbPath = join(tmpDir, "legacy-migration.sqlite");
    const sqlite = new Database(migrationDbPath);
    try {
      sqlite.pragma("foreign_keys = ON");
      sqlite.exec(`
        CREATE TABLE users (id text PRIMARY KEY NOT NULL);
        CREATE TABLE integration_access_tokens (
          id text PRIMARY KEY NOT NULL,
          userId text NOT NULL,
          name text NOT NULL,
          tokenPrefix text NOT NULL,
          tokenHash text NOT NULL,
          scope text NOT NULL,
          status text NOT NULL DEFAULT 'active',
          expiresAt integer NOT NULL,
          lastUsedAt integer,
          createdAt integer NOT NULL,
          revokedAt integer,
          FOREIGN KEY (userId) REFERENCES users(id) ON DELETE cascade
        );
        INSERT INTO users (id) VALUES ('LEGACY_USER');
        INSERT INTO integration_access_tokens
          (id, userId, name, tokenPrefix, tokenHash, scope, status, expiresAt, createdAt)
        VALUES
          ('LEGACY_TOKEN', 'LEGACY_USER', 'Old broad token', 'laro_hai_old', 'hash', 'hai:read', 'active', 4102444800000, 1);
      `);
      const migration = readFileSync(resolve("drizzle/0026_reviewed_hai_grants.sql"), "utf8");
      for (const statement of migration.split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean)) {
        sqlite.exec(statement);
      }
      const migrated = sqlite.prepare("SELECT status, revokedAt, grantId FROM integration_access_tokens WHERE id = ?")
        .get("LEGACY_TOKEN") as { status: string; revokedAt: number | null; grantId: string | null };
      expect(migrated.status).toBe("revoked");
      expect(migrated.revokedAt).toBeTypeOf("number");
      expect(migrated.grantId).toBeNull();
    } finally {
      sqlite.close();
    }
  });
});
