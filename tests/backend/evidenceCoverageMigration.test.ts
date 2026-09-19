import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sqliteAvailable } from "../helpers/app";

const suite = sqliteAvailable ? describe : describe.skip;

suite("evidence coverage contract migration", () => {
  it("retires legacy score rows, invalidates their derived output, and preserves current coverage", async () => {
    const Database = (await import("better-sqlite3")).default;
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE case_strength_analysis (id text PRIMARY KEY, caseId text, data text, createdAt integer);
        CREATE TABLE communication_gaps (id text PRIMARY KEY, caseId text, data text, createdAt integer);
        CREATE TABLE expected_documents (id text PRIMARY KEY, caseId text, data text, createdAt integer);
        CREATE TABLE suspicious_patterns (id text PRIMARY KEY, caseId text, data text, createdAt integer);
        CREATE TABLE legal_inferences (id text PRIMARY KEY, caseId text, data text, createdAt integer);

        INSERT INTO case_strength_analysis (id, caseId, data) VALUES
          ('LEGACY', 'CASE_LEGACY', '{"overallScore":82,"legalBasisScore":0}'),
          ('INVALID', 'CASE_INVALID', '{not-json'),
          ('CURRENT', 'CASE_CURRENT', '{"contractVersion":"evidence-coverage-v1","contractStatus":"current","inputs":[]}');

        INSERT INTO communication_gaps (id, caseId, data) VALUES
          ('GAP_LEGACY', 'CASE_LEGACY', '{}'),
          ('GAP_ORPHAN', 'CASE_ORPHAN', '{}'),
          ('GAP_CURRENT', 'CASE_CURRENT', '{}');
        INSERT INTO expected_documents (id, caseId, data) VALUES
          ('DOC_LEGACY', 'CASE_LEGACY', '{}'),
          ('DOC_CURRENT', 'CASE_CURRENT', '{}');
        INSERT INTO suspicious_patterns (id, caseId, data) VALUES
          ('PATTERN_INVALID', 'CASE_INVALID', '{}'),
          ('PATTERN_CURRENT', 'CASE_CURRENT', '{}');
        INSERT INTO legal_inferences (id, caseId, data) VALUES
          ('INFERENCE_LEGACY', 'CASE_LEGACY', '{}'),
          ('INFERENCE_CURRENT', 'CASE_CURRENT', '{}');
      `);

      const statements = readFileSync(
        resolve("drizzle/0027_retire_gap_scoring.sql"),
        "utf8",
      ).split("--> statement-breakpoint").map((part) => part.trim()).filter(Boolean);
      const migrate = sqlite.transaction(() => {
        for (const statement of statements) sqlite.exec(statement);
      });
      migrate();

      const saved = sqlite.prepare(
        "SELECT id, data FROM case_strength_analysis ORDER BY id",
      ).all() as Array<{ id: string; data: string }>;
      const parsed = new Map(saved.map((row) => [row.id, JSON.parse(row.data)]));
      expect(parsed.get("LEGACY")).toMatchObject({
        contractVersion: "legacy-case-strength-v0",
        contractStatus: "retired",
      });
      expect(parsed.get("INVALID")).toMatchObject({
        contractVersion: "legacy-case-strength-v0",
        contractStatus: "retired",
      });
      expect(parsed.get("CURRENT")).toEqual({
        contractVersion: "evidence-coverage-v1",
        contractStatus: "current",
        inputs: [],
      });

      for (const table of [
        "communication_gaps",
        "expected_documents",
        "suspicious_patterns",
        "legal_inferences",
      ]) {
        expect(sqlite.prepare(`SELECT id, caseId FROM ${table}`).all()).toEqual([
          expect.objectContaining({ caseId: "CASE_CURRENT" }),
        ]);
      }

      // The boot-time compatibility path may safely run this migration again.
      expect(() => migrate()).not.toThrow();
    } finally {
      sqlite.close();
    }
  });
});
