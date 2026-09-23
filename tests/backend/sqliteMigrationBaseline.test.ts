import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  runSqliteMigrations,
  validateDeclaredSqliteSchema,
} from "../../server/sqliteMigrations";

const MIGRATIONS_FOLDER = resolve("drizzle");
const temporaryDirectories: string[] = [];

function temporaryDatabase(name: string): { directory: string; databasePath: string; sqlite: InstanceType<typeof Database> } {
  const directory = mkdtempSync(join(tmpdir(), `laro-migration-${name}-`));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "laro.sqlite");
  return { directory, databasePath, sqlite: new Database(databasePath) };
}

function applyLegacySnapshot(sqlite: InstanceType<typeof Database>, lastMigrationIndex: number): void {
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  sqlite.exec(`
    CREATE TABLE __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    );
  `);
  const insertHistory = sqlite.prepare(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
  );
  const apply = sqlite.transaction(() => {
    for (let index = 0; index <= lastMigrationIndex; index += 1) {
      const migration = migrations[index];
      for (const statement of migration.sql) {
        if (statement.trim()) sqlite.exec(statement);
      }
      insertHistory.run(migration.hash, migration.folderMillis);
    }
  });
  apply();
}

async function migrateFixture(
  fixture: ReturnType<typeof temporaryDatabase>,
) {
  fixture.sqlite.pragma("foreign_keys = ON");
  return runSqliteMigrations({
    sqlite: fixture.sqlite,
    drizzleDb: drizzle(fixture.sqlite),
    migrationsFolder: MIGRATIONS_FOLDER,
    databasePath: fixture.databasePath,
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("non-destructive SQLite migration baseline", () => {
  it("converges a clean database and representative legacy snapshots to one declared schema", async () => {
    const clean = temporaryDatabase("clean");
    const cleanResult = await migrateFixture(clean);
    expect(cleanResult.backupPath).toBeNull();
    expect(cleanResult.migrationsApplied).toBe(31);
    expect(validateDeclaredSqliteSchema(clean.sqlite)).toMatchObject({ ok: true, drift: [] });
    const signature = cleanResult.schemaSignature;
    clean.sqlite.close();

    for (const lastMigrationIndex of [20, 29]) {
      const legacy = temporaryDatabase(`legacy-${lastMigrationIndex}`);
      applyLegacySnapshot(legacy.sqlite, lastMigrationIndex);
      if (lastMigrationIndex === 29) {
        legacy.sqlite.exec(`
          ALTER TABLE users ADD COLUMN resetCodeHash text;
          ALTER TABLE users ADD COLUMN resetCodeExpiresAt text;
        `);
      }
      if (lastMigrationIndex === 29) {
        legacy.sqlite.prepare(
          "INSERT INTO users (id, email, role, resetCodeHash) VALUES (?, ?, 'user', ?)",
        ).run(`legacy-user-${lastMigrationIndex}`, `legacy-${lastMigrationIndex}@example.test`, "preserved-hash");
      } else {
        legacy.sqlite.prepare(
          "INSERT INTO users (id, email, role) VALUES (?, ?, 'user')",
        ).run(`legacy-user-${lastMigrationIndex}`, `legacy-${lastMigrationIndex}@example.test`);
      }

      const result = await migrateFixture(legacy);
      expect(result.schemaSignature).toBe(signature);
      expect(result.migrationsApplied).toBe(30 - lastMigrationIndex);
      expect(result.backupPath).toBeTruthy();
      expect(existsSync(result.backupPath!)).toBe(true);
      expect(validateDeclaredSqliteSchema(legacy.sqlite)).toMatchObject({ ok: true, drift: [] });
      expect(legacy.sqlite.prepare(
        "SELECT resetCodeHash FROM users WHERE id = ?",
      ).get(`legacy-user-${lastMigrationIndex}`)).toEqual({
        resetCodeHash: lastMigrationIndex === 29 ? "preserved-hash" : null,
      });
      expect(legacy.sqlite.prepare(
        "SELECT name, reconciledAt FROM laro_schema_baseline WHERE version = 1",
      ).get()).toEqual({ name: "non-destructive-v1", reconciledAt: expect.any(Number) });

      const backup = new Database(result.backupPath!, { readonly: true, fileMustExist: true });
      expect(backup.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
      expect(backup.prepare(
        "SELECT email FROM users WHERE id = ?",
      ).get(`legacy-user-${lastMigrationIndex}`)).toEqual({
        email: `legacy-${lastMigrationIndex}@example.test`,
      });
      expect(backup.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'laro_schema_baseline'",
      ).get()).toBeUndefined();
      backup.close();

      const secondBoot = await migrateFixture(legacy);
      expect(secondBoot).toMatchObject({
        backupPath: null,
        migrationsApplied: 0,
        schemaSignature: signature,
      });
      legacy.sqlite.close();
    }
  });

  it("fails before mutation when migration history or schema drift is unclassified", async () => {
    const drifted = temporaryDatabase("drifted");
    applyLegacySnapshot(drifted.sqlite, 29);
    drifted.sqlite.exec("ALTER TABLE cases ADD COLUMN unreviewedColumn text");
    const before = readFileSync(drifted.databasePath);

    await expect(migrateFixture(drifted)).rejects.toThrow(
      /Unclassified SQLite schema drift:[\s\S]*unexpected column cases\.unreviewedColumn/,
    );
    expect(readFileSync(drifted.databasePath)).toEqual(before);
    expect(existsSync(join(drifted.directory, "db-backups"))).toBe(false);
    drifted.sqlite.close();

    const tampered = temporaryDatabase("history");
    applyLegacySnapshot(tampered.sqlite, 29);
    tampered.sqlite.prepare(
      "UPDATE __drizzle_migrations SET hash = 'tampered' WHERE created_at = ?",
    ).run(1790215000000);
    await expect(migrateFixture(tampered)).rejects.toThrow(/Unclassified SQLite migration history/);
    tampered.sqlite.close();
  });

  it("refuses an upgrade when the pre-migration backup fails integrity validation", async () => {
    const invalid = temporaryDatabase("invalid-backup");
    applyLegacySnapshot(invalid.sqlite, 29);
    invalid.sqlite.pragma("foreign_keys = OFF");
    invalid.sqlite.prepare(`
      INSERT INTO document_analyses (
        id, evidenceId, caseId, userId, analysisVersion, contentHash, status,
        extractionMethod, providerStatus, documentType, confidence, summary,
        result, analyzedChars, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "orphan-analysis", "missing-evidence", "missing-case", "missing-user",
      "v1", "hash", "complete", "text", "local", "unknown", 0, "summary",
      "{}", 0, Date.now(), Date.now(),
    );
    invalid.sqlite.pragma("foreign_keys = ON");

    await expect(migrateFixture(invalid)).rejects.toThrow(
      /Pre-migration backup verification failed: foreign_key_check found 3 violation\(s\)/,
    );
    expect(invalid.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'laro_schema_baseline'",
    ).get()).toBeUndefined();
    expect(readdirSync(join(invalid.directory, "db-backups"))).toEqual([]);
    invalid.sqlite.close();
  });
});
