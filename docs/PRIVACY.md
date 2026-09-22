# Privacy Controls and Data Deletion

Updated: 2026-09-22

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

Optional cloud document processing is purpose-specific and defaults off. The
owner reviews the provider, data categories, purpose, retention consequence,
and external-processing consequence before enabling it. Server-side document
analysis, inbox, dossier, assistant, and hybrid-search paths block cloud contact
without the matching current consent and record the decision without document
content.

HAI access is not an account-wide export. Each credential is bound to a reviewed,
versioned grant naming the allowed cases, field categories, future-record
choice, expiry, and revocation state. The feed applies that grant on every read.

Gmail and Drive are capabilities of one encrypted Google grant. Disconnect uses
one versioned impact review that names both capabilities, affected schedules,
and local-source disposition. A stale confirmation or upstream revocation
failure preserves local state for a truthful retry.

Public-record research verifies case ownership before provider contact and
persists metadata-only attempt receipts. Legal-draft recipients and immutable
reviewed versions are owner/case scoped, included in export and erasure, and
audited without storing recipient text or document content in the audit log.

## Verification

- GDPR export and erasure are covered by backend and isolation tests.
- Managed-object deletion failures abort case, evidence, and account deletion.
- Retention tests prove that expired audit rows are removed while recent audit
  rows and business data remain.
- Configuration tests reject unsafe retention windows and guard the daily schedule.
- Focused and browser tests prove cloud-consent denial, reviewed HAI scope,
  shared-Google disconnect consequences, public-research failure states, and
  exact reviewed-draft export/erasure behavior. The consolidated exact-commit
  evidence is in `FOURTH_ROUND_VERIFICATION.md`.
