# Privacy Controls and Data Deletion

Updated: 2026-07-20

## Owner access

`gdpr.exportData` returns the authenticated owner's data as JSON. The export is
owner-scoped, audit-logged, and redacts password, reset-token, and credential
fields.

## Owner erasure

`gdpr.deleteData` requires explicit confirmation. It removes owned managed
objects before deleting relational records and aborts on storage or database
failure so a partial erasure is not reported as success. The account session is
cleared after deletion.

## Retention

Audit history is retained for `AUDIT_RETENTION_DAYS` (default 365, accepted
range 30-3650). Invalid configuration stops startup. The idempotent sweep runs
after startup and daily through the observable job runner. It never removes
cases, evidence, outreach, or other owner business data.

Admins can run `admin.retentionPreview` before `admin.retentionRun`. Job status
is available only through authenticated operator/admin diagnostics; public
health probes do not expose worker topology or history.

## Consent and legal basis

Provider connection and evidence collection require an authenticated user
action. LARO does not treat account creation as proof of a GDPR legal basis for
processing legal-case or special-category data. The deployment operator remains
responsible for documenting the applicable basis and processor agreements.

## Verification

- GDPR export and erasure are covered by backend and isolation tests.
- Managed-object deletion failures abort case, evidence, and account deletion.
- Retention tests prove that expired audit rows are removed while recent audit
  rows and business data remain.
- Configuration tests reject unsafe retention windows and guard the daily schedule.
