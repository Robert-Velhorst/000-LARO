# Backup and Restore

LARO stores application metadata in SQLite, provider tokens under an encryption
key, and evidence bytes on local disk or S3. A database alone is therefore not a
complete recovery point. The Electron server path is `DATABASE_URL`; the desktop uses
`<userData>/laro-server.sqlite`, `<userData>/laro-secrets.json`, and
`<userData>/uploads`.

## Electron Backup

```powershell
npm run db:backup
npm run db:backup -- C:\Backups\laro.sqlite
```

The command uses SQLite's online backup API, then requires `PRAGMA quick_check`,
a clean foreign-key check, and the minimum LARO schema. It publishes a backup set
only after every member is complete:

- `<backup>`: the verified SQLite database;
- `<backup>.manifest.json`: database size/hash and encryption compatibility;
- `<backup>.secrets.json`: the matching desktop keys, when a valid
  `laro-secrets.json` exists beside `DATABASE_URL`;
- `<backup>.files/`: every database-referenced evidence object from local
  managed storage or S3, with per-file size and SHA-256 inventory in the
  manifest; S3 entries also retain their content type.

The manifest is renamed into place last and acts as the completion marker. LARO
refuses to overwrite an existing set. For a standalone server whose key comes
from `JWT_SECRET`, no secret sidecar is written; the manifest instead contains a
non-reversible compatibility tag and validation requires the matching
environment secret. Use `--desktop-secrets <path>` or
`LARO_DESKTOP_SECRETS_PATH` when desktop keys are not beside the database. Use
`--local-storage <path>` or `LARO_LOCAL_STORAGE_PATH` for a nonstandard evidence
root.

For local storage, LARO copies and hashes every regular file, rejects symbolic
links and unsafe paths, verifies that every database-managed storage key exists,
then rescans the source after the SQLite snapshot. Any addition, removal, or byte
change aborts publication. When `AWS_S3_BUCKET` is configured, LARO reads every
database-referenced object through the bounded storage reader and writes the raw
bytes into `<backup>.files/`. Missing objects, objects above 64 MB, more than
100,000 managed objects, a set above 100 GB, unsafe keys, or any post-copy hash
mismatch abort publication. The manifest binds the snapshot to its source bucket
and region. Original S3 keys remain in the manifest while snapshot files use
portable SHA-256 key names, including on Windows. S3 versioning and replication
remain recommended defense in depth,
but version-3 recovery no longer depends on the live object remaining present.

The default destination is a timestamped file under `db-backups` beside the live
database. Keep every set member together on access-controlled or encrypted
storage. The desktop sidecar contains secret key material.

## Automatic Recovery Sets

The packaged desktop and Docker API schedule the same recovery-ready set format
described above every day at 01:15. At startup, LARO validates existing scheduled
sets and creates a catch-up set when none is current. It immediately validates a
new set before counting it as healthy. Runs do not overlap.

Docker mounts `${LARO_BACKUP_HOST_DIRECTORY:-./.laro-backups}` at `/backups`.
The desktop defaults to `<userData>/backups`. Both defaults are local copies;
they protect against database corruption and accidental application-state loss,
but not device loss. For real off-device protection, point the Docker host path
at a protected synced or network destination and label it accurately:

```dotenv
LARO_BACKUP_HOST_DIRECTORY=C:\Users\owner\OneDrive\LARO Backups
LARO_BACKUP_DESTINATION_KIND=synced
LARO_BACKUP_RETENTION_COUNT=14
LARO_BACKUP_RETENTION_DAYS=30
LARO_BACKUP_MAX_AGE_HOURS=30
```

`LARO_BACKUP_RETENTION_COUNT` accepts 2-60 sets and defaults to 14.
`LARO_BACKUP_RETENTION_DAYS` accepts 1-365 days and defaults to 30. Account and
case erasure applies to live data immediately; recovery copies expire under
this bounded policy and must remain access-controlled until then.
`LARO_BACKUP_MAX_AGE_HOURS` accepts 6-168 hours and defaults to 30. Invalid
values stop scheduler initialization rather than silently weakening the policy.
Retention deletes only older files whose exact scheduled filename and complete
manifest still validate. Unknown, malformed, or corrupt files are preserved for
operator review.

`/api/health` reports whether automatic backups are configured, the declared
destination kind, latest verified timestamp, age, freshness threshold, retention
count, and failure state. It never exposes the destination path or calls `local`
storage off-device. Manual `db:backup`, validation, restore, and recovery-drill
commands remain available for release and incident operations.

## Electron Validate

```powershell
npm run db:validate -- C:\Backups\laro.sqlite
```

Validation is read-only. For a backup set it verifies the manifest, filenames,
sizes, SHA-256 hashes, SQLite integrity, foreign keys, core schema, encryption
key compatibility, and complete local or bundled-S3 byte coverage. A
database-only backup is labelled legacy because token and file recovery cannot
be proven. Version-1 sets and version-2 S3 inventory-only sets can still be
inspected, but are labelled as missing complete storage coverage.

