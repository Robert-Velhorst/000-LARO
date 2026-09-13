# Durable Case-Neutral Source Intake Implementation Plan

> For execution: use the existing approved autonomous dossier requirements and test-driven implementation. Preserve the broader objective.

**Goal:** Authorized Gmail, Drive and local folders feed the neutral inbox without a preselected case and survive interruption.
**Architecture:** SQLite source jobs and independently leased work items persist pagination, folder traversal and document outcomes. Existing OAuth and bounded storage/extraction feed the canonical inbox, which discovers dossiers under current user settings. Native local selection grants access only through the trusted desktop process.
**Stack:** Existing Node 22, TypeScript, SQLite/Drizzle, tRPC, React/Electron, Vitest and Playwright.
**Spec:** `docs/AUTONOMOUS_DOSSIER_REQUIREMENTS.md`, requirements 1-5 and 8, for the Windows-first product workflow.

## Invariants

- No live private-source ingestion, account changes, publishing or commits during implementation tests.
- Originals and provider account/object/version provenance are retained. Import dates are never event dates.
- A cursor advances only with its discovered child work committed. Repeated cursors fail visibly.
- Expired leases are recoverable; heartbeats protect long analysis; idempotent source identity plus hash prevents retry duplicates.
- Only owned connected accounts are admitted. Remote browser clients cannot supply filesystem paths.
- Local traversal does not follow symlinks/junctions, leave the granted root or silently accept directory/file changes during a read.
- Pause means finish the current unit, then stop. Failures and unsupported sources are visible, not counted as imported documents.
- Analysis settings remain authoritative; automatic grouping never authorizes outbound communications.
- Source jobs/work records are included in owner export and erasure.

## Work

- [x] Add failing integration tests for neutral intake, persisted pause/resume, lease recovery, original/version retention, ownership and path boundaries.
- [x] Add additive migrations/schema and trusted provenance in the inbox/evidence path.
- [x] Implement the durable queue, auditable controls and restart scheduler.
- [x] Implement bounded real local traversal and Google adapters using the existing OAuth credentials; add provider pagination/download tests with controlled HTTP responses.
- [x] Add owner-scoped source controls/status/details and trusted native folder start, with no case selection.
- [x] Verify targeted and broad regressions, type checks, build, browser flow and actual retained progress.
- [x] Update README/readiness documentation, retaining real-provider and Windows-installation acceptance gates.

## Verification

Use real temporary SQLite/storage and the actual tRPC router for lifecycle tests.
Google HTTP responses may be controlled test fixtures, but OAuth ownership, paging,
cursor persistence, storage, analysis and dossier creation remain real code paths.
Do not present those tests as live provider or model quality acceptance.

## Results

- Full regression at the source-intake integration checkpoint: 728 passed,
  2 skipped (hosted PostgreSQL not configured), 131 test files.
- After the additional Gmail history-change fix: all 17 source tests passed.
  The changed-draft regression was observed failing before the fix.
- All 10 browser tests passed; after the final scope/progress presentation edit,
  the 2 affected source/intake browser flows passed again. Desktop/mobile
  screenshots inspected. No live private-source or model validation claimed.
- Server/main and renderer type checks passed; complete build passed, repeated
  after the final code changes. Lint and the Git whitespace check also passed
  after the final scoped edits.
- Extra preview launch was blocked by the execution environment. Test-managed
  browser servers were used successfully; no installed desktop was replaced.

Remaining acceptance: real Google scopes/consent, actual local-model quality,
packaged Windows folder picker, whole-process restart on the target installation,
large archives, continuous synchronization, relationship correction and
source-derived action proposals. The broader autonomous dossier goal stays open.
