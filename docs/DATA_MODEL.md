# Data Model, Ownership, and Persistence

Current as of 2026-08-14.

## Topology

- `laro-server.sqlite`: canonical Electron/Express application data through
  Drizzle ORM.
- `laro-agent.db`: ephemeral desktop scanner progress and review state through
  prepared SQLite statements.
- Managed evidence bytes: AWS S3 when configured, otherwise the Electron
  user-data upload directory.
- A legacy Flask command-center workspace retains a separate ledger until its
  owner-bound one-way migration. Imported source rows live in
  `legacy_import_runs` and `legacy_import_records`; there is no silent sharing.

Both SQLite connections enable WAL, foreign-key enforcement, and a 5-second busy
timeout. The scanner database declares its scan-to-file foreign key.

## Ownership

- User-owned rows carry `userId` and are filtered by the authenticated user.
- Case-scoped operations call `assertCaseOwnership`.
- Lawyer directory rows are global reference data; private case/outreach records
  remain owner-scoped.
- Media and organization directory rows are owner-scoped. Their case matches
  reference the owning user, case, and target with cascading foreign keys.
- Keyword evidence pulls are persisted in `keyword_pull_jobs`. Jobs reference
  their owner and case with cascading foreign keys and retain source phase,
  reviewed-word/item counters, ETA, terminal result, and failure detail so an
  active pull can be recovered by the UI after navigation or reload.
- Publicly discovered or manually imported targets begin as `pending`; only
  `approved` records are eligible for case matching. Revoking approval removes
  persisted matches for that target.
- Scanner uploads use a short-lived token for the signed-in user and pass through
  the same evidence ownership guard as manual uploads.

## Integrity

- User email and case/lawyer outreach pairs have unique indexes.
- Media/organization source URLs are unique per owner and category; case-target
  matches are unique per case and target.
- Evidence storage keys and filenames are sanitized and confined.
- Evidence bytes produce SHA-256 provenance stored in metadata and projected as
  `contentHash` / `hashAlgo` on reads.
- Storage is deleted if evidence-record creation fails.
- Reconciliation and invariant reports detect orphan or inconsistent records.
- Data readiness checks strict historical counters for malformed, negative, or
  JavaScript-unsafe values and verifies cross-counter relationships using
  aggregate queries. Empty compatibility values remain accepted as zero.
- Backup validation and an isolated delete/restore/reopen drill are release
  gates.

## Remaining model work

Many relationships are still application-enforced rather than declared as SQL
foreign keys. Adding constraints requires a reviewed migration after reconciling
existing installations. Some historical money and count fields remain text. A
non-mutating readiness gate now identifies incompatible count data before those
columns are normalized through the same migration discipline.
