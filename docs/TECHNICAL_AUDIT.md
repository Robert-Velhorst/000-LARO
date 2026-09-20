# Current Technical Audit

Date: 2026-09-20
Branch: `milestone3/remediate-roadmap` (local candidate; not merged)
Baseline implementation commit: `6011f45e03145b85820ed8cb94e57a3a94ed5ec8`
Specification: `000-LARO__Giant_Codex_Goal_Prompt.pdf`, 124 pages, phases 000-115

The reconciled third-round verification for issues #154-#178 is
[`THIRD_ROUND_VERIFICATION.md`](THIRD_ROUND_VERIFICATION.md). It records the
exact local commands, negative-path proofs, maintained-source search, Docker
image, Windows artifact, and external boundaries. GitHub issue state, protected
CI, native Windows execution, and deployment acceptance remain separate.

## Scope and method

This is the current audit required by the specification appendix. The earlier
`docs/phase-audit.md` is deliberately retained as a dated record of the broken
2026-07-06 prototype and is not a current capability statement.

The current pass inspected all phase titles and deliverables, the release-candidate tree,
runtime entry points, router composition, database migrations, provider gates,
renderer routes, tests, CI workflows, release documentation, and generated
traceability. At implementation commit `6011f45`, the candidate contains 949
tracked files: 577 TypeScript/TSX files, 189 tracked test files, and 32 tracked
migration artifacts.

## Current architecture

| Boundary | Current implementation | Authority |
| --- | --- | --- |
| Desktop product | Electron, React, Vite, tRPC client | Primary operator surface |
| API | Express + tRPC, also deployable as a Node 22 container | Primary application API |
| Data | SQLite through Drizzle/better-sqlite3 | Electron/Node database is authoritative |
| Legacy import | Flask ledger and recovery tooling | Offline migration source only |
| Evidence | Managed local or S3 bytes, hashes, extracted text, structured analysis, source links | Owner-scoped records and storage |
| External providers | Google read-only evidence scopes and configured outbound email | Explicit credentials, consent, approval, and acceptance gates |
| HAI bridge | Revocable `hai:read` credential bound to a versioned case-and-field grant plus bounded incremental feed | LARO owns authorization and minimization; HAI remains read-only |

Electron starts the same server modules used by the standalone API. The Flask
runtime is not a second production authority: `scripts/migrate_flask_ledger.py`
performs an offline, owner-bound import and archives source rows without moving
sessions or OAuth credentials.

## Critical-path audit

The code and tests support the required path:

1. Account creation and session authentication.
2. Owner-scoped case intake with draft recovery and deterministic legal-area classification.
3. Evidence ingestion from explicit upload, consented local folders, Gmail, or Drive.
4. Content hashing, text extraction, structured legal-document analysis, and source-linked reconstruction.
5. Curated lawyer and outreach-target matching with visible confidence limits.
6. Draft preparation, explicit human review, approval/rejection, emergency stop, and feature flag.
7. Provider delivery only after approval, with idempotency, rate limits, audit history, and truthful failures.
8. Response and outcome tracking, analytics, notifications, and case-scoped JSON/CSV/ZIP evidence export.

Primary automated evidence is in `tests/backend/criticalPath.backend.test.ts`,
`tests/e2e/workflow.e2e.test.ts`, `tests/backend/realSend.test.ts`,
`tests/backend/documentIntelligence.test.ts`, and
`tests/browser/rendererAccessibility.spec.ts`. Manual acceptance boundaries are
recorded in `docs/ACCEPTANCE_TESTS.md` and `docs/MANUAL_VERIFICATION.md`.

## Safety and operations

- Authentication, ownership, team access, CSRF/CORS, session revocation,
  password reset, and protected admin boundaries are enforced server-side.
- Provider tokens use authenticated encryption and are never included in debug
  bundles, exports, release artifacts, or version control.
- Provider connection and local disconnection changes commit with their audit
  rows. Empty credentials and invalid account identities are rejected, and
  OAuth, Gmail, Telegram, SendGrid, SMTP, and acceptance calls use bounded
  deadlines. Credential-bearing Trello and Telegram operations use POST bodies,
  persistent per-user quotas, and bounded concurrent-read admission. Telegram
  downloads enforce the evidence-file byte ceiling.
- External contact is not autonomous: preparation, approval, and sending are
  separate state transitions; delivery is disabled by default and fail-closed.
