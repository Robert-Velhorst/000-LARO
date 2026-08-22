import { eq, desc, sql, and, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import * as schema from "./schema";
import { InsertUser, users, lawyers, cases, outreachStatus, emailActivity, systemConfig, evidence } from "./schema";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { ENV } from './_core/env';
import { createCaseId } from './ids';
import { ensureRelationshipIntegrityTriggers } from './relationshipIntegrity';
import { assertDatabaseRuntimeIsSupported } from './persistence/hostedPersistenceGuard';

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;

// Determine DB path (using .laro.sqlite in current dir for now, 
// will be refined in Electron to use app.getPath('userData'))
function getDbPath() {
  return process.env.DATABASE_URL || "laro.sqlite";
}

/**
 * Phase 005 — persistence hardening.
 *
 * Apply connection PRAGMAs that SQLite does NOT persist across connections:
 *  - WAL journal mode: better read/write concurrency for the in-process server.
 *  - foreign_keys ON: enforce referential integrity where FKs are declared
 *    (they are being introduced incrementally; enabling this now makes any new
 *    FK actually enforced instead of silently ignored).
 *  - busy_timeout: wait instead of throwing SQLITE_BUSY under brief contention.
 */
function applyConnectionPragmas(sqlite: InstanceType<typeof Database>) {
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    console.log("[Database] Applied PRAGMAs: WAL, foreign_keys=ON, busy_timeout=5000.");
  } catch (e) {
    console.warn("[Database] Could not apply connection PRAGMAs:", e);
  }
}

/**
 * Phase 005 — data integrity via indexes and a unique constraint on user email.
 *
 * The schema historically shipped with almost no indexes and no unique
 * constraint on `users.email`, allowing duplicate accounts and unindexed hot
 * lookups. These are created idempotently at boot (IF NOT EXISTS) so they apply
 * to existing on-disk databases without a destructive migration.
 *
 * The unique email index is created defensively: if a legacy DB already contains
 * duplicate emails the CREATE fails, and we log a clear warning instead of
 * crashing boot (the duplicates must then be reconciled — see Phase 054).
 */
