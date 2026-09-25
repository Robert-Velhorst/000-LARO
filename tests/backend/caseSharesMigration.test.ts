import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("case share migration", () => {
  it("converts only valid legacy memberships into inert per-case invitations", () => {
    const database = new Database(":memory:");
    try {
      database.pragma("foreign_keys = ON");
      database.exec(`
        CREATE TABLE users (id text PRIMARY KEY NOT NULL);
        CREATE TABLE cases (id text PRIMARY KEY NOT NULL, userId text NOT NULL REFERENCES users(id));
        CREATE TABLE system_config (configKey text PRIMARY KEY NOT NULL, configValue text);
        INSERT INTO users(id) VALUES ('owner'), ('member'), ('stranger');
        INSERT INTO cases(id, userId) VALUES ('case-a', 'owner'), ('case-b', 'owner');
        INSERT INTO system_config(configKey, configValue) VALUES
          ('team:owner:members', '["member", "missing-user", "owner"]'),
          ('team:broken:members', 'not-json');
      `);
      const migration = readFileSync("drizzle/0019_case_shares.sql", "utf8")
        .replaceAll("--> statement-breakpoint", "");
      database.exec(migration);

      const rows = database.prepare(`
        SELECT caseId, ownerId, memberId, role, capabilities, status
        FROM case_shares ORDER BY caseId
      `).all();
      expect(rows).toEqual([
        { caseId: "case-a", ownerId: "owner", memberId: "member", role: "read_only", capabilities: '["case.read"]', status: "pending" },
        { caseId: "case-b", ownerId: "owner", memberId: "member", role: "read_only", capabilities: '["case.read"]', status: "pending" },
      ]);
      expect(database.prepare("SELECT configValue FROM system_config WHERE configKey = ?")
        .get("team:owner:members")).toEqual({ configValue: '["member", "missing-user", "owner"]' });
    } finally {
      database.close();
    }
  });

  it("has no live application read of the legacy global membership key", () => {
    for (const file of ["server/teams.ts", "server/_core/authz.ts", "server/routers/teams.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("team:${");
      expect(source).not.toContain("getSystemValue");
    }
  });
});
