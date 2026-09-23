import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { linkInboundOutreachReply } from "../../server/inboundOutreach";
import { MATCH_SCORE_MAX } from "../../shared/lawyerMatching";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { buildCase, buildLawyer, buildUser } from "../factories";

const suite = sqliteAvailable ? describe : describe.skip;

suite("retired lawyer-rating subsystem", () => {
  let app: TestApp;
  const owner = {
    id: "RATING_RETIREMENT_OWNER",
    email: "rating-retirement@example.test",
    name: "Rating Retirement Owner",
    role: "user",
  };

  beforeAll(async () => {
    app = await bootTestApp();
    await app.db.insert(app.schema.users).values(buildUser(owner));
    await app.db.insert(app.schema.cases).values(buildCase({
      id: "RATING_RETIREMENT_CASE",
      userId: owner.id,
      legalAreas: JSON.stringify(["Employment Law"]),
    }));
    await app.db.insert(app.schema.lawyers).values(buildLawyer({
      id: "RATING_RETIREMENT_LAWYER",
      email: "rating-retirement@law.example",
      legalAreas: JSON.stringify(["Employment Law"]),
      caseLoad: "5",
      averageResponseTimeHours: "36",
      totalOutreaches: "10",
      totalResponses: "8",
      totalAcceptances: "4",
    }));
  });

  afterAll(() => app?.cleanup());

  it("removes the public routes and retired storage from the current schema", () => {
    expect(Object.hasOwn(app.appRouter._def.record, "lawyerRating")).toBe(false);
    const sqlite = (app.db as any).$client;
    const tables = sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('lawyer_ratings', 'lawyer_interactions', 'rating_calculation_logs')
      ORDER BY name
    `).all();
    expect(tables).toEqual([]);
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'
      AND name LIKE 'laro_ri_lawyer_interactions_%'`).all()).toEqual([]);
  });

  it("prunes a stale generated trigger during native relationship reconciliation", async () => {
    const sqlite = (app.db as any).$client;
    sqlite.exec(`CREATE TRIGGER laro_ri_lawyer_interactions_caseId_delete
      BEFORE DELETE ON cases BEGIN DELETE FROM lawyer_interactions WHERE caseId = OLD.id; END`);
    const { reconcileNativeRelationships } = await import("../../server/nativeRelationshipMigration");
    reconcileNativeRelationships(sqlite);
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get("laro_ri_lawyer_interactions_caseId_delete")).toBeUndefined();
  });

  it("keeps a real outreach reply from creating a hidden matching boost", async () => {
    const caller = app.makeCaller(owner);
    const before = await caller.matching.findLawyers({
      caseId: "RATING_RETIREMENT_CASE",
      maxDistance: 100,
      maxResults: 10,
    });
    expect(MATCH_SCORE_MAX).toBe(230);
    const beforeMatch = before.find((lawyer: { id: string }) => lawyer.id === "RATING_RETIREMENT_LAWYER");
    expect(beforeMatch).toBeTruthy();

    await app.db.insert(app.schema.outreachStatus).values({
      id: "RATING_RETIREMENT_OUTREACH",
      caseId: "RATING_RETIREMENT_CASE",
      lawyerId: "RATING_RETIREMENT_LAWYER",
      status: "Sent",
      initialContact: new Date("2026-09-18T09:00:00Z"),
      metadata: JSON.stringify({
        outboundProviderMessageId: "<rating-retirement-outbound@example.test>",
        outboundRecipient: "rating-retirement@law.example",
        outboundSubject: "Employment assistance request",
      }),
      createdAt: new Date("2026-09-18T09:00:00Z"),
      updatedAt: new Date("2026-09-18T09:00:00Z"),
    } as any);

    await expect(linkInboundOutreachReply({
      userId: owner.id,
      caseId: "RATING_RETIREMENT_CASE",
      message: {
        gmailMessageId: "rating-retirement-reply",
        from: "Lawyer <rating-retirement@law.example>",
        subject: "Re: Employment assistance request",
        body: "I reviewed the request and can discuss it with the client.",
        receivedAt: new Date("2026-09-18T12:00:00Z"),
        inReplyTo: "<rating-retirement-outbound@example.test>",
      },
    })).resolves.toEqual({
      status: "linked",
      outreachId: "RATING_RETIREMENT_OUTREACH",
    });

    const after = await caller.matching.findLawyers({
      caseId: "RATING_RETIREMENT_CASE",
      maxDistance: 100,
      maxResults: 10,
    });
    const afterMatch = after.find((lawyer: { id: string }) => lawyer.id === "RATING_RETIREMENT_LAWYER");
    expect(afterMatch?.matchScore).toBe(beforeMatch.matchScore);
    expect(afterMatch?.matchReasons.join(" ").toLowerCase()).not.toContain("rating");

    const [outreach] = await app.db.select().from(app.schema.outreachStatus)
      .where(eq(app.schema.outreachStatus.id, "RATING_RETIREMENT_OUTREACH"));
    expect(outreach).toMatchObject({ responseReceived: "Yes", responseTimeHours: "3.00" });
  });

  it("refuses to drop unexpected legacy rating data without operator review", async () => {
    const Database = (await import("better-sqlite3")).default;
    const probe = new Database(":memory:");
    try {
      probe.exec(`
        CREATE TABLE lawyer_ratings (id text PRIMARY KEY);
        CREATE TABLE lawyer_interactions (id text PRIMARY KEY);
        CREATE TABLE rating_calculation_logs (id text PRIMARY KEY);
        INSERT INTO lawyer_interactions (id) VALUES ('legacy-row');
      `);
      const statements = readFileSync(
        join(process.cwd(), "drizzle", "0024_retire_lawyer_rating.sql"),
        "utf8",
      ).split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
      const migrate = probe.transaction(() => {
        for (const statement of statements) probe.exec(statement);
      });

      expect(migrate).toThrow(/CHECK constraint failed/i);
      expect(probe.prepare("SELECT id FROM lawyer_interactions").all()).toEqual([{ id: "legacy-row" }]);
      expect(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lawyer_ratings'").get())
        .toEqual({ name: "lawyer_ratings" });
    } finally {
      probe.close();
    }
  });
});