- Case and outreach transitions claim their exact prior state. Response and case
  outcome changes are transactional, so stale or invalid requests roll back.
- Notifications retain typed owner-scoped context and only expose registered
  internal destinations while referenced records remain valid. Reminder
  deduplication commits in the notification row, so failed persistence remains
  retryable and cannot be reported as created.
- Required audit evidence is written in the same transaction as consequential
  case and outreach changes. Audit failure rolls back the state change, and
  multi-draft approval either commits every draft and audit row or commits none.
- Legal-document generation now stores the exact preview/download bytes with a
  SHA-256, reviewed recipient revision, case/source input revision, derived
  analysis revision, and evidence references. A changed input makes a pending
  review unusable; reviewed historical bytes remain owner-only and auditable.
- Evidence analysis distinguishes source observations from inference and keeps
  document/source identifiers available to the user.
- Evidence-gap review uses a versioned source-revision inventory. It exposes
  exact inputs, availability, review state, unknowns, and limitations without
  turning record counts into legal merit, claim support, or outcome estimates.
  Legacy score rows are retired by both SQLite and hosted PostgreSQL migrations.
- Version-4 backup sets place the database, desktop secrets, and bounded managed
  evidence bytes in one authenticated encrypted payload whose recovery key is
  separate from application secrets. S3 members preserve original keys and
  content types; restore verifies writes and rolls back remote state after
  failure. Plaintext version-1 through version-3 sets are rejected.
- `/api/live`, `/api/ready`, and `/api/health` distinguish process, dependency,
  and application health without exposing operational topology. Backup state,
  workers, failures, and traffic metrics require the operator/admin capability.
  Production readiness additionally checks data integrity, provider state, and
  release acceptance.

## Findings from this pass

