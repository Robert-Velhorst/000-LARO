# Current Technical Audit

Date: 2026-08-22
Branch: `main` (updates proposed through pull requests)
Baseline commit: `ea37e9440dbb9e4b9c1feac6026495f5366d34c9`
Specification: `000-LARO__Giant_Codex_Goal_Prompt.pdf`, 124 pages, phases 000-115

## Scope and method

This is the current audit required by the specification appendix. The earlier
`docs/phase-audit.md` is deliberately retained as a dated record of the broken
2026-07-06 prototype and is not a current capability statement.

The current pass inspected all phase titles and deliverables, the release-candidate tree,
runtime entry points, router composition, database migrations, provider gates,
renderer routes, tests, CI workflows, release documentation, and generated
traceability. The candidate contains 719 tracked files: 433 TypeScript/TSX
files, 122 tracked test files, and 17 tracked migration artifacts.

## Current architecture

| Boundary | Current implementation | Authority |
| --- | --- | --- |
| Desktop product | Electron, React, Vite, tRPC client | Primary operator surface |
| API | Express + tRPC, also deployable as a Node 22 container | Primary application API |
| Data | SQLite through Drizzle/better-sqlite3 | Electron/Node database is authoritative |
| Legacy import | Flask ledger and recovery tooling | Offline migration source only |
| Evidence | Managed local or S3 bytes, hashes, extracted text, structured analysis, source links | Owner-scoped records and storage |
| External providers | Google read-only evidence scopes and configured outbound email | Explicit credentials, consent, approval, and acceptance gates |
| HAI bridge | Revocable `hai:read` credential plus bounded incremental feed | LARO owns authorization and minimization; HAI remains read-only |

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
- External contact is not autonomous: preparation, approval, and sending are
  separate state transitions; delivery is disabled by default and fail-closed.
- Case and outreach transitions claim their exact prior state. Response and case
  outcome changes are transactional, so stale or invalid requests roll back.
- Required audit evidence is written in the same transaction as consequential
  case and outreach changes. Audit failure rolls back the state change, and
  multi-draft approval either commits every draft and audit row or commits none.
- Evidence analysis distinguishes source observations from inference and keeps
  document/source identifiers available to the user.
- Backup sets bind the database, encryption-key compatibility, and managed
  evidence bytes. Version-3 S3 sets preserve original keys and content types,
  verify restored objects, and roll back remote state after failed recovery.
- `/api/live`, `/api/ready`, and `/api/health` distinguish process, dependency,
  and application health. Production readiness additionally checks data
  integrity, provider state, and release acceptance.

## Findings from this pass

| Finding | Severity | Resolution |
| --- | --- | --- |
| Phase 057 was only a dormant message catalog | Medium | Persisted NL/EN runtime, language controls, HTML language, locale formatters, localized account/shell/safety/scanner flows, unit and browser coverage |
| 25 Implemented rows had no concrete artifact citation | Medium | Every row now cites an existing source, test, script, workflow, or document; the gate fails future uncited implementation claims |
| Required current `TECHNICAL_AUDIT.md` was absent | Medium | This audit is the current appendix artifact; historical audit remains explicitly dated |
| Fresh npm advisory feed blocked the gate on `nanoid` and `js-yaml` | High | Lockfile moved to patched 3.3.18 and 4.3.1 releases; full and runtime-only audits return zero findings |
| Live provider acceptance depends on owner-controlled external state | External | Keep release status blocked until Google consent/read/revocation and approved outbound delivery evidence are recorded |
| Windows package is intentionally unsigned | Accepted limitation | Publish checksum and unknown-publisher warning; do not claim platform publisher trust |
| Generic HAI JSON feeds cannot authenticate safely | High | Added a dedicated LARO adapter and owner-scoped hashed credential instead of embedding a secret in a URL |
| Frontend session checks could show the sign-in screen during a transient API outage | Medium | Added bounded retries for transient failures and a reconnecting state that does not discard the signed-in UI |
| Browser account setup advanced before the signup request completed | Test defect | Route audit now waits for the authenticated account control; all 15 routes pass at desktop and mobile sizes |
| Renderer-accessible scanner credentials expanded renderer authority | High | Scanner launch proof and session cookies remain in Electron main; renderer uploads request a fresh main-owned session for each batch |
| S3 recovery sets recorded inventory without preserving evidence bytes | Medium | Version-3 sets bundle bounded, hashed object bytes and content types; restore verifies remote writes and rolls back on failure |
| Case and response transitions used stale check-then-update writes | High | Owner-bound compare-and-set transitions reject stale state; response plus case outcome updates commit or roll back together; no-match outreach leaves the case unchanged |
| An unreachable duplicate outreach engine retained unsafe state writers | Medium | Removed the unreferenced `server/workflow.ts`; the registered tRPC workflow is the only runtime outreach authority |
| Consequential legal-state writes could survive a failed audit insert | High | Case creation, classification, editing, transition, and deletion plus outreach initiation, single and batch draft decisions, dispatch claims, responses, and Gmail reply linking now commit with required audit rows or roll back together; injected SQLite failures verify each boundary |

## Verdict

The tracked application is an operational release candidate, not the prototype
described by the historical audit. Repository-controlled phase requirements are
implemented and now have artifact-level traceability. A production release must
still distinguish code readiness from owner-controlled live-provider acceptance:
valid Google consent and a reviewed real-send acceptance record cannot be
manufactured by tests or documentation.
