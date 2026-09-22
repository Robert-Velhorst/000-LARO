# Roadmap and External Gates

Current as of 2026-09-22.

## Fourth-Round Candidate

Implementation commit `dc3884b5db3521101a2c735f7d49be0ddc18f0fe`
passes the complete local verification required by issue #193. The evidence,
integrated negative-path mapping, maintained-source audit, SBOM/container ID,
and Windows artifact checksum are in
[`FOURTH_ROUND_VERIFICATION.md`](FOURTH_ROUND_VERIFICATION.md). The earlier
third-round record remains in
[`THIRD_ROUND_VERIFICATION.md`](THIRD_ROUND_VERIFICATION.md).

The next delivery gates are deliberately separate:

1. Push the candidate and obtain the protected GitHub CI/Windows results.
2. Review and merge the candidate before closing the corresponding GitHub
   issues; an open issue is not treated as closed merely because its local code
   is present.
3. Run the portable artifact on native Windows and confirm startup plus a
   scanned-PDF OCR path.
4. Deploy only after the owner supplies the current Hetzner, DNS, TLS,
   persistence, secret, backup, and existing-data migration inputs; then repeat
   browser and desktop acceptance against that public target.
5. Push and review the local #179-#193 candidate. Maintained acceptance/smoke
   tests use executable product boundaries; cloud consent, HAI grants, public
   diagnostics, evidence framing, discovery, shared Google revocation, public
   research, analysis freshness, search, notifications, canonical Drive intake,
   and reviewed draft versions are integrated in the recorded verification.
   GitHub issue closure still requires protected remote checks and review.

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
- Removal of unmounted analytics prototypes and their unused Recharts/D3
  production dependency tree.
- Blocking accessibility coverage for all 15 mounted routes at desktop and
  mobile sizes, including axe, control naming, overflow, request, console, and
  page-error checks.
- Blocking shared-shell keyboard coverage for localized skip navigation,
  desktop focus order, mobile sidebar exclusion/trapping/Escape restoration,
  overlay geometry and trigger restoration, keyboard FAQ state, and reduced
  motion.
- Removal of excluded legacy test files with broken imports or disconnected
  assertions; release coverage now lives only in explicitly maintained suites.

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

1. Complete the external candidate gates listed above.
2. Expand declared foreign keys after installed-data reconciliation; the
   production data-readiness gate now detects violations before migration.
3. Complete renderer NL/EN string migration.
4. Add platform-normalized pixel baselines for high-risk interaction states and
   extend focus-order coverage into complex route-specific case and evidence
   editors; shared-shell keyboard behavior is now blocking.
5. Normalize historical text-backed numeric fields through a reviewed,
   backup-tested migration; the production readiness gate now detects malformed,
   unsafe, or internally inconsistent count data before conversion.
6. Continue dependency review while preserving the enforced renderer bundle budgets.

These items improve maintainability and coverage; they do not replace the
target-account acceptance required for any enabled external provider.