| Finding | Severity | Resolution |
| --- | --- | --- |
| Phase 057 was only a dormant message catalog | Medium | Persisted NL/EN runtime, language controls, HTML language, locale formatters, localized account/shell/safety/scanner flows, unit and browser coverage |
| 25 Implemented rows had no concrete artifact citation | Medium | Every row now cites an existing source, test, script, workflow, or document; the gate fails future uncited implementation claims |
| Required current `TECHNICAL_AUDIT.md` was absent | Medium | This audit is the current appendix artifact; historical audit remains explicitly dated |
| Fresh npm advisory feed blocked the gate on `nanoid` and `js-yaml` | High | Lockfile moved to patched 3.3.18 and 4.3.1 releases; full and runtime-only audits return zero findings |
| Live provider acceptance depends on owner-controlled external state | External | Keep release status blocked until Google consent/read/revocation and approved outbound delivery evidence are recorded |
| Windows package is intentionally unsigned | Accepted limitation | Publish checksum and unknown-publisher warning; do not claim platform publisher trust |
| Generic HAI JSON feeds cannot authenticate or minimize safely | High | Added a dedicated LARO adapter whose hashed credential is bound to a reviewed, versioned grant for explicit cases, field categories, and future-record choices; legacy unrestricted tokens are revoked |
| Frontend session checks could show the sign-in screen during a transient API outage | Medium | Added bounded retries for transient failures and a reconnecting state that does not discard the signed-in UI |
| Browser account setup advanced before the signup request completed | Test defect | Route audit now waits for the authenticated account control; all 15 routes pass at desktop and mobile sizes |
| Renderer-accessible scanner credentials expanded renderer authority | High | Scanner launch proof and session cookies remain in Electron main; renderer uploads request a fresh main-owned session for each batch |
| S3 recovery sets recorded inventory without preserving evidence bytes | Medium | Version-4 encrypted sets include bounded, hashed object bytes and content types; restore verifies remote writes and rolls back on failure |
| Case and response transitions used stale check-then-update writes | High | Owner-bound compare-and-set transitions reject stale state; response plus case outcome updates commit or roll back together; no-match outreach leaves the case unchanged |
| An unreachable duplicate outreach engine retained unsafe state writers | Medium | Removed the unreferenced `server/workflow.ts`; the registered tRPC workflow is the only runtime outreach authority |
| Consequential legal-state writes could survive a failed audit insert | High | Case creation, classification, editing, transition, and deletion plus outreach initiation, single and batch draft decisions, dispatch claims, responses, and Gmail reply linking now commit with required audit rows or roll back together; injected SQLite failures verify each boundary |
| Provider credentials could be stored or deleted without durable audit evidence | High | Connection and every registered local disconnect route now transact credentials, connected sources, and required audit rows; injected audit failures preserve the prior local state |
| Dormant Gmail OAuth and provider calls retained unsafe or unbounded paths | Medium | Removed the unused unsigned-state/non-PKCE OAuth implementation, validate and normalize returned account credentials, and bound OAuth refresh, Gmail, SendGrid, SMTP, and live-acceptance calls |
| Credential-bearing Trello and Telegram reads used query-string transports | High | Converted every token-bearing procedure to a POST-backed mutation, removed dormant unsigned/non-expiring Trello OAuth generation, bounded Telegram token/file inputs, and added provider deadlines and response-size ceilings |
| Provider identity normalization could duplicate historical mixed-case accounts | High | Provider lookup now occurs case-insensitively inside the credential/audit transaction; startup reconciliation preserves child references, normalizes identities, and creates a unique owner/provider/email index; concurrent reconnect tests converge on one row |
| Public-source provider failure could be rendered as zero results or an absence conclusion | High | KvK, Rechtspraak, and KOOP lookup now verifies case ownership before contact, writes a mandatory metadata-only receipt for every attempt, retains null counts on failure, and renders complete, genuine-empty, partial, unavailable, and failed states separately |
| Trello and Telegram token operations lacked aggregate admission controls | High | Added persistent per-user/provider request quotas and shared bounded-read admission around provider calls; the 31st request is rejected before provider contact |
| Linux cross-packaging omitted the Windows canvas binary used for scanned-PDF OCR | High | `dist:win` and Store builds stage the exact pinned Windows canvas package; CI repeats the step and packaged-native verification requires x64 PE SQLite and canvas bindings |
| Gap analysis presented count-derived percentages as evidence completeness and case strength | High | Replaced the score contract with `evidence-coverage-v1`, exact source and analysis revisions, explicit unknown legal basis and limitations; legacy rows and their derived output are retired, and sparse/duplicate/contradictory/unavailable/well-documented plus desktop/mobile browser regressions are covered |
| Saved gap-analysis output remained visible after its evidence or timeline inputs changed | High | Every run now records the exact case/input revision and manifest; reads revalidate it, non-current states suppress all derived output and document generation, and evidence create/delete/revision, timeline correction, unchanged rerun, failed recomputation, and desktop/mobile state regressions are covered |
| Search text had inconsistent LIKE/regex semantics and category failures resembled complete empty results | High | Added one Unicode-normalized `literal-search-v1` contract across every maintained local search path, isolated malformed legacy rows, returned category/scope completeness metadata, and covered punctuation, Unicode, pagination, saved replay, injected failure, and desktop/mobile rendering |
| Automatic target discovery reviewed an arbitrary owner-wide pending slice | High | Discovery now returns stable run-scoped IDs and exact dispositions; automatic review and matching use only created/refreshed IDs from that run, preserve manual and unrelated historical records, and expose provider/result overflow as partial |
| Gmail and Drive disconnect controls hid the consequence of revoking their shared Google grant | High | One versioned pre-action review now names the account, shared credential, both capabilities, affected schedules, and source disposition; stale review and provider failure preserve local state, while confirmed transactional cleanup retains other accounts and collected documents |
| Duplicate Drive browse/import/sync code retained a second ingestion, deduplication, analysis, and provider-tracking contract | High | Removed the exported duplicate router and direct preview/import controls; read-only source selection now feeds one canonical bounded collector whose evidence metadata records account-plus-file identity, provider revision, history, storage key, and hash |
| Generated legal drafts used unchecked recipient placeholders and transient browser-created files | High | Added reviewed owner/evidence-linked recipient revisions, persisted exact-byte draft versions with case/source/analysis provenance, stale confirmation rejection, server-owned one-use download, metadata-only mandatory audit, historical retrieval, and erasure tests |

## Verdict

The tracked application is a locally verified release candidate, not the prototype
described by the historical audit. Repository-controlled phase requirements are
implemented and now have artifact-level traceability. The candidate is not yet
merged or deployed. A production release must
still distinguish code readiness from owner-controlled live-provider acceptance:
valid Google consent and a reviewed real-send acceptance record cannot be
manufactured by tests or documentation.
