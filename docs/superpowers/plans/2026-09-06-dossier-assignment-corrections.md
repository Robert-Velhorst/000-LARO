# Dossier Assignment Corrections

**Goal:** Correct a filed inbox document's dossier without replacing its original,
losing source analysis or rewriting historical action decisions.

**Spec:** `docs/AUTONOMOUS_DOSSIER_REQUIREMENTS.md`, requirement 8. This is an
optional exception workflow, not a substitute for autonomous dossier discovery.

**Architecture:** Keep the canonical evidence ID/storage and move its case-scoped
analyses in one transaction. Require an owned target, reason and optimistic
assignment token. Preserve initial discovery separately and append corrections
to the existing owner-scoped audit log. A fresh token permits moving back, not
replaying a stale request. Existing actions stay in their original dossiers;
their source snapshots remain available. Case-scope new proposal identities and
retain previously stored legacy identities so corrections cannot overwrite them.

**Constraints:** No private source processing, new model calls, commits or
publication. No deletions or rewriting of user case summaries. This phase does
not implement multi-dossier associations, AI-issued correction instructions or
learning general filing rules from a correction. It preserves the larger scope.

- [x] Backend: first fail real SQLite tests for moves, reversal, ownership,
  stale tokens, source integrity, historical actions and proposal isolation.
- [x] Implement `server/inboxAssignments.ts`, expose correction/history through
  `server/routers/documentInbox.ts`, fix proposal identity collisions in
  `server/actionProposals.ts`, and pass focused regressions.
- [x] UI: add an optional correction section in inbox details with target search,
  reason, current dossier and paginated audit history; invalidate case/evidence/
  analysis/action caches after a successful correction.
- [x] Verify desktop/mobile rendered moves and reversal using the existing
  Playwright test harness; check original download, accessibility and overflow.
- [x] Build/typecheck/lint and document actual results and remaining scope.

Verification: 34 focused tests passed before extending the correction suite;
all six final correction tests pass after isolating test users. The broad run
returned 749 passed, one test-fixture rate-limit failure, two hosted-database
skips. That fixture failure was reproduced and fixed, then all six tests were
rerun successfully; the whole broad suite was not rerun. All 13 browser tests,
build, type checks, lint and whitespace checks passed. See the readiness audit
for the exact evidence and still-unaccepted autonomous discovery scope.