function ensureIndexes(sqlite: InstanceType<typeof Database>) {
  // Unique email — enforce one account per address. Signup already checks for
  // an existing email, so this closes the race/duplicate gap at the DB level.
  try {
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(email) WHERE email IS NOT NULL;`
    );
  } catch (e) {
    console.warn(
      "[Database] Could not create unique index users_email_unique (likely pre-existing duplicate emails; reconcile then retry):",
      e
    );
  }

  // Provider account identity is case-insensitive. Repoint children to the
  // newest connected legacy row before normalizing and enforcing uniqueness.
  try {
    const reconcileProviderAccounts = sqlite.transaction(() => {
      const rows = sqlite.prepare(`
        SELECT id, userId, provider, email, status, updatedAt, createdAt, rowid
        FROM email_accounts
        WHERE provider IS NOT NULL AND email IS NOT NULL
        ORDER BY
          CASE WHEN status = 'connected' THEN 0 ELSE 1 END,
          COALESCE(updatedAt, 0) DESC,
          COALESCE(createdAt, 0) DESC,
          rowid DESC
      `).all() as Array<{
        id: string;
        userId: string;
        provider: string;
        email: string;
      }>;
      const survivors = new Map<string, string>();
      let duplicateCount = 0;
      for (const row of rows) {
        const key = `${row.userId}\u0000${row.provider}\u0000${row.email.trim().toLowerCase()}`;
        const survivorId = survivors.get(key);
        if (!survivorId) {
          survivors.set(key, row.id);
          continue;
        }
        for (const table of ['email_sync_jobs', 'email_messages', 'google_drive_files']) {
          sqlite.prepare(`UPDATE ${table} SET accountId = ? WHERE accountId = ?`).run(survivorId, row.id);
        }
        sqlite.prepare(`DELETE FROM email_accounts WHERE id = ?`).run(row.id);
        duplicateCount += 1;
      }
      sqlite.exec(`
        UPDATE email_accounts
        SET email = lower(trim(email))
        WHERE email IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS email_accounts_identity_unique
          ON email_accounts(userId, provider, email)
          WHERE provider IS NOT NULL AND email IS NOT NULL;
      `);
      return duplicateCount;
    });
    const duplicateCount = reconcileProviderAccounts();
    if (duplicateCount > 0) {
      console.warn(`[Database] Reconciled ${duplicateCount} duplicate provider account row(s).`);
    }
  } catch (e) {
    console.warn('[Database] Could not reconcile or index provider account identities:', e);
  }

  // Phase 017 — idempotency / duplicate-action prevention: a case may only have
  // ONE outreach row per lawyer. This makes "initiate outreach" idempotent at
  // the DB level (a duplicate insert is rejected). Created defensively.
  try {
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS outreach_status_case_lawyer_unique ON outreach_status(caseId, lawyerId);`
    );
  } catch (e) {
    console.warn(
      "[Database] Could not create unique index outreach_status_case_lawyer_unique (pre-existing duplicates?):",
      e
    );
  }

  // Keyed preferences are snapshots, so duplicate rows make reads ambiguous and
  // can lose a user's latest privacy or workflow setting. Keep the newest legacy
  // row before enforcing the invariant for all future writes.
  try {
    const duplicateCount = (sqlite.prepare(`
      SELECT COALESCE(SUM(rowCount - 1), 0) AS count
      FROM (
        SELECT COUNT(*) AS rowCount
        FROM user_preferences
        WHERE key IS NOT NULL
        GROUP BY userId, key
        HAVING COUNT(*) > 1
      )
    `).get() as { count: number }).count;
    if (duplicateCount > 0) {
      sqlite.exec(`
        DELETE FROM user_preferences
        WHERE rowid IN (
          SELECT rowid FROM (
            SELECT
              rowid,
              ROW_NUMBER() OVER (
                PARTITION BY userId, key
                ORDER BY COALESCE(updatedAt, 0) DESC, rowid DESC
              ) AS preferenceRank
            FROM user_preferences
            WHERE key IS NOT NULL
          )
          WHERE preferenceRank > 1
        );
      `);
      console.warn(`[Database] Reconciled ${duplicateCount} duplicate keyed preference row(s).`);
    }
    sqlite.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS user_preferences_user_key_unique ON user_preferences(userId, key);`
    );
  } catch (e) {
    console.warn("[Database] Could not reconcile or index keyed user preferences:", e);
  }

  // Hot-path indexes for the highest-traffic lookups (outreach, evidence, email,
  // messaging, lawyer rating). All idempotent.
  const indexStatements = [
    // Phase 051: back the cases.list filters/sort (status, urgency, updatedAt).
    `CREATE INDEX IF NOT EXISTS cases_userId_status_idx ON cases(userId, status);`,
    `CREATE INDEX IF NOT EXISTS cases_urgency_idx ON cases(urgency);`,
    `CREATE INDEX IF NOT EXISTS cases_updatedAt_idx ON cases(updatedAt);`,
    `CREATE INDEX IF NOT EXISTS cases_userId_createdAt_idx ON cases(userId, createdAt);`,
    `CREATE INDEX IF NOT EXISTS cases_userId_updatedAt_idx ON cases(userId, updatedAt);`,
    `CREATE INDEX IF NOT EXISTS cases_userId_status_createdAt_idx ON cases(userId, status, createdAt);`,
    `CREATE INDEX IF NOT EXISTS cases_userId_urgency_createdAt_idx ON cases(userId, urgency, createdAt);`,
    `CREATE INDEX IF NOT EXISTS cases_userId_status_urgency_createdAt_idx ON cases(userId, status, urgency, createdAt);`,
    `CREATE INDEX IF NOT EXISTS cases_userId_clientName_idx ON cases(userId, clientName);`,
    `CREATE INDEX IF NOT EXISTS document_analyses_user_updatedAt_idx ON document_analyses(userId, updatedAt);`,
    `CREATE INDEX IF NOT EXISTS outreach_status_caseId_idx ON outreach_status(caseId);`,
    `CREATE INDEX IF NOT EXISTS outreach_status_lawyerId_idx ON outreach_status(lawyerId);`,
    `CREATE INDEX IF NOT EXISTS outreach_status_status_idx ON outreach_status(status);`,
    `CREATE INDEX IF NOT EXISTS email_messages_accountId_idx ON email_messages(accountId);`,
    `CREATE INDEX IF NOT EXISTS email_activity_caseId_idx ON email_activity(caseId);`,
    `CREATE INDEX IF NOT EXISTS lawyer_interactions_lawyerId_idx ON lawyer_interactions(lawyerId);`,
    `CREATE INDEX IF NOT EXISTS evidence_items_userId_idx ON evidence_items(userId);`,
    `CREATE INDEX IF NOT EXISTS unified_messages_userId_idx ON unified_messages(userId);`,
    `CREATE INDEX IF NOT EXISTS notifications_userId_idx ON notifications(userId);`,
    `CREATE INDEX IF NOT EXISTS audit_logs_userId_idx ON audit_logs(userId);`,
    `CREATE INDEX IF NOT EXISTS audit_logs_createdAt_idx ON audit_logs(createdAt);`,
  ];
  for (const stmt of indexStatements) {
    try {
      sqlite.exec(stmt);
    } catch (e) {
      // A table may not exist yet on a partially-migrated DB; ignore and let a
      // later boot create it once migrations have run.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.toLowerCase().includes("no such table")) {
        console.warn("[Database] Could not create index:", stmt, msg);
      }
    }
  }
  console.log("[Database] Ensured integrity indexes (Phase 005).");
}

function ensureSupportTicketsTable(sqlite: InstanceType<typeof Database>) {
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id TEXT PRIMARY KEY NOT NULL,
        userId TEXT,
        category TEXT NOT NULL,
        subject TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'open',
        createdAt INTEGER NOT NULL
      );
    `);
  } catch (e) {
    console.warn("[Database] Could not ensure support_tickets table:", e);
  }
}

