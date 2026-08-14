# Roadmap and External Gates

Current as of 2026-08-14.

## Completed Production Path

- Local-first Electron runtime with generated per-install secrets.
- Authenticated case, evidence, document intelligence, source-linked timeline,
  official NOvA matching, controlled outreach, responses, analytics, export,
  scanner, audit, retention, backup, and recovery workflows.
- Review-gated media and organization discovery and local case matching.
- Emergency stop, feature flag, ownership, approval, provider, audit, and
  idempotency controls around irreversible delivery.
- Blocking TypeScript, lint, safety, traceability, recovery, Node, and Python
  checks.
- Target database integrity, invariant, reconciliation, foreign-key, and
  demo-marker readiness checks.
- Production Google Gmail/Drive and authenticated SMTP acceptance through the
  public ngrok route, including source-linked evidence persistence and duplicate
  outbound-send blocking.
- Active HAI connector acceptance through the authenticated public LARO feed.
- Route-level renderer splitting with release-blocking bundle budgets.

## External Acceptance

| Item | Current state | Completion evidence |
| --- | --- | --- |
| Google Gmail/Drive | Accepted 2026-08-14 | Connected target account, read Gmail and Drive, persisted source-linked evidence, verified source hash, revoked test connection |
| Outbound email | Accepted 2026-08-14 | Authenticated SMTP delivery received once in Gmail, audited, and duplicate send rejected |
| Inbound email reply threading | Not yet accepted live | Ingest and thread a representative reply |
| Optional S3 | Pending only if enabled | Store, retrieve, hash-check, and delete a representative evidence file |
| Optional provider-backed AI | Pending only if enabled | Retain only literal source-linked findings and fail closed on invalid citations |
| Public brand approval | Owner approved proposed LARO logo | Approved brand record in `release-acceptance.json` |
| Windows distribution | Unsigned internal distribution selected | Exact-main portable artifact, checksum, and owner-confirmed native launch |

The owner selected unsigned internal distribution, so certificate procurement is
not a current product requirement. Missing optional providers remain disabled and
must not be represented as operational.

## Engineering Follow-Up

1. Expand declared foreign keys after installed-data reconciliation; the
   production data-readiness gate now detects violations before migration.
2. Complete renderer NL/EN string migration.
3. Add component-level axe and visual-regression coverage across every mounted
   screen.
4. Normalize historical text-backed numeric fields through a reviewed migration.
5. Continue dependency review while preserving the enforced renderer bundle budgets.

These items improve maintainability and coverage; they do not replace the
target-account acceptance required for any enabled external provider.
