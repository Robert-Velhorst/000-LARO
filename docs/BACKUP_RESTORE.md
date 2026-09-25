# Backup and Restore

LARO stores application metadata in SQLite, provider tokens under an encryption
key, and evidence bytes on local disk or S3. A database alone is therefore not a
complete recovery point. The Electron server path is `DATABASE_URL`; the desktop uses
`<userData>/laro-server.sqlite`, `<userData>/laro-secrets.json`, and
`<userData>/uploads`.

## Encrypted Electron and API Backup

Version 4 publishes exactly two files:

- `<backup>` is one AES-256-GCM ciphertext containing the SQLite snapshot,
  matching application secrets, complete local or S3 evidence bytes, and the
  private integrity inventory;
- `<backup>.manifest.json` contains only the authenticated envelope parameters,
  ciphertext size/hash, creation time, and a non-secret recovery-key identifier.

The recovery credential is processed through scrypt and is never written into
the payload, manifest, `laro-secrets.json`, or backup destination. Copying either
or both published files does not reveal SQLite pages, evidence, provider-token
keys, original S3 keys, content types, or the private inventory without that
separate credential.

Create an owner-only key file containing at least 32 random bytes, escrow a copy
in a password manager or offline protected store, and keep it outside the backup
target. Do not paste it into Git, tickets, logs, or chat. Then use:

```powershell
npm run db:backup -- C:\Backups\laro.sqlite --recovery-key-file C:\Protected\laro-recovery.key
npm run db:validate -- C:\Backups\laro.sqlite --recovery-key-file C:\Protected\laro-recovery.key
```

`LARO_RECOVERY_KEY_FILE` provides the same owner-only file contract.
`LARO_RECOVERY_KEY` is available for a protected container secret environment;
it must not equal or be derived from `JWT_SECRET`, `COOKIE_SECRET`, or the
desktop key file. The packaged desktop generates
`<userData>/laro-recovery.key` with owner-only permissions on first use and uses
it for unattended backups. The operator must escrow that file separately; it is
deliberately excluded from every recovery payload.

Before encryption, LARO uses SQLite's online backup API, checks SQLite and
foreign-key integrity, binds the matching application secrets, and proves every
database-referenced local or S3 evidence object. Local storage is rescanned to
detect changes during the snapshot. S3 reads are bounded to 64 MB per object,
100,000 objects, and 100 GB total. Unsafe paths, links, missing objects, source
changes, or hash mismatches abort publication. The envelope manifest is renamed
last and marks a complete set; existing targets are never intentionally reused.

Use `--desktop-secrets`/`LARO_DESKTOP_SECRETS_PATH` and
`--local-storage`/`LARO_LOCAL_STORAGE_PATH` only for nonstandard live paths.
Those values identify inputs; their data still goes inside the ciphertext.

## Automatic Recovery Sets

Desktop and Docker schedule the same encrypted format daily at 01:15, validate
it immediately, and avoid overlapping runs. Docker must receive an independent
`LARO_RECOVERY_KEY` through its protected environment. Desktop uses its separate
owner-only recovery-key file. A missing or wrong key makes backup health fail;
the system never counts an unreadable set as healthy.

Docker mounts `${LARO_BACKUP_HOST_DIRECTORY:-./.laro-backups}` at `/backups`.
Desktop defaults to `<userData>/backups`. These local defaults do not protect
against device loss. Point the host path to protected synced or network storage
for an off-device copy and label it accurately:

```dotenv
LARO_RECOVERY_KEY=<independent high-entropy secret from protected storage>
LARO_BACKUP_HOST_DIRECTORY=C:\Users\owner\OneDrive\LARO Backups
LARO_BACKUP_DESTINATION_KIND=synced
LARO_BACKUP_RETENTION_COUNT=14
LARO_BACKUP_RETENTION_DAYS=30
LARO_BACKUP_MAX_AGE_HOURS=30
```

Retention accepts 2-60 sets and 1-365 days; freshness accepts 6-168 hours.
Deletion applies only to older scheduled files whose exact filename and complete
encrypted set validate. Unknown, malformed, or corrupt files remain for review.
The authenticated `/api/operator/diagnostics` and `admin.diagnostics` surfaces
report configuration, destination kind, latest verified time, age, policy, and
failure state without exposing the path or credential. Public `/api/health`
intentionally reports only application/database health, version, and timestamp.

## Validate, Restore, and Failure Handling

Validation requires the recovery credential, authenticates the public envelope,
decrypts into an owner-only temporary directory, then verifies the private
database/secrets/evidence manifest before reporting success. Restore repeats all
checks before changing live state, preserves the previous database, secrets, and
evidence paths, and rolls staged state back if a later operation fails:

```powershell
npm run db:restore -- C:\Backups\laro.sqlite --recovery-key-file C:\Protected\laro-recovery.key
```

For S3, the active bucket and region must match. LARO preserves current objects,
restores recorded bytes and content types, reads them back, and removes newly
introduced objects if verification or database replacement fails.

Version 1-3 manifest-based sets stored plaintext application data and are now
explicitly retired: current validation and restore identify their version and
refuse them. While the original workspace and keys still exist, create and
validate a new version-4 set, then quarantine or securely retire the old copy.
A database-only legacy snapshot remains an exceptional manual recovery source,
not a complete or confidential LARO backup.

If the recovery key is lost, encrypted sets are intentionally unrecoverable.
Do not generate a replacement and expect it to decrypt retained backups. Restore
the separately escrowed key or create a new set from the still-working original
workspace. Desktop startup refuses to silently replace a missing key when it can
see retained encrypted backups.

For planned key rotation, create a new independent key, retain the old escrowed
key, switch the scheduler, create and restore-test a new set, and keep the old
key until every old-key set has expired or been securely retired. Never delete
the old key before its retention window closes.

## Electron Recovery Proof

`npm run recovery:drill` creates isolated data, encrypts it, proves the published
payload contains neither SQLite magic nor known evidence/application-secret
bytes, destroys live state, restores all members with the separate recovery
credential, and verifies that every previous path was preserved. It never
touches the live profile and remains part of the blocking gate.

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
