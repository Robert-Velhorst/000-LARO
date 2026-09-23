import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildUser } from "../factories";
import { bootTestApp, sqliteAvailable, type TestApp } from "../helpers/app";
import { assessDataReadiness } from "../../server/dataReadiness";

const suite = sqliteAvailable ? describe : describe.skip;

suite("production data readiness", () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await bootTestApp();
  });

  afterAll(() => app?.cleanup());

  it("passes an initialized clean database", async () => {
    const report = await assessDataReadiness();
    expect(report).toMatchObject({
      ok: true,
      sqliteIntegrity: "ok",
      foreignKeyViolations: 0,
      demoLikeRecords: { users: 0, cases: 0 },
      reconciliation: { totalOrphans: 0, duplicateEmails: [] },
      numericIntegrity: { ok: true },
    });
    expect(report.invariants.every((item) => item.ok)).toBe(true);
  });

  it("fails closed when native relationship data is invalid", async () => {
    const sqlite = (app.db as any).$client ?? (app.db as any).session?.client;
    sqlite.pragma("foreign_keys = OFF");
    try {
      sqlite.prepare(
        "INSERT INTO email_messages (id, accountId, subject) VALUES (?, ?, ?)",
      ).run("READINESS_ORPHAN", "MISSING_ACCOUNT", "orphan");
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }

    try {
      const report = await assessDataReadiness();
      expect(report.ok).toBe(false);
      expect(report.invariants).toContainEqual(expect.objectContaining({
        name: "database native relationships valid",
        severity: "error",
        ok: false,
        count: 1,
      }));
    } finally {
      sqlite.prepare("DELETE FROM email_messages WHERE id = ?").run("READINESS_ORPHAN");
    }
  });

  it("fails when a known non-production account marker remains", async () => {
    const sqlite = (app.db as any).$client ?? (app.db as any).session?.client;
    try {
      await app.db.insert(app.schema.users).values(buildUser({
        id: "demo-user-123",
        email: "owner@example.invalid",
      }));
      const report = await assessDataReadiness();
      expect(report.ok).toBe(false);
      expect(report.demoLikeRecords.users).toBe(1);
    } finally {
      sqlite.prepare("DELETE FROM users WHERE id = ?").run("demo-user-123");
    }
  });

  it("fails closed on malformed operational counters without exposing values", async () => {
    const sqlite = (app.db as any).$client ?? (app.db as any).session?.client;
    try {
      sqlite.prepare(`
        INSERT INTO lawyers (id, name, totalOutreaches, totalResponses, totalAcceptances)
        VALUES (?, ?, ?, ?, ?)
      `).run("numeric-invalid-lawyer", "Numeric integrity test", "12x", "2", "1");

      const report = await assessDataReadiness();
      const field = report.numericIntegrity.fields.find(
        (item) => item.table === "lawyers" && item.column === "totalOutreaches",
      );
      expect(report.ok).toBe(false);
      expect(report.numericIntegrity.ok).toBe(false);
      expect(field).toMatchObject({ available: true, invalidValues: 1, ok: false });
      expect(JSON.stringify(report)).not.toContain("12x");
    } finally {
      sqlite.prepare("DELETE FROM lawyers WHERE id = ?").run("numeric-invalid-lawyer");
    }
  });

  it("accepts numeric strings but rejects impossible counter relationships", async () => {
    const sqlite = (app.db as any).$client ?? (app.db as any).session?.client;
    try {
      sqlite.prepare(`
        INSERT INTO lawyers (id, name, totalOutreaches, totalResponses, totalAcceptances)
        VALUES (?, ?, ?, ?, ?)
      `).run("numeric-inconsistent-lawyer", "Numeric consistency test", " 1 ", "2", "0");

      const report = await assessDataReadiness();
      const responseConstraint = report.numericIntegrity.constraints.find(
        (item) => item.name === "lawyer responses do not exceed outreaches",
      );
      const outreachField = report.numericIntegrity.fields.find(
        (item) => item.table === "lawyers" && item.column === "totalOutreaches",
      );
      expect(report.ok).toBe(false);
      expect(outreachField).toMatchObject({ invalidValues: 0, ok: true });
      expect(responseConstraint).toMatchObject({ violatingRows: 1, ok: false });
    } finally {
      sqlite.prepare("DELETE FROM lawyers WHERE id = ?").run("numeric-inconsistent-lawyer");
    }
  });

  it("reports unavailable compatibility tables without throwing", async () => {
    const { assessNumericIntegrity } = await import("../../server/numericIntegrity");
    const sqlite = {
      prepare: (statement: string) => {
        if (!statement.startsWith("PRAGMA table_info")) {
          throw new Error("Missing tables must not be queried");
        }
        return { all: () => [], get: () => undefined };
      },
    };

    const report = assessNumericIntegrity(sqlite);
    expect(report.ok).toBe(false);
    expect(report.fields.every((field) => !field.available && !field.ok)).toBe(true);
    expect(report.constraints.every((constraint) => !constraint.available && !constraint.ok)).toBe(true);
  });
});
