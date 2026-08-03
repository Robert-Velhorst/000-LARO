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