## Electron Restore

1. Stop incoming API traffic or close LARO Desktop.
2. Validate the selected backup.
3. Restore it:

```powershell
npm run db:restore -- C:\Backups\laro.sqlite
```

Restore verifies the complete set before changing live state. For desktop sets it
stages the bundled keys and evidence directory, preserves all current paths, and
then restores SQLite. A database failure independently rolls back storage and
keys; an incomplete rollback is reported as a maintenance error. Previous state
remains beside each live path with a `.bak-<timestamp>` suffix.

An S3-backed version-3 set restores only when the active bucket and region
exactly match the manifest. Before writing the backup bytes, LARO snapshots all
objects referenced by the live database into a timestamped local previous-state
directory plus its own manifest. Every restored write retains the recorded
content type and must return the manifest SHA-256. It is then read back from S3;
bytes, hash, size, and content type must all match before restore continues. A
failed write, read-back mismatch, or database replacement restores previous
objects and removes newly introduced keys; incomplete rollback is reported and
the previous-state directory and manifest are kept for operator recovery.

A legacy database-only restore is blocked by default. After separately proving
that the correct historical key is installed, an operator can accept that risk
explicitly:

```powershell
npm run db:restore -- C:\Backups\legacy.sqlite --allow-legacy
```

Version-1 sets and version-2 S3 inventory-only sets without complete evidence
coverage are also blocked. Only after separately restoring and verifying the
matching evidence may an operator use:

```powershell
npm run db:restore -- C:\Backups\v1.sqlite --allow-missing-storage
```

## Electron Recovery Proof

```powershell
npm run recovery:drill
```

The drill creates an isolated migrated database, key file, and referenced legal
evidence object; changes all three live states; restores the set; and proves data,
key, and evidence recovery plus preservation of every previous path. It never
touches the live profile. `npm run readiness` includes this drill.

## Flask Recovery Set

The Flask Case Command Center has a separate recovery command because it has a
separate persistence model. One recovery-set directory contains:

- `ledger.sqlite3`: the source-linked legal ledger;
- `auth.sqlite3`: password identities, hashed bearer sessions, and reset state;
- `uploads/`: every regular file under `LARO_UPLOAD_ROOT`;
- `tokens/`: encrypted provider records and the local Fernet key, when used;
- `manifest.json`: database and per-file hashes, table inventories, referenced
  upload coverage, and non-reversible compatibility tags for external secrets.

Stop the Flask server and its workers before maintenance. Create and validate a
new set with:

```powershell
npm run flask:backup -- C:\Backups\laro-flask-20260720
npm run flask:validate -- C:\Backups\laro-flask-20260720
```

The CLI loads `.env` without overwriting already exported values. It supports
`--ledger-db`, `--auth-db`, `--uploads`, and `--tokens` for explicit maintenance
targets. A set is published only after both online SQLite snapshots pass
integrity, foreign-key, schema, and stable-source checks; both file stores match
their SHA-256 inventories; and every ledger-managed local path exists inside the
upload snapshot with its recorded content hash.

`SECRET_KEY` remains external and is bound through a salted compatibility tag.
It must be strong and retained with the deployment configuration. If invalidating
browser cookie sessions is acceptable, backup, validation, and restore can use
`--allow-session-reset`. This does not bypass OAuth-vault key validation.

When `LARO_TOKEN_ENCRYPTION_KEY` is configured, the set records only a salted
compatibility tag and validation requires the same external key. Otherwise the
ignored local `.laro-oauth-vault.key` is bundled with the encrypted vault. LARO
refuses vault files that have no recoverable key and refuses an active external
key that conflicts with a bundled key.

Restore requires an explicit stopped-runtime confirmation:

```powershell
npm run flask:restore -- C:\Backups\laro-flask-20260720 --confirm-stopped
```

The command validates the untouched set, stages all four members, rebases ledger
upload paths when `LARO_UPLOAD_ROOT` changed, validates staged state again, then
installs the members. Every previous live path remains beside its target with a
`.bak-<timestamp>` suffix. A partial installation attempts rollback for every
member and reports any incomplete rollback as a maintenance failure.

Run the isolated destructive proof with:

```powershell
npm run flask:recovery:drill
```

`npm run gate` and `npm run readiness` run both the Electron recovery drill and
the Flask ledger/auth/vault/upload drill. Production Electron and the legacy
Flask migration source are independently recoverable; their backups are not
interchangeable or a transactionally consistent combined snapshot. Preserve
both sets until the owner-bound migration is verified, then retain the Flask set
as the immutable source record. See
[Flask To Desktop Migration](FLASK_TO_DESKTOP_MIGRATION.md).
