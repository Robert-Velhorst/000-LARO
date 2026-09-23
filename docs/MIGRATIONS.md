# Database Migrations & Rollback Safety

Updated: 2026-09-23

## How migrations run

- Migrations live in reviewed `drizzle/*.sql` files with bookkeeping
  in `drizzle/meta/_journal.json`.
- They apply automatically on first DB open (`server/db.ts:getDb`) through the
  fail-closed runner in `server/sqliteMigrations.ts`.
- A clean installation applies the complete journal and must converge exactly
  to the declared Drizzle table and column schema.
- An existing installation must have a contiguous, checksum-matching migration
  history and the expected table/column shape for its recorded version. Unknown
  tables, columns, types, nullability, primary-key shape, history gaps, and
  changed migration hashes stop startup before any migration is run.
- Before an existing database is upgraded, the runner creates an online SQLite
  backup under `<db-dir>/db-backups/`, applies mode `0600`, and verifies
  `quick_check`, `foreign_key_check`, and the core table set. A backup failure
  stops the upgrade.
- Migration `0030_non_destructive_baseline.sql` is the first explicit baseline.
  Its compatibility step adds only the two classified legacy password-reset
  columns with their declared `TEXT` type. It records reconciliation only after
  the transaction succeeds.
- Startup never invents arbitrary missing columns, replays historical statements
  individually, suppresses SQL errors, or stamps unverified history as applied.
- Migration `0031_native_relationships.sql` establishes the relationship
  reconciliation marker. Because SQLite cannot add a foreign key in place, the
  compatibility runner rebuilds only affected tables inside one transaction,
  copies every declared column and row, and restores non-legacy indexes and
  triggers.
- The runner derives the required relationship set and delete policies from
  `server/schema.ts`. It refuses to mutate a database with relationship orphans
  or an existing foreign key whose policy differs, removes obsolete
  `laro_ri_*` triggers, and commits only after every declaration is installed
  and `PRAGMA foreign_key_check` is clean.
- Migration `0032_numeric_normalization.sql` establishes the numeric-storage
  reconciliation marker. The compatibility runner first scans every selected
  legacy value against the declared storage type and bounds. Any malformed
  field stops the upgrade with only its table/column name and invalid-row count;
  source values are never written to the error message.
- After the verified backup and preflight succeed, the runner transactionally
  rebuilds the ten affected tables, converts 27 fields to `INTEGER` or `REAL`,
  restores indexes and non-legacy triggers, and installs storage-class and
  range checks. It then verifies the declared types, values, foreign keys, and
  reconciliation marker before committing. Units and bounds are documented in
  `NUMERIC_STORAGE.md`.
- Migration `0033_billing_compatibility_archive.sql` copies non-empty historical
  payment, subscription, Stripe, quota, and monetary values into the
  owner-aware `legacy_billing_archive` JSON table, removes the obsolete active
  columns/tables, and leaves only quantity/provenance usage telemetry. Insert,
  update, and delete triggers make the archive read-only after the copy. Clean
  installs and upgrades therefore converge on the same local-unmetered model;
  the migration never creates a checkout or quota gate.
- Integrity indexes are ensured after schema and relationship validation.

## Rollback strategy — file snapshot

SQLite has no automatic down-migrations, so rollback is a **file snapshot**:
take a backup **before** changing the schema, restore it if a migration fails.

```bash
# Back up (writes to <db-dir>/db-backups/…):
npm run db:backup                 # uses DATABASE_URL, else ./laro.sqlite

# Validate and restore a backup while the application is stopped:
npm run db:validate -- "<path-to>.bak"
npm run db:restore -- "<path-to>.bak"
```

The online SQLite backup includes committed WAL state in one consistent file.
Restore stages and validates the replacement and preserves the previous database.

## Recommended flow for a schema change

1. `npm run db:backup` (snapshot).
2. Update `server/schema.ts` and add a reviewed, versioned SQL migration. If a
   legacy shape needs reconciliation, classify that exact shape in
   `server/sqliteMigrations.ts`; do not add a generic boot-time repair.
3. Deploy; migrations apply on next boot.
4. If something is wrong, restore the snapshot with `--restore`.

## Compatibility boundary

- Databases created outside the versioned journal (for example, an old
  `db:push` database with no migration history) are not guessed into shape.
  Preserve the file, validate a separate backup, and add a reviewed fixture and
  compatibility migration for that exact source version.
- Migration `0001` contains historical table rebuilds. It is used only as part
  of the contiguous journal for a clean database or a database whose recorded
  version predates it; it is never replayed over a newer schema.
- Databases with reported relationship orphans must be backed up and repaired
  on the prior release with `admin.reconcileReport` plus an explicitly reviewed
  `admin.repairOrphans` operation before retrying migration `0031`.
- Databases with a `0032` numeric preflight report must be repaired on the
  prior release from a reviewed backup. Retry only after every reported field
  contains null or a valid in-range number; the runner does not guess or discard
  malformed values.
- A `0033` archive is intentionally append-free after migration. If a legacy
  billing row is needed for audit, read the archived JSON from a verified backup;
  do not disable the archive triggers or recreate the removed active tables.
