# Roadmap and External Gates

Current as of 2026-09-23.

## Final Account and Lifecycle Candidate

Implementation commit `ec94985e9d78fc95ad14e89473f79dec287b1825`
passes the complete repository-controlled verification required by issue #201.
The exact commands, integrated behavior, failure reconciliation,
maintained-source audit, SBOM/container identity, and Windows artifact checksum
are in
[`FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md`](FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md).
The fourth- and third-round records remain historical evidence in
[`FOURTH_ROUND_VERIFICATION.md`](FOURTH_ROUND_VERIFICATION.md) and
[`THIRD_ROUND_VERIFICATION.md`](THIRD_ROUND_VERIFICATION.md).

The next delivery gates are deliberately separate:

1. Push the candidate and obtain the protected GitHub CI, CodeQL, and Windows
   results.
2. Review and merge the candidate before closing #194-#199, #139, and #201; an
   open issue is not treated as closed merely because its local code is present.
3. Run the portable artifact on native Windows and confirm startup plus a
   scanned-PDF OCR path.
4. Deploy only after the owner supplies the current Hetzner, DNS, TLS,
   persistence, secret, backup, and existing-data migration inputs; then repeat
   browser and desktop acceptance against that public target.
5. Retest every enabled provider with the target accounts, migrate the owner's
   actual workspace through the documented recovery path, and retain rollback
   evidence until owner acceptance.

## Completed Production Path

- Local-first Electron runtime with generated per-install secrets.
- Account-bound desktop scanner rows, paths, preferences, workers, export, and
  erasure, including account-switch invalidation and legacy-row quarantine.
- Default-off usage analytics enforced by the canonical writer, fresh one-use
  account-erasure proof with fail-safe provider revocation, and explicit
  owner-checked assistant case context.
- Canonical Home workflow metrics and restart-safe collection monitoring backed
  by persisted keyword-pull jobs rather than parallel legacy state.
- Removal of callable Trello and Telegram credential/connector stacks while
  retaining display-only history labels.
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
2. Complete renderer NL/EN string migration.
3. Add platform-normalized pixel baselines for high-risk interaction states and
   extend focus-order coverage into complex route-specific case and evidence
   editors; shared-shell keyboard behavior is now blocking.
4. Continue dependency review while preserving the enforced renderer bundle budgets.

These items improve maintainability and coverage; they do not replace the
target-account acceptance required for any enabled external provider.
