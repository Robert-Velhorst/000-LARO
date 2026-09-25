# Data Reconciliation & Repair

Updated: 2026-09-23

All maintained owner, case, account, lawyer, settings, file-tag, and conversation
relationships are declared as native SQLite foreign keys in `server/schema.ts`.
Migration `0031` performs a backup-guarded transactional rebuild for historical
tables that lack those declarations. It preserves valid rows and user-created
indexes, removes the retired `laro_ri_*` trigger layer, and fails before mutation
when existing relationship orphans require an operator decision.

`server/reconcile.ts` detects historical drift across the same relationship
registry and supports an explicit transactional repair.

## Detect (read-only)
`reconcileReport()` returns:
- `orphanedByCaseId` — child rows whose `caseId` has no matching case,
- `orphanedByUserId` — rows whose `userId` has no matching user,
- `orphanedByRelationship` — every broken guarded relationship, keyed as
  `child.column->parent.column`,
- `duplicateEmails` — users sharing an email (should be none post-Phase-005),
- `totalOrphans`.

## Repair
`repairOrphans()` deletes orphaned rows inside a transaction and returns per-table
and column counts. It only removes rows whose referenced parent is absent. Create
and validate a backup before repairing a real target database.

## Verification
`tests/backend/relationshipIntegrity.backend.test.ts` verifies native-key
installation, insert/update rejection, parent-delete cascading, relationship
reporting, and explicit repair. `tests/backend/sqliteMigrationBaseline.test.ts`
also upgrades a populated pre-0031 fixture and proves row/index preservation,
cascade, set-null, and restrict behavior, legacy-trigger removal, and a clean
`PRAGMA foreign_key_check`. Production readiness fails closed on either a missing
declaration or an existing violation.