export function ensureStorageDeletionQueueTable(sqlite: InstanceType<typeof Database>) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS storage_deletion_queue (
      id TEXT PRIMARY KEY NOT NULL,
      storageKey TEXT NOT NULL,
      attempts INTEGER DEFAULT 0 NOT NULL,
      lastError TEXT,
      nextAttemptAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS storage_deletion_queue_storageKey_unique
      ON storage_deletion_queue(storageKey);
    CREATE INDEX IF NOT EXISTS storage_deletion_queue_nextAttemptAt_idx
      ON storage_deletion_queue(nextAttemptAt);
  `);
}

function ensureAllTablesColumns(sqlite: InstanceType<typeof Database>) {
  for (const key of Object.keys(schema)) {
    const table = (schema as any)[key];
    try {
      // Use Drizzle's getTableConfig to reflect the schema
      const config = getTableConfig(table);
      if (!config || !config.name || !config.columns) continue;

      const dbColumns = sqlite.prepare(`PRAGMA table_info("${config.name}")`).all() as Array<{ name: string }>;
      if (dbColumns.length === 0) continue; // Table not created yet, migration will handle it

      const existing = new Set(dbColumns.map((c) => c.name));

      for (const col of config.columns) {
        if (!existing.has(col.name)) {
          // Default to TEXT for missing columns to satisfy the migration SELECTs
          sqlite.exec(`ALTER TABLE "${config.name}" ADD COLUMN "${col.name}" TEXT;`);
          console.log(`[Database] Added missing column ${config.name}.${col.name} before migration.`);
        }
      }
    } catch (e) {
      // Ignore exports that aren't tables
    }
  }
}

/**
 * Idempotent migration replay: reads each .sql migration file in the drizzle
 * folder, splits on `--> statement-breakpoint`, and runs every statement
 * individually — swallowing "already exists" / "duplicate column" type errors.
 *
 * This is the safety net for production: drizzle's migrator relies on the
 * `__drizzle_migrations` bookkeeping table, which can disagree with the actual
 * DB state in a portable Electron build (e.g. a stale userData DB created by
 * `db:push` or a previous partial run). Replaying SQL idempotently guarantees
 * that every table in the schema exists regardless of bookkeeping state.
 */
function replayMigrationsIdempotent(
  sqlite: InstanceType<typeof Database>,
  migrationsFolder: string
) {
  const isIgnorable = (msg: string) => {
    const m = msg.toLowerCase();
    return (
      m.includes("already exists") ||
      m.includes("duplicate column name") ||
      m.includes("no such column") || // for ALTER TABLE on already-migrated schema
      m.includes("no such table") // for DROP TABLE on already-cleaned schema
    );
  };

  let sqlFiles: string[];
  try {
    sqlFiles = fs
      .readdirSync(migrationsFolder)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (e) {
    console.warn("[Database] Could not enumerate migration folder:", e);
    return;
  }

  for (const file of sqlFiles) {
    const fullPath = path.join(migrationsFolder, file);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf8");
    } catch (e) {
      console.warn(`[Database] Could not read migration ${file}:`, e);
      continue;
    }

    const statements = content
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    let applied = 0;
    let skipped = 0;
    for (const stmt of statements) {
      try {
        sqlite.exec(stmt);
        applied++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isIgnorable(msg)) {
          skipped++;
          continue;
        }
        console.warn(
          `[Database] Idempotent replay: statement in ${file} failed (continuing):`,
          msg
        );
      }
    }
    console.log(
      `[Database] Replayed ${file}: ${applied} applied, ${skipped} skipped (already present).`
    );
  }
}

function tableExists(sqlite: InstanceType<typeof Database>, name: string): boolean {
  try {
    const row = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Mark every migration in the folder as applied in drizzle's bookkeeping
 * table, so subsequent boots take the happy path (drizzle's migrate() becomes
 * a no-op instead of trying to re-create tables we've already created via
 * recovery replay).
 *
 * Drizzle's bookkeeping table is `__drizzle_migrations` with columns
 * (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC). The hash
 * is the SHA-256 of the migration SQL content.
 */
function stampMigrationsAsApplied(
  sqlite: InstanceType<typeof Database>,
  migrationsFolder: string
) {
  try {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS __drizzle_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL,
        created_at NUMERIC
      );
    `);

    const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };

    const crypto = require("crypto") as typeof import("crypto");
    const existing = sqlite.prepare("SELECT hash FROM __drizzle_migrations").all() as Array<{
      hash: string;
    }>;
    const known = new Set(existing.map((r) => r.hash));

    const insert = sqlite.prepare(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)"
    );

    for (const entry of journal.entries) {
      const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`);
      if (!fs.existsSync(sqlPath)) continue;
      const content = fs.readFileSync(sqlPath, "utf8");
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      if (known.has(hash)) continue;
      insert.run(hash, entry.when);
      console.log(`[Database] Stamped migration ${entry.tag} as applied.`);
    }
  } catch (e) {
    console.warn("[Database] Could not stamp migrations as applied:", e);
  }
}

function findMigrationsFolder(): string {
  const candidates = [
    path.join((process as any).resourcesPath || "", "app.asar.unpacked", "drizzle"),
    path.join(process.cwd(), "drizzle"),
    path.join(__dirname, "..", "..", "drizzle"),
    path.join(__dirname, "..", "..", "..", "drizzle"),
    path.join((process as any).resourcesPath || "", "app", "drizzle"),
    path.join((process as any).resourcesPath || "", "drizzle"),
  ];

  for (const p of candidates) {
    const journal = path.join(p, "meta", "_journal.json");
    if (fs.existsSync(p) && fs.existsSync(journal)) {
      console.log("[Database] Using migrations folder:", p);
      return p;
    }
  }

  console.warn(
    "[Database] No migrations folder found. Tried:\n" +
      candidates.map((c) => "  - " + c).join("\n")
  );
  return "";
}

export async function getDb() {
  if (!_db) {
    try {
      assertDatabaseRuntimeIsSupported({
        runtimeMode: ENV.LARO_RUNTIME_MODE,
        databaseUrl: ENV.DATABASE_URL,
      });
      const dbPath = getDbPath();
      const sqlite = new Database(dbPath);
      _sqlite = sqlite;
      _db = drizzle(sqlite);
      applyConnectionPragmas(sqlite); // Phase 005: WAL, foreign_keys, busy_timeout
      console.log("[Database] SQLite initialized at:", dbPath);

      const foundFolder = findMigrationsFolder();

      if (foundFolder) {
        // Try drizzle's bookkeeping-based migrator first (the happy path on a
        // clean install). Failures here are not fatal because we have a
        // recovery replay below.
        let migrateSucceeded = false;
        try {
          migrate(_db, { migrationsFolder: foundFolder });
          migrateSucceeded = true;
          console.log("[Database] drizzle migrate() succeeded.");
        } catch (migrationError: unknown) {
          const msg =
            migrationError instanceof Error ? migrationError.message : String(migrationError);
          console.warn(
            "[Database] drizzle migrate() failed; will check schema state and recover if needed:",
            msg
          );
        }

        // Destructive evidence operations require this queue. Repair it before
        // migration recovery can stamp journal entries on an installed DB.
        ensureStorageDeletionQueueTable(sqlite);

        // Recovery: if any expected core table is missing after migrate(), the
        // bookkeeping is out of sync with reality (stale userData DB, partial
        // prior run, db:push without migration entries, etc.). Replay the SQL
        // files only in that case. We skip replay on a healthy DB because
        // migration 0001 includes destructive table-rebuilds (DROP TABLE) that
        // would be unsafe to re-run on live data.
        const coreTables = ["users", "lawyers", "cases"];
        const missing = coreTables.filter((t) => !tableExists(sqlite, t));
        if (missing.length > 0) {
          console.warn(
            `[Database] Core tables missing after migrate(): ${missing.join(", ")}. Running recovery replay.`
          );
          replayMigrationsIdempotent(sqlite, foundFolder);

          // Drizzle bookkeeping is now out of sync (we ran SQL it doesn't know
          // about). Mark all migrations as applied so subsequent boots use the
          // happy path.
          stampMigrationsAsApplied(sqlite, foundFolder);
        } else if (!migrateSucceeded) {
          // migrate() failed but tables exist — likely a benign "already
          // exists" on a re-run. Still stamp bookkeeping so next boot is clean.
          stampMigrationsAsApplied(sqlite, foundFolder);
        }
      } else {
        console.warn(
          "[Database] No migrations folder found — DB will not be initialized. Auth and other features will fail until this is resolved."
        );
      }

      // Legacy databases may predate this table, but creating it before the
      // migrator makes a fresh 0001 migration fail with "table already exists".
      ensureSupportTicketsTable(sqlite);

      // Run column alignment AFTER migrations to backfill any columns that the
      // schema declares but the on-disk DB is missing (e.g. schema.ts was
      // updated without generating a new migration).
      ensureAllTablesColumns(sqlite);

      // Phase 005: create integrity indexes + unique email constraint AFTER the
      // tables exist. Idempotent, so safe on every boot.
      ensureIndexes(sqlite);

      // Enforce relationships in legacy tables without rebuilding installed
      // databases. Existing inconsistencies remain visible to reconciliation;
      // new orphaned writes and parent deletes are guarded at database level.
      const relationshipTriggerCount = ensureRelationshipIntegrityTriggers(sqlite);
      console.log(`[Database] Ensured ${relationshipTriggerCount} relationship-integrity triggers.`);

    } catch (error) {
      console.error("[Database] Failed to connect to SQLite or run migrations:", error);
      try { _sqlite?.close(); } catch { /* best effort after failed initialization */ }
      _sqlite = null;
      _db = null; // Reset db if initialization fails
      throw error; // Throw so we don't silently return an empty db
    }
  }
  return _db;
}

/** Close and reset the singleton before an offline restore or shutdown. */
export function closeDatabaseForMaintenance(): void {
  if (!_sqlite) {
    _db = null;
    return;
  }

  try {
    _sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.id) {
    throw new Error("User ID is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      id: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      loginMethod: user.loginMethod ?? null,
      lastSignedIn: user.lastSignedIn ?? new Date(),
      role: user.role ?? (user.id === ENV.ownerId ? 'admin' : 'user'),
    };

    await db.insert(users).values(values).onConflictDoUpdate({
      target: users.id,
      set: {
        name: values.name,
        email: values.email,
        loginMethod: values.loginMethod,
        lastSignedIn: values.lastSignedIn,
        role: values.role,
      },
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUser(id: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// Lawyer queries
export async function getAllLawyers() {
  const db = await getDb();
  if (!db) return [];
  // SQLite orderBy uses the column directly or within desc() from drizzle-orm
  return await db.select().from(lawyers).orderBy(desc(lawyers.createdAt));
}

export async function getLawyerById(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(lawyers).where(eq(lawyers.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Case queries
export async function getAllCases() {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(cases).orderBy(desc(cases.createdAt));
}

export async function getCaseById(id: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(cases).where(eq(cases.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function getRecentCases(limit: number = 5, userId?: string) {
  const db = await getDb();
  if (!db) return [];
  
  let qb = db.select().from(cases).orderBy(desc(cases.createdAt)).limit(limit);
  
  if (userId) {
    // In SQLite Drizzle, we can chain .where() normally
    return await qb.where(eq(cases.userId, userId));
  }
  
  return await qb;
}

export async function createCase(data: {
  userId: string;
  clientName: string;
  clientEmail?: string;
  clientPhone?: string;
  clientAddress?: string;
  caseType: string;
  caseSummary: string;
  urgency: string;
  legalAreas?: string;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const caseId = createCaseId();
  
  await db.insert(cases).values({
    id: caseId,
    userId: data.userId,
    clientName: data.clientName,
    clientEmail: data.clientEmail || null,
    clientPhone: data.clientPhone || null,
    clientAddress: data.clientAddress || null,
    caseType: data.caseType,
    caseSummary: data.caseSummary,
    urgency: data.urgency,
    status: "Matching",
    legalAreas: data.legalAreas || JSON.stringify([data.caseType]),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  
  return { id: caseId, success: true };
}

export async function updateCase(caseId: string, data: {
  caseSummary?: string;
  urgency?: string;
  legalAreas?: string | string[] | any;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const updateData: any = { updatedAt: new Date() };
  if (data.caseSummary !== undefined) updateData.caseSummary = data.caseSummary;
  if (data.urgency !== undefined) updateData.urgency = data.urgency;
  
  if (data.legalAreas !== undefined) {
    const { sanitizeLegalAreas } = await import("./legalAreasValidator");
    updateData.legalAreas = sanitizeLegalAreas(data.legalAreas);
  }
  
  await db.update(cases)
    .set(updateData)
    .where(eq(cases.id, caseId));
  
  return { id: caseId, success: true };
}

// Outreach status queries
export async function getOutreachByCaseId(caseId: string) {
  const db = await getDb();
  if (!db) return [];
  
  return await db
    .select({
      id: outreachStatus.id,
      caseId: outreachStatus.caseId,
      lawyerId: outreachStatus.lawyerId,
      status: outreachStatus.status,
      initialContact: outreachStatus.initialContact,
      lastContact: outreachStatus.lastContact,
      followUpsSent: outreachStatus.followUpsSent,
      responseTimeHours: outreachStatus.responseTimeHours,
      acceptanceStatus: outreachStatus.acceptanceStatus,
      response: outreachStatus.response,
      notes: outreachStatus.notes,
      distanceKm: outreachStatus.distanceKm,
      createdAt: outreachStatus.createdAt,
      updatedAt: outreachStatus.updatedAt,
      lawyerName: lawyers.name,
      lawyerEmail: lawyers.email,
      lawyerPhone: lawyers.phone,
    })
    .from(outreachStatus)
    .leftJoin(lawyers, eq(outreachStatus.lawyerId, lawyers.id))
    .where(eq(outreachStatus.caseId, caseId));
}

export async function getInterestedMatches(limit: number = 10, userId?: string) {
  const db = await getDb();
  if (!db) return [];
  
  const query = db
    .select({
      id: outreachStatus.id,
      caseId: outreachStatus.caseId,
      lawyerId: outreachStatus.lawyerId,
      status: outreachStatus.status,
      lastContact: outreachStatus.lastContact,
      distanceKm: outreachStatus.distanceKm,
      lawyerName: lawyers.name,
      lawyerEmail: lawyers.email,
      caseName: cases.clientName,
      caseType: cases.caseType,
      userId: cases.userId,
    })
    .from(outreachStatus)
    .leftJoin(lawyers, eq(outreachStatus.lawyerId, lawyers.id))
    .leftJoin(cases, eq(outreachStatus.caseId, cases.id))
    .where(eq(outreachStatus.status, "Interested"))
    .orderBy(desc(outreachStatus.lastContact))
    .limit(limit);
  
  const results = await query;
  
  if (userId) {
    return results.filter(r => r.userId === userId);
  }
  
  return results;
}

// Email activity queries
export async function getRecentEmailActivity(limit: number = 10) {
  const db = await getDb();
  if (!db) return [];
  return await db.select().from(emailActivity)
    .orderBy(desc(emailActivity.sentAt))
    .limit(limit);
}

export async function getEmailActivityStats() {
  const db = await getDb();
  if (!db) return { total: 0, responded: 0, interested: 0, declined: 0, noResponse: 0 };
  
  const total = await db.select({ count: sql<number>`count(*)` }).from(emailActivity);
  const responded = await db.select({ count: sql<number>`count(*)` })
    .from(emailActivity)
    .where(eq(emailActivity.responseReceived, "Yes"));
  const interested = await db.select({ count: sql<number>`count(*)` })
    .from(emailActivity)
    .where(eq(emailActivity.responseStatus, "Interested"));
  const declined = await db.select({ count: sql<number>`count(*)` })
    .from(emailActivity)
    .where(eq(emailActivity.responseStatus, "Declined"));
  const noResponse = await db.select({ count: sql<number>`count(*)` })
    .from(emailActivity)
    .where(eq(emailActivity.responseStatus, "No Response"));

  return {
    total: Number(total[0]?.count || 0),
    responded: Number(responded[0]?.count || 0),
    interested: Number(interested[0]?.count || 0),
    declined: Number(declined[0]?.count || 0),
    noResponse: Number(noResponse[0]?.count || 0),
  };
}

// Dashboard statistics
export async function getDashboardStats(userId?: string) {
  const db = await getDb();
  if (!db) return {
    totalLawyers: 0,
    totalCases: 0,
    activeCases: 0,
    matchesMade: 0,
    evidenceCollected: 0,
  };

  const totalLawyers = await db.select({ count: sql<number>`count(*)` }).from(lawyers);
  
  let totalCases, activeCases, matchesMade;
  
  if (userId) {
    totalCases = await db.select({ count: sql<number>`count(*)` })
      .from(cases)
      .where(eq(cases.userId, userId));
    activeCases = await db.select({ count: sql<number>`count(*)` })
      .from(cases)
      .where(and(eq(cases.userId, userId), sql`status IN ('Matching', 'Outreach')`));
    matchesMade = await db.select({ count: sql<number>`count(*)` })
      .from(cases)
      .where(and(eq(cases.userId, userId), eq(cases.status, 'Matched')));
  } else {
    totalCases = await db.select({ count: sql<number>`count(*)` }).from(cases);
    activeCases = await db.select({ count: sql<number>`count(*)` })
      .from(cases)
      .where(sql`status IN ('Matching', 'Outreach')`);
    matchesMade = await db.select({ count: sql<number>`count(*)` })
      .from(cases)
      .where(eq(cases.status, "Matched"));
  }

  let evidenceCount;
  if (userId) {
    evidenceCount = await db.select({ count: sql<number>`count(*)` })
      .from(evidence)
      .where(eq(evidence.userId, userId));
  } else {
    evidenceCount = await db.select({ count: sql<number>`count(*)` }).from(evidence);
  }

  return {
    totalLawyers: Number(totalLawyers[0]?.count || 0),
    totalCases: Number(totalCases[0]?.count || 0),
    activeCases: Number(activeCases[0]?.count || 0),
    matchesMade: Number(matchesMade[0]?.count || 0),
    evidenceCollected: Number(evidenceCount[0]?.count || 0),
  };
}

// System config
export async function getConfig(key: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(systemConfig).where(eq(systemConfig.configKey, key)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}




// ============================================================================
// NEW MATCH SCORING SYSTEM
// ============================================================================

/**
 * Calculate response rate for a lawyer
 * Formula: (Total Responses / Total Outreaches) × 100%
 */
export async function calculateResponseRate(lawyerId: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  
  const lawyer = await db.select().from(lawyers).where(eq(lawyers.id, lawyerId)).limit(1);
  if (!lawyer.length) return 0;
  
  const totalOutreaches = parseInt(lawyer[0].totalOutreaches || "0");
  const totalResponses = parseInt(lawyer[0].totalResponses || "0");
  
  if (totalOutreaches === 0) return -1; // -1 indicates new lawyer (no history)
  
  return (totalResponses / totalOutreaches) * 100;
}

/**
 * Calculate average response time in hours for a lawyer
 */
export async function calculateAverageResponseTime(lawyerId: string): Promise<number | null> {
  const db = await getDb();
  if (!db) return null;
  
  const outreaches = await db
    .select()
    .from(outreachStatus)
    .where(
      and(
        eq(outreachStatus.lawyerId, lawyerId),
        isNotNull(outreachStatus.responseTimeHours)
      )
    );
  
  if (outreaches.length === 0) return null;
  
  const totalHours = outreaches.reduce((sum, o) => {
    return sum + parseInt(o.responseTimeHours || "0");
  }, 0);
  
  return totalHours / outreaches.length;
}

/**
 * Calculate acceptance rate for a lawyer
 * Formula: (Cases Accepted / Total Responses) × 100%
 */
export async function calculateAcceptanceRate(lawyerId: string): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  
  const lawyer = await db.select().from(lawyers).where(eq(lawyers.id, lawyerId)).limit(1);
  if (!lawyer.length) return 0;
  
  const totalResponses = parseInt(lawyer[0].totalResponses || "0");
  const totalAcceptances = parseInt(lawyer[0].totalAcceptances || "0");
  
  if (totalResponses === 0) return 0;
  
  return (totalAcceptances / totalResponses) * 100;
}

/**
 * Update lawyer statistics based on outreach history
 */
export async function updateLawyerStatistics(lawyerId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  
  // Count total outreaches
  const totalOutreaches = await db
    .select()
    .from(outreachStatus)
    .where(eq(outreachStatus.lawyerId, lawyerId));
  
  // Count responses (Interested or Declined)
  const responses = totalOutreaches.filter(o => 
    o.status === "Interested" || o.status === "Declined"
  );
  
  // Count acceptances (Interested only)
  const acceptances = totalOutreaches.filter(o => 
    o.acceptanceStatus === "Accepted"
  );
  
  // Calculate average response time
  const avgResponseTime = await calculateAverageResponseTime(lawyerId);
  
  // Update lawyer record
  await db.update(lawyers)
    .set({
      totalOutreaches: totalOutreaches.length.toString(),
      totalResponses: responses.length.toString(),
      totalAcceptances: acceptances.length.toString(),
      averageResponseTimeHours: avgResponseTime?.toString() || null,
      updatedAt: new Date(),
    })
    .where(eq(lawyers.id, lawyerId));
}

/**
 * Check if lawyer should be permanently filtered
 * Rule: 0% response rate with 3+ contacts
 */
export async function checkPermanentFilter(lawyerId: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  
  const lawyer = await db.select().from(lawyers).where(eq(lawyers.id, lawyerId)).limit(1);
  if (!lawyer.length) return false;
  
  const totalOutreaches = parseInt(lawyer[0].totalOutreaches || "0");
  const totalResponses = parseInt(lawyer[0].totalResponses || "0");
  
  // If 3+ contacts with 0 responses, permanently filter
  if (totalOutreaches >= 3 && totalResponses === 0) {
    // Set filter for 6 months
    const filterUntil = new Date();
    filterUntil.setMonth(filterUntil.getMonth() + 6);
    
    await db.update(lawyers)
      .set({
        permanentlyFiltered: "Yes",
        filterUntil: filterUntil,
        updatedAt: new Date(),
      })
      .where(eq(lawyers.id, lawyerId));
    
    return true;
  }
  
  return false;
}

/**
 * Calculate NEW match score for a lawyer
 * Maximum: ~150 points
 */
export function calculateNewMatchScore(lawyer: any, distanceKm: number): number {
  let score = 0;
  
  // 1. Case-load Score (50 points max)
  const caseLoad = parseInt(lawyer.caseLoad || "999");
  if (caseLoad <= 10) score += 50;
  else if (caseLoad <= 20) score += 30;
  else if (caseLoad <= 30) score += 10;
  // else 0 points
  
  // 2. Response Rate Score (50 points max)
  const responseRate = calculateResponseRateSync(lawyer);
  if (responseRate === -1) {
    // New lawyer - benefit of doubt
    score += 25;
  } else if (responseRate >= 80) score += 50;
  else if (responseRate >= 60) score += 30;
  else if (responseRate >= 40) score += 10;
  // else 0 points
  
  // 3. Average Response Time Score (30 points max)
  const avgResponseTime = parseFloat(lawyer.averageResponseTimeHours || "999");
  if (avgResponseTime <= 48) score += 30;
  else if (avgResponseTime <= 168) score += 20; // 7 days
  else if (avgResponseTime <= 336) score += 10; // 14 days
  // else 0 points
  
  // 4. Acceptance Rate Score (30 points max)
  const acceptanceRate = calculateAcceptanceRateSync(lawyer);
  if (acceptanceRate >= 80) score += 30;
  else if (acceptanceRate >= 60) score += 20;
  else if (acceptanceRate >= 40) score += 10;
  // else 0 points
  
  // 5. Distance Score (10 points max)
  if (distanceKm <= 25) score += 10;
  else if (distanceKm <= 50) score += 5;
  else if (distanceKm <= 100) score += 2;
  // else 0 points
  
  // 6. Years Practicing Score (10 points max)
  const yearsExp = parseInt(lawyer.experienceYears || "0");
  if (yearsExp >= 10) score += 10;
  else if (yearsExp >= 5) score += 5;
  else if (yearsExp >= 2) score += 2;
  // else 0 points
  
  return score;
}

/**
 * Synchronous helper to calculate response rate from lawyer object
 */
function calculateResponseRateSync(lawyer: any): number {
  const totalOutreaches = parseInt(lawyer.totalOutreaches || "0");
  const totalResponses = parseInt(lawyer.totalResponses || "0");
  
  if (totalOutreaches === 0) return -1; // New lawyer
  
  return (totalResponses / totalOutreaches) * 100;
}

/**
 * Synchronous helper to calculate acceptance rate from lawyer object
 */
function calculateAcceptanceRateSync(lawyer: any): number {
  const totalResponses = parseInt(lawyer.totalResponses || "0");
  const totalAcceptances = parseInt(lawyer.totalAcceptances || "0");
  
  if (totalResponses === 0) return 0;
  
  return (totalAcceptances / totalResponses) * 100;
}

/**
 * Check if lawyer passes mandatory filters
 */
export function passesMandatoryFilters(lawyer: any): boolean {
  // 1. Not on case-stop
  if (lawyer.caseStop === "Yes") return false;
  
  // 2. Good standing with Bar Association
  if (lawyer.barAssociationStatus !== "Good Standing") return false;
  
  // 3. Currently accepting cases
  if (lawyer.currentlyAccepting === "No") return false;
  
  // 4. Valid contact information
  if (!lawyer.email && !lawyer.phone) return false;
  
  // 5. Not permanently filtered
  if (lawyer.permanentlyFiltered === "Yes") {
    // Check if filter has expired
    if (lawyer.filterUntil) {
      const now = new Date();
      const filterUntil = new Date(lawyer.filterUntil);
      if (now < filterUntil) return false; // Still filtered
    } else {
      return false; // Permanently filtered with no expiry
    }
  }
  
  return true;
}

