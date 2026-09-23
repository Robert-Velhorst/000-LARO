# Privacy Controls and Data Deletion

Updated: 2026-09-23

## Owner access

`gdpr.exportData` returns the authenticated owner's data as JSON. The export is
owner-scoped, audit-logged, and redacts password, reset-token, and credential
fields.

## Owner erasure

`gdpr.deleteData` requires explicit confirmation **and** a five-minute,
single-use server proof bound to the same browser session. Password accounts
verify their current password. Legacy passwordless accounts verify a fresh
eight-digit code sent to the registered mailbox; production fails closed if
transactional email is unavailable. This mailbox fallback is not OAuth provider
reauthentication, because LARO has provider *connections* but no OAuth account
sign-in flow. The typed-email field in the renderer is only a human confirmation.

Erasure follows these stages:

1. The server consumes the one-use proof before irreversible work. Wrong,
   expired, cross-session, and replayed proofs are rejected.
2. Active Google grants are revoked through the maintained provider service
   while encrypted credentials are still present. If revocation fails, or a
   stored grant has no supported revocation contract (for example Outlook or a
   legacy `evidence_sources.accessToken`),
   the account and local credentials remain and the owner receives
   `revocation_pending` for a fresh verified retry. No completion is claimed.
3. Integrated Electron scanner state is erased before the relational transaction.
   The renderer also invokes its owner-scoped local scanner erase before the
   server call; on a remote desktop that can occur before provider revocation.
   Cross-device scanner erasure is not an atomic server transaction; users must
   erase each connected desktop's local history before completing server erasure.
4. The relational transaction removes owner, case, account, evidence-file/tag,
   integration-credential, session/config, and audit-linked rows; queues managed
   object deletion; and writes a mandatory de-identified audit receipt plus a
   durable request-status record. Existing JWTs stop authenticating when the
   user row disappears; the current cookie is cleared.
5. Managed objects are deleted after commit. If cleanup fails, the account is
   gone but the durable queue and receipt remain `storage_cleanup_pending` until
   the background worker succeeds. The worker then marks the receipt `completed`.
   A pre-commit failure retains the account and records `failed` when the status
   store remains available.

This workflow cannot provide atomic rollback across an external provider,
desktop database, SQLite transaction, and object store. A provider may already
be revoked or local scanner history erased when a later stage fails; those
partial effects are not represented as completed account erasure.

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

## Optional usage analytics

The only general privacy preference retained by LARO is `analytics`. It defaults
to off and is consumed by the canonical `server/usageTracking.ts` writer. When
off, document-generation and model-operation paths do not create new
`usage_tracking` rows, including when those paths are called directly through
the API instead of through the renderer. When on, the local row contains an
operation type, count, outcome/provenance metadata, owner, optional case ID, and
timestamp; it does not contain prompts, evidence text, provider credentials, or
billing charges.

The consent check and optional insert run in one database transaction so an
opt-out and a concurrent writer have a defined order. Existing rows are retained
until account erasure; opting out stops future collection. Preference changes
are mandatory-audited and the preference participates in export and erasure.

Required operational records are separate and are not disabled by this choice:

- audit receipts preserve security, privacy, and irreversible-action history;
- authentication/session records protect account access;
- hashed AI budget counters prevent resource exhaustion and unsafe concurrency;
- business records requested by the owner support cases, evidence, and outreach.

LARO has no maintained marketing-delivery or marketing-tracking path. The former
marketing switch was therefore removed instead of presenting an inert control;
legacy `marketing` values are discarded during database startup or the next
privacy-preference read.

## Verification

- GDPR export, one-use reauthentication, provider failure/retry, and erasure are
  covered by backend and isolation tests.
- Managed-object deletion failures leave a durable cleanup queue and a pending
  account-erasure result rather than falsely reporting completion.
- Retention tests prove that expired audit rows are removed while recent audit
  rows and business data remain.
- Configuration tests reject unsafe retention windows and guard the daily schedule.
- Focused and browser tests prove cloud-consent denial, reviewed HAI scope,
  shared-Google disconnect consequences, public-research failure states, and
  exact reviewed-draft export/erasure behavior.
- Privacy-processing tests cover the default, opt-in, opt-out, concurrent
  changes, account isolation, direct API use, and required-record separation.
- Scanner isolation/retention, enforced optional processing, one-use erasure
  verification, supported-grant revocation, retry states, and account-switch
  behavior pass together on implementation commit `ec94985`; the consolidated
  evidence is in
  [`FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md`](FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md).
