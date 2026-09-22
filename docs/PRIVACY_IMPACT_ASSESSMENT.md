# Privacy Impact Assessment (DPIA)

Updated: 2026-09-22
Jurisdiction: Netherlands / EU (GDPR)

## Purpose of processing

LARO helps an account owner organize a legal case, collect supporting evidence,
match relevant lawyers, prepare human-reviewed outreach, and track outcomes.

## Personal data categories

| Category | Examples | Sensitivity | Store |
| --- | --- | --- | --- |
| Client identity and contact | Name, email, phone, address | Personal | `cases` |
| Case content | Free-text description and legal areas | Potentially special-category | `cases` |
| Evidence | Documents, emails, attachments | Potentially special-category | `evidence`, managed storage |
| Account | Email, password hash, role | Personal and credential | `users` |
| Connected-account tokens | OAuth access and refresh tokens | Credential | `email_accounts`, `evidence_sources` |
| Reviewed HAI grants | Allowed cases/fields, future-record choice, expiry | Authorization metadata | `hai_access_grants`, `hai_api_credentials` |
| Reviewed legal drafts | Recipient revision, exact document bytes, source/review versions | Potentially special-category | `legal_draft_recipients`, `legal_draft_snapshots` |
| Audit | Actions, timestamps, IP and user agent | Personal | `audit_logs` |

## Lawfulness and rights

- The deployment operator must identify and document the applicable GDPR
  Articles 6 and, where relevant, 9 legal basis. LARO does not infer lawful
  consent merely because an account exists.
- `gdpr.exportData` provides an authenticated owner export with credential fields
  redacted.
- `gdpr.deleteData` performs confirmed account erasure, including owned managed
  objects, before relational metadata is removed.
- Provider connection and evidence collection are explicit user actions.
- Optional cloud document processing requires a separate purpose-specific,
  versioned opt-in; account creation or provider connection is insufficient.
- HAI reads require a reviewed case-and-field grant and are re-scoped on every
  request. Public research verifies owned case context before external contact.
- No marketing tracker or third-party product telemetry is enabled.

## Data flow and storage

- Local-first operation stores data in the on-device SQLite database and local
  evidence directory unless the owner configures managed storage.
- External egress is limited to explicitly configured providers over TLS.
- OAuth tokens are encrypted at rest with authenticated AES-256-GCM.
- Outreach delivery requires ownership, approval, feature-flag, emergency-stop,
  idempotency, and provider checks. Preparing or approving a draft does not send it.

## Risks and mitigations

| Risk | Mitigation | Residual |
| --- | --- | --- |
| Cross-account exposure | Owner checks, relationship guards, and isolation tests | Target deployment access review |
| Token theft | AES-256-GCM at rest; secrets excluded from exports and packages | Host/account compromise |
| Secrets in shipped app | `.env` excluded; desktop generates per-install session secrets | Provider credentials remain operator-controlled |
| Over-retention | Automatic bounded audit-log retention plus owner export and erasure | Operator must approve the retention window |
| Evidence integrity | Source metadata, content hashes, and source-linked analysis | Provider-origin authenticity is not independently certified |
| External processing | Provider connection is explicit and optional | Operator must execute suitable processor agreements |
| Over-broad downstream access | Versioned HAI grants limit cases, fields, future records, expiry, and revocation | Operator must review each enabled downstream processor |
| Stale or unreviewed generated document | Exact-byte snapshots bind current recipient, source, case, and analysis revisions; stale review is rejected | Human legal review remains required |

## Necessity and proportionality

LARO collects case and evidence information needed for the selected workflow.
Automated analysis remains source-linked and is not represented as final legal
advice. Business records remain owner-controlled; only audit history is purged
automatically under the configured policy.

## Required target-environment acceptance

- Record the approved retention period and controller/operator responsibility.
- Execute required processor agreements for every enabled provider.
- Complete live-provider consent, callback, storage, analysis, delivery, and
  audit verification with target accounts.
- Confirm the public product branding before a versioned public release.

These target-account items cannot be proven by repository tests and remain in
`release-acceptance.json` where applicable.
