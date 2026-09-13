# Source-Backed Action Proposals

This executes requirement 7 of the approved autonomous dossier workflow.
The preceding source-intake turn made verified implementation progress.

## Design

Derive proposals automatically from the latest owned document analysis when the
action workspace loads. Reuse cited obligations instead of a separate provider
call. Preserve exact quotations, source identity, source hash and uncertainty.
Dates and parties mentioned in a source are not automatically legal deadlines
or assigned responsibility. Acceptance creates an ordinary open case action;
dismissal is reversible. Persist decisions and source snapshots in an additive
table so retries cannot duplicate actions and later analysis cannot rewrite an
accepted action's supporting record. No communication is sent.

## Execution

- [x] Reproduce missing proposal behavior with real inbox/SQLite integration tests.
- [x] Add `case_action_proposals` and migration recovery; implement bounded,
  latest-analysis queries and citation-validated derivation in `server/actionProposals.ts`.
- [x] Add owned list/decision/action-source routes. In one transaction, revalidate
  the current proposal, save its decision/snapshot, create an open deadline and
  append an audit record. Reject forged/stale identities and cross-owner access.
- [x] Extend the existing action workspace with proposals, accept/dismiss/restore
  and the canonical source-opening path. Preserve manual actions and completion.
- [x] Verify source proposals, normal actions, authorization, migrations, browser
  behavior, type checks, lint and build; update requirements and readiness notes.

Verified: 735 tests passed, two hosted-database tests skipped; all 11 browser
tests passed after isolating feature-test sessions from the real signup limit.
Build, renderer typecheck, lint and diff checks passed. Browser tests also
reproduce and verify that opening a dossier does not start a lawyer search.

## Boundaries Still Open

This does not establish live-model accuracy, compute statutory deadlines or
automatically prove that an obligation was fulfilled. Completion-evidence linking,
explicit assertion states throughout all timeline views, large-corpus discovery,
correction and real-source/Windows acceptance remain in the full objective.
