# Operator Runbook

## Health and Diagnostics

- Liveness: `GET /api/live`
- Database readiness: `GET /api/ready`
- Full health: `GET /api/health`
- Local diagnostics: `npm run doctor`
- Admin diagnostics: `admin.diagnostics`, `admin.tableCounts`, `admin.invariants`

Background jobs run in the server process. `health.readiness` reports database
and job state, including the last run, success, and error timestamps.

## Safety Controls

- Engage `admin.setEmergencyStop` before investigating unsafe outreach behavior.
- Keep `outreach.send.enabled=false` unless real delivery is intentionally live.
- Every send still requires ownership, approval, idempotency, provider, and audit
  checks. The feature flag alone does not bypass them.
- Rate limits are process-local; deploy a single API replica unless a shared
  limiter is introduced.

### Ambiguous email delivery

When the email provider disconnects after accepting message data, LARO keeps an
`uncertain` send-once guard and blocks every retry. In **Admin > Operations**:

1. Check the provider's message or activity log for that outreach.
2. Choose **Mark delivered** only when one accepted message is visible.
3. Choose **Allow retry** only when the provider confirms no delivery.
4. Enter the provider reference when available, record the verification basis,
   and confirm the provider check.

The resolution compares the exact uncertain guard atomically. Confirmed
delivery moves an Approved outreach to Sent without invoking the provider;
confirmed non-delivery removes only that guard and leaves the draft Approved.
Both outcomes write `outreach.dispatch_resolved`; concurrent or stale decisions
fail closed.

### Live outbound acceptance

Run this only for an owner-controlled connected Google mailbox. The recipient
and confirmation must be identical to that account's email address:

```powershell
npm.cmd run acceptance:outbound-live -- `
  --user-id <owner-user-id> `
  --google-account-id <connected-google-account-id> `
  --recipient <owner-email> `
  --confirm-send-to <owner-email> `
  --run-id <stable-operator-run-id>
```

In the API container, invoke the compiled file at
`/app/dist/server/server/liveOutboundAcceptance.js` with the same arguments.
The command refuses a mismatched recipient, an engaged emergency stop, an
environment override that keeps sending off, or an unconnected account. It
creates and approves deterministic acceptance-only rows, sends one labelled
message through the guarded outreach path, observes exactly one matching Gmail
inbox message, retries the send to prove the duplicate guard, then stores a
signed redacted receipt and audit event before deleting all temporary business
rows. A rerun with the same receipt does not send again and finishes interrupted
cleanup. Preserve the `COOKIE_SECRET`: rotating it intentionally invalidates the
receipt and requires a new acceptance run.

### Live Google evidence acceptance

Run this after the outbound owner self-test, using that receipt's run ID. This
command sends no message. It searches the selected Gmail account for the exact
labelled self-test message, imports it through the production collector, runs
deterministic email analysis, retrieves the stored bytes through a five-minute
signed HTTP link, verifies the SHA-256 hash, and records the source-open audit:

```powershell
npm.cmd run acceptance:google-evidence-live -- `
  --user-id <owner-user-id> `
  --google-account-id <connected-google-account-id> `
  --recipient <owner-email> `
  --confirm-account <owner-email> `
  --outbound-run-id <completed-outbound-run-id> `
  --run-id <stable-google-acceptance-run-id>
```

In the API container, invoke
`/app/dist/server/server/liveGoogleEvidenceAcceptance.js` with the same
arguments. The command requires a valid matching outbound receipt, refuses an
account mismatch or emergency stop, and retains no Gmail subject, message ID,
email address, temporary case, evidence row, analysis row, collection log, or
stored source bytes. It keeps only a signed redacted receipt and acceptance
audit. Rerunning an accepted operation performs interrupted cleanup without
reading Gmail again. Preserve `COOKIE_SECRET`, because it authenticates both
provider acceptance receipts.

### Live Google Drive evidence acceptance

Run this with a specific, unique document name from the selected owner's Drive.
The command sends no message and does not modify Google Drive. It reads the
matching file through the production collector, persists both the evidence and
provider-provenance rows, runs deterministic analysis, retrieves the stored
bytes through a signed HTTP link, verifies the SHA-256 hash, records the
source-open audit, and removes all temporary business data:

```powershell
npm.cmd run acceptance:google-drive-evidence-live -- `
  --user-id <owner-user-id> `
  --google-account-id <connected-google-account-id> `
  --recipient <owner-email> `
  --confirm-account <owner-email> `
  --drive-file-name <exact-unique-drive-document-name> `
  --drive-folder-id <folder-id-or-root> `
  --run-id <stable-drive-acceptance-run-id>
```

`--drive-folder-id` is accepted for command compatibility, but exact-name
acceptance uses an account-wide paginated Drive query and does not walk the
folder tree. In the API container, invoke
`/app/dist/server/server/liveGoogleDriveEvidenceAcceptance.js` with the same
arguments. Exact-name selection is checked before any matching file is
downloaded, and the operation fails unless exactly one Drive file is found. It
retains only a signed, redacted receipt and acceptance audit; filenames, Drive
IDs, account addresses, stored bytes, temporary evidence, analyses, collection
logs, and provider rows are removed. Rerunning an accepted operation does not
read Drive again.

## Data Operations

- Integrity: `admin.invariants`
- Read-only orphan report: `admin.reconcileReport`
- Explicit orphan repair: `admin.repairOrphans`
- Backup, validation, restore, and drill: see `docs/BACKUP_RESTORE.md`
- Retention preview/run: `admin.retentionPreview`, then `admin.retentionRun`

## Incident Sequence

1. Stop risky behavior with the emergency stop.
2. Preserve logs and create a verified backup.
3. Run health, invariant, and reconciliation reports.
4. Rotate compromised secrets and revoke affected sessions or provider tokens.
5. Roll back application and database only when evidence requires it.
6. Re-run readiness and the critical acceptance flow before reopening.

Use `npm run db:backup` to create the database, manifest, matching desktop
secret sidecar, and local evidence directory as one recovery set. Keep all
members together on protected media. For S3, separately verify bucket recovery
controls. Deleting `<userData>/laro-secrets.json` rotates desktop session and
encryption keys on the next launch, invalidates existing sessions, and requires
reconnecting providers whose tokens were encrypted with the previous key. LARO
preserves and rejects an invalid existing file instead of silently rotating it.
Provider credentials still require their own rotation or revocation.

For the Flask command center, stop the server and workers, then run
`npm run flask:backup -- <directory>` and `npm run flask:validate -- <directory>`.
Restore only with `npm run flask:restore -- <directory> --confirm-stopped`. The
set coordinates the ledger, auth sessions, OAuth vault, and uploads while keeping
every previous target beside the restored path. Keep the matching external
`SECRET_KEY` and optional `LARO_TOKEN_ENCRYPTION_KEY` in independent secret
escrow; neither raw value is copied into the set.

## Legacy Flask Migration

Electron is the production authority. Before retiring an existing Flask
workspace, create and validate both complete recovery sets, stop both runtimes,
and run `npm run flask:migrate-to-desktop -- ...` without `--apply`. Review the
owner mapping, counts, snapshot hash, and file issues, then repeat with
`--apply`. Reopen Desktop and verify cases, evidence downloads, timelines,
deadlines, and **Settings > Security > Legacy workspace imports**. Keep Flask
stopped afterward. The full command, identity-remap exception, missing-file
policy, and rollback sequence are in
[Flask To Desktop Migration](FLASK_TO_DESKTOP_MIGRATION.md).
