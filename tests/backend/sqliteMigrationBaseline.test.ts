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
import { relationshipIntegrityReport } from "../../server/relationshipIntegrity";

const MIGRATIONS_FOLDER = resolve("drizzle");
const MIGRATION_COUNT = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER }).length;
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
    expect(cleanResult.migrationsApplied).toBe(MIGRATION_COUNT);
    expect(cleanResult.nativeRelationships).toBeGreaterThan(100);
    expect(cleanResult.relationshipTablesRebuilt).toBeGreaterThan(30);
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
      expect(result.migrationsApplied).toBe(MIGRATION_COUNT - (lastMigrationIndex + 1));
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

  it("stops before migration when a legacy relationship needs reviewed repair", async () => {
    const orphaned = temporaryDatabase("relationship-orphan");
    applyLegacySnapshot(orphaned.sqlite, 30);
    orphaned.sqlite.prepare(
      "INSERT INTO email_messages (id, accountId, subject) VALUES (?, ?, ?)",
    ).run("legacy-orphan", "missing-account", "Needs review");

    await expect(migrateFixture(orphaned)).rejects.toThrow(
      /reviewed orphan reconciliation before upgrade: email_messages\.accountId->email_accounts\.id \(1\)/,
    );
    expect(orphaned.sqlite.prepare(
      "SELECT subject FROM email_messages WHERE id = 'legacy-orphan'",
    ).get()).toEqual({ subject: "Needs review" });
    expect(orphaned.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'laro_relationship_baseline'",
    ).get()).toBeUndefined();
    expect(readdirSync(join(orphaned.directory, "db-backups"))).toHaveLength(1);
    orphaned.sqlite.close();
  });

  it("preserves legacy rows and enforces reviewed native relationship policies", async () => {
    const legacy = temporaryDatabase("native-relationships");
    applyLegacySnapshot(legacy.sqlite, 30);
    legacy.sqlite.exec(`
      INSERT INTO users (id, email, role)
      VALUES ('relationship-user', 'relationship@example.test', 'user');
      INSERT INTO cases (id, userId)
      VALUES ('relationship-case', 'relationship-user');
      INSERT INTO lawyers (id, name)
      VALUES ('relationship-lawyer', 'Relationship Lawyer');
      INSERT INTO evidence (id, caseId, userId, type, title)
      VALUES ('relationship-evidence', 'relationship-case', 'relationship-user', 'document', 'Evidence');
      INSERT INTO evidence_files (id, caseId, userId, fileName)
      VALUES ('relationship-file', 'relationship-case', 'relationship-user', 'evidence.pdf');
      INSERT INTO evidence_tags (id, userId, name)
      VALUES ('relationship-tag', 'relationship-user', 'Relevant');
      INSERT INTO evidence_file_tags (id, evidenceFileId, tagId)
      VALUES ('relationship-file-tag', 'relationship-file', 'relationship-tag');
      INSERT INTO email_accounts (id, userId, provider, email)
      VALUES ('relationship-account', 'relationship-user', 'gmail', 'relationship@example.test');
      INSERT INTO email_messages (id, accountId, caseId, subject)
      VALUES ('relationship-email', 'relationship-account', 'relationship-case', 'Preserved');
      INSERT INTO conversation_threads (id, userId, caseId, title)
      VALUES ('relationship-thread', 'relationship-user', 'relationship-case', 'Preserved thread');
      INSERT INTO messages (id, userId, caseId, threadId, content)
      VALUES ('relationship-message', 'relationship-user', 'relationship-case', 'relationship-thread', 'Preserved');
      INSERT INTO unified_messages (id, userId, caseId, threadId, body)
      VALUES ('relationship-unified', 'relationship-user', 'relationship-case', 'relationship-thread', 'Preserved');
      INSERT INTO outreach_status (id, caseId, lawyerId, status)
      VALUES ('relationship-outreach', 'relationship-case', 'relationship-lawyer', 'Sent');
      INSERT INTO notifications (
        id, userId, kind, title, caseId, lawyerId, evidenceFileId, read
      ) VALUES (
        'relationship-notification', 'relationship-user', 'lawyer_response', 'Preserved',
        'relationship-case', 'relationship-lawyer', 'relationship-evidence', 0
      );
      INSERT INTO document_inbox (
        id, userId, fileName, sourcePath, mimeType, fileSize, storageKey, contentHash, createdAt, updatedAt
      ) VALUES (
        'relationship-inbox', 'relationship-user', 'source.pdf', '/review/source.pdf',
        'application/pdf', 10, 'review/source.pdf', 'fixture-hash', 1790387800000, 1790387800000
      );
      CREATE INDEX relationship_fixture_messages_content_idx ON messages(content);
      CREATE TRIGGER laro_ri_fixture_cleanup AFTER INSERT ON messages BEGIN SELECT 1; END;
    `);

    const result = await migrateFixture(legacy);
    expect(result.migrationsApplied).toBe(3);
    expect(result.backupPath).toBeTruthy();
    expect(result.relationshipTablesRebuilt).toBeGreaterThan(30);
    expect(legacy.sqlite.prepare(
      "SELECT content FROM messages WHERE id = 'relationship-message'",
    ).get()).toEqual({ content: "Preserved" });
    expect(legacy.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'relationship_fixture_messages_content_idx'",
    ).get()).toEqual({ name: "relationship_fixture_messages_content_idx" });
    expect(legacy.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'laro_ri_%'",
    ).all()).toEqual([]);
    expect(relationshipIntegrityReport(legacy.sqlite)).toMatchObject({
      ok: true,
      expected: result.nativeRelationships,
      installed: result.nativeRelationships,
      missing: [],
      violations: [],
    });

    legacy.sqlite.prepare("DELETE FROM email_accounts WHERE id = ?").run("relationship-account");
    expect(legacy.sqlite.prepare(
      "SELECT id FROM email_messages WHERE id = 'relationship-email'",
    ).get()).toBeUndefined();

    legacy.sqlite.prepare("DELETE FROM conversation_threads WHERE id = ?").run("relationship-thread");
    expect(legacy.sqlite.prepare(
      "SELECT id FROM messages WHERE id IN ('relationship-message', 'relationship-unified')",
    ).all()).toEqual([]);
    expect(legacy.sqlite.prepare(
      "SELECT id FROM unified_messages WHERE id = 'relationship-unified'",
    ).get()).toBeUndefined();

    legacy.sqlite.prepare("DELETE FROM lawyers WHERE id = ?").run("relationship-lawyer");
    expect(legacy.sqlite.prepare(
      "SELECT id FROM outreach_status WHERE id = 'relationship-outreach'",
    ).get()).toBeUndefined();
    expect(legacy.sqlite.prepare(
      "SELECT lawyerId FROM notifications WHERE id = 'relationship-notification'",
    ).get()).toEqual({ lawyerId: null });

    legacy.sqlite.prepare("DELETE FROM evidence WHERE id = ?").run("relationship-evidence");
    expect(legacy.sqlite.prepare(
      "SELECT evidenceFileId FROM notifications WHERE id = 'relationship-notification'",
    ).get()).toEqual({ evidenceFileId: null });
    legacy.sqlite.prepare("DELETE FROM evidence_tags WHERE id = ?").run("relationship-tag");
    expect(legacy.sqlite.prepare(
      "SELECT id FROM evidence_file_tags WHERE id = 'relationship-file-tag'",
    ).get()).toBeUndefined();

    expect(() => legacy.sqlite.prepare(
      "DELETE FROM users WHERE id = ?",
    ).run("relationship-user")).toThrow(/FOREIGN KEY constraint failed/i);
    expect(legacy.sqlite.prepare(
      "SELECT id FROM cases WHERE id = 'relationship-case'",
    ).get()).toEqual({ id: "relationship-case" });
    legacy.sqlite.prepare("DELETE FROM document_inbox WHERE id = ?").run("relationship-inbox");
    legacy.sqlite.prepare("DELETE FROM users WHERE id = ?").run("relationship-user");
    expect(legacy.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    legacy.sqlite.close();
  });

  it("normalizes valid legacy numeric text without losing fractions, counts, or artifacts", async () => {
    const legacy = temporaryDatabase("numeric-normalization");
    applyLegacySnapshot(legacy.sqlite, 31);
    legacy.sqlite.exec(`
      INSERT INTO users (id, email, role)
      VALUES ('numeric-user', 'numeric@example.test', 'user');
      INSERT INTO cases (id, userId)
      VALUES ('numeric-case', 'numeric-user');
      INSERT INTO lawyers (
        id, name, totalOutreaches, totalResponses, totalAcceptances,
        averageResponseTimeHours, caseLoad, experienceYears,
        capacityPercentage, directoryDistanceKm
      ) VALUES (
        'numeric-lawyer-a', 'Numeric Lawyer A', '9', '4', '2',
        '3.50', '7', '12', '62.5', '4.25'
      ), (
        'numeric-lawyer-b', 'Numeric Lawyer B', '11', '5', '3',
        '1.25', '8e0', '8', '50', '7.75'
      );
      INSERT INTO evidence (id, caseId, userId, type, title, fileSize)
      VALUES ('numeric-evidence', 'numeric-case', 'numeric-user', 'document', 'Numeric evidence', '4096');
      INSERT INTO outreach_status (
        id, caseId, lawyerId, status, responseTimeHours, lawyerCapacityPercentage
      ) VALUES (
        'numeric-outreach', 'numeric-case', 'numeric-lawyer-a', 'Interested', '1.75', '62.5'
      );
      INSERT INTO usage_tracking (id, userId, resourceType, quantity)
      VALUES ('numeric-usage', 'numeric-user', 'analysis', '+6e0');
      CREATE INDEX numeric_fixture_lawyer_response_idx ON lawyers(averageResponseTimeHours);
    `);
    expect(legacy.sqlite.prepare(`
      SELECT typeof(totalOutreaches) AS countType,
             typeof(averageResponseTimeHours) AS durationType
      FROM lawyers WHERE id = 'numeric-lawyer-a'
    `).get()).toEqual({ countType: "text", durationType: "text" });

    const result = await migrateFixture(legacy);
    expect(result).toMatchObject({
      migrationsApplied: 2,
      normalizedNumericColumns: 27,
      numericTablesRebuilt: 10,
    });
    expect(result.backupPath).toBeTruthy();
    expect(legacy.sqlite.prepare(`
      SELECT totalOutreaches, averageResponseTimeHours, capacityPercentage,
             directoryDistanceKm, typeof(totalOutreaches) AS countType,
             typeof(averageResponseTimeHours) AS durationType
      FROM lawyers WHERE id = 'numeric-lawyer-a'
    `).get()).toEqual({
      totalOutreaches: 9,
      averageResponseTimeHours: 3.5,
      capacityPercentage: 62.5,
      directoryDistanceKm: 4.25,
      countType: "integer",
      durationType: "real",
    });
    expect(legacy.sqlite.prepare(
      "SELECT sum(totalOutreaches) AS outreaches, sum(totalResponses) AS responses FROM lawyers",
    ).get()).toEqual({ outreaches: 20, responses: 9 });
    expect(legacy.sqlite.prepare(`
      SELECT fileSize, typeof(fileSize) AS storage FROM evidence WHERE id = 'numeric-evidence'
    `).get()).toEqual({ fileSize: 4096, storage: "integer" });
    expect(legacy.sqlite.prepare(`
      SELECT responseTimeHours, lawyerCapacityPercentage,
             typeof(responseTimeHours) AS durationType
      FROM outreach_status WHERE id = 'numeric-outreach'
    `).get()).toEqual({ responseTimeHours: 1.75, lawyerCapacityPercentage: 62.5, durationType: "real" });
    expect(legacy.sqlite.prepare(
      "SELECT quantity, typeof(quantity) AS storage FROM usage_tracking WHERE id = 'numeric-usage'",
    ).get()).toEqual({ quantity: 6, storage: "integer" });
    expect(legacy.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'numeric_fixture_lawyer_response_idx'",
    ).get()).toEqual({ name: "numeric_fixture_lawyer_response_idx" });
    expect(legacy.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => legacy.sqlite.prepare(
      "UPDATE lawyers SET totalOutreaches = -1 WHERE id = 'numeric-lawyer-a'",
    ).run()).toThrow(/CHECK constraint failed/i);
    expect(() => legacy.sqlite.prepare(
      "UPDATE lawyers SET capacityPercentage = 101 WHERE id = 'numeric-lawyer-a'",
    ).run()).toThrow(/CHECK constraint failed/i);

    const backup = new Database(result.backupPath!, { readonly: true, fileMustExist: true });
    expect(backup.prepare(`
      SELECT totalOutreaches, averageResponseTimeHours,
             typeof(totalOutreaches) AS countType,
             typeof(averageResponseTimeHours) AS durationType
      FROM lawyers WHERE id = 'numeric-lawyer-a'
    `).get()).toEqual({
      totalOutreaches: "9",
      averageResponseTimeHours: "3.50",
      countType: "text",
      durationType: "text",
    });
    expect(backup.pragma("quick_check")).toEqual([{ quick_check: "ok" }]);
    backup.close();

    const secondBoot = await migrateFixture(legacy);
    expect(secondBoot).toMatchObject({
      backupPath: null,
      migrationsApplied: 0,
      normalizedNumericColumns: 27,
      numericTablesRebuilt: 0,
      schemaSignature: result.schemaSignature,
    });
    legacy.sqlite.close();
  });

  it("reports malformed legacy numeric fields before mutating the database", async () => {
    const legacy = temporaryDatabase("numeric-invalid");
    applyLegacySnapshot(legacy.sqlite, 31);
    legacy.sqlite.exec(`
      INSERT INTO users (id, email, role)
      VALUES ('numeric-invalid-user', 'numeric-invalid@example.test', 'user');
      INSERT INTO lawyers (id, name, totalOutreaches)
      VALUES ('numeric-invalid-lawyer', 'Invalid Numeric Lawyer', '12x');
    `);

    let error: unknown;
    try {
      await migrateFixture(legacy);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /reviewed legacy-value repair before upgrade: lawyers\.totalOutreaches \(1\)/,
    );
    expect((error as Error).message).not.toContain("12x");
    expect(legacy.sqlite.prepare(
      "SELECT totalOutreaches, typeof(totalOutreaches) AS storage FROM lawyers WHERE id = 'numeric-invalid-lawyer'",
    ).get()).toEqual({ totalOutreaches: "12x", storage: "text" });
    expect(legacy.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'laro_numeric_baseline'",
    ).get()).toBeUndefined();
    expect(readdirSync(join(legacy.directory, "db-backups"))).toHaveLength(1);
    legacy.sqlite.close();
  });

  it("archives obsolete billing compatibility data and leaves only local usage telemetry", async () => {
    const legacy = temporaryDatabase("billing-compatibility");
    applyLegacySnapshot(legacy.sqlite, 32);
    legacy.sqlite.exec(`
      INSERT INTO users (
        id, email, role, stripeCustomerId, stripeSubscriptionId,
        subscriptionStatus, subscriptionTier, paymentFailedAt, gracePeriodEndsAt
      ) VALUES (
        'billing-user', 'billing@example.test', 'user', 'cus_legacy', 'sub_legacy',
        'past_due', 'legacy-pro', 1790000000000, 1790003600000
      );
      INSERT INTO cases (id, userId, clientName)
      VALUES ('billing-case', 'billing-user', 'Billing archive case');
      INSERT INTO billing_periods (
        id, userId, stripeSubscriptionId, stripeInvoiceId, status,
        totalCost, totalBilledCost
      ) VALUES (
        'billing-period', 'billing-user', 'sub_legacy', 'in_legacy',
        'completed', '12.50', '12.50'
      );
      INSERT INTO usage_limits (
        id, userId, tier, resourceType, monthlyLimit, description, limitsJson
      ) VALUES (
        'billing-limit', 'billing-user', 'legacy-pro', 'case_analysis',
        '100', 'Historical limit', '{"case_analysis":100}'
      );
      INSERT INTO usage_tracking (
        id, userId, resourceType, quantity, baseCost, billedCost,
        metadata, caseId, reportedToStripe, stripeUsageRecordId
      ) VALUES (
        'billing-usage', 'billing-user', 'case_analysis', 4, '0.25',
        '1.00', '{"source":"legacy"}', 'billing-case', 1, 'usage_legacy'
      );
    `);

    const result = await migrateFixture(legacy);
    expect(result.migrationsApplied).toBe(1);
    expect(result.backupPath).toBeTruthy();
    expect(legacy.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('billing_periods', 'usage_limits')",
    ).all()).toEqual([]);
    const userColumns = legacy.sqlite.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(userColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      "stripeCustomerId", "stripeSubscriptionId", "subscriptionStatus", "subscriptionTier",
      "paymentFailedAt", "gracePeriodEndsAt",
    ]));
    const usageColumns = legacy.sqlite.prepare("PRAGMA table_info(usage_tracking)").all() as Array<{ name: string }>;
    expect(usageColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      "baseCost", "billedCost", "reportedToStripe", "stripeUsageRecordId",
    ]));
    expect(legacy.sqlite.prepare(
      "SELECT quantity, metadata FROM usage_tracking WHERE id = 'billing-usage'",
    ).get()).toEqual({ quantity: 4, metadata: '{"source":"legacy"}' });

    const archiveRows = legacy.sqlite.prepare(
      "SELECT sourceTable, sourceId, ownerId, payload FROM legacy_billing_archive ORDER BY sourceTable",
    ).all() as Array<{ sourceTable: string; sourceId: string; ownerId: string | null; payload: string }>;
    expect(archiveRows.map((row) => `${row.sourceTable}:${row.sourceId}`)).toEqual([
      "billing_periods:billing-period",
      "usage_limits:billing-limit",
      "usage_tracking:billing-usage",
      "users:billing-user",
    ]);
    expect(JSON.parse(archiveRows.find((row) => row.sourceTable === "users")!.payload)).toMatchObject({
      stripeCustomerId: "cus_legacy",
      subscriptionStatus: "past_due",
      subscriptionTier: "legacy-pro",
    });
    expect(JSON.parse(archiveRows.find((row) => row.sourceTable === "usage_tracking")!.payload)).toMatchObject({
      // The archive captures the pre-normalization legacy representation;
      // the active usage_tracking row is normalized to an integer afterward.
      quantity: "4",
      baseCost: "0.25",
      billedCost: "1.00",
      reportedToStripe: 1,
      stripeUsageRecordId: "usage_legacy",
    });

    expect(() => legacy.sqlite.prepare(
      "INSERT INTO legacy_billing_archive (id, sourceTable, sourceId, payload, archivedAt) VALUES ('x', 'x', 'x', '{}', 0)",
    ).run()).toThrow(/read-only/i);
    expect(() => legacy.sqlite.prepare(
      "DELETE FROM legacy_billing_archive WHERE sourceId = 'billing-user'",
    ).run()).toThrow(/read-only/i);
    expect(legacy.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const secondBoot = await migrateFixture(legacy);
    expect(secondBoot).toMatchObject({
      backupPath: null,
      migrationsApplied: 0,
      schemaSignature: result.schemaSignature,
    });
    legacy.sqlite.close();
  });
});
