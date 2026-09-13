# Autonomous Dossier Intake Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement and verify each deliverable.

**Goal:** Let LARO accept documents without a case, discover source-backed case references, create and grow dossiers automatically, and leave ambiguous associations unresolved.

**Architecture:** Keep original bytes in managed storage and a neutral SQLite inbox. Reuse the maintained extraction and configured analysis providers. A transactional organizer links the analyzed original into canonical evidence and document analyses, without a second writable legal database or a fabricated catch-all case.

**Tech Stack:** Existing React, tRPC, Drizzle, SQLite, Node 22 and Playwright.

**Spec:** The Windows-first product workflow: Gmail, Drive and local folders; automatic dossier discovery rather than obligatory manual assignment.

## Constraints
- Preserve originals and prior work. No publishing, merging or live mailbox mutation in this increment.
- No synthetic production data; test accounts and fixtures remain isolated.
- Analysis provider and raw-sharing preferences remain authoritative.
- Similarity scores are not probabilities or proof. An explicit source reference can identify a provisional dossier; conflicting references require review.
- A reference-based first stage is not a claim of comprehensive semantic understanding.

## Deliverables

### 1. Durable, Autonomous Intake
Files: `server/schema.ts`, `drizzle/0013_document_inbox.sql`, migration journal, `server/documentInbox.ts`, `server/documentCaseMatching.ts`, `server/routers/documentInbox.ts`, router registration, `server/documentAnalysisService.ts`, `tests/backend/documentInbox.test.ts`.
- [x] Write and run failing API tests: upload without a case; immutable bytes; owner isolation; duplicate retry; automatic creation and incremental assignment; ambiguity remains unresolved; assignment is idempotent; no automatic assignment in review mode.
- [x] Add inbox storage and indexes, without changing existing evidence ownership requirements.
- [x] Extract/analyze the source through the existing provider policy. Persist failure state and permit retries.
- [x] Discover explicit document references from source text. Create a provisional case only for a single unambiguous reference. Reuse an owner-scoped matching case; never force fuzzy matches.
- [x] Link evidence and analyses transactionally with the decision basis in the audit log. Recheck state inside the transaction for retries/concurrent calls.
- [x] Verify source access, migration initialization, account isolation, and case deletion retaining the inbox original.

### 2. Operable Inbox
Files: `src/renderer/components/DocumentInbox.tsx`, `Evidence.tsx`, workflow preferences/router/settings, browser tests.
- [x] Add a default inbox view to Evidence with multi-file and folder intake, per-file progress/errors, source download, analyzed summary and automatic result.
- [x] Respect automatic analysis/organization settings; keep original upload successful even when analysis fails.
- [x] Offer searchable, paginated case selection for unresolved items; distinguish autonomous decisions from manually confirmed ones.
- [x] Refresh case, evidence, and inbox queries after completion, without page reload.
- [x] Verify real UI behavior on desktop and mobile with isolated fixture documents.

### 3. Verification and Follow-on Boundaries
- [x] Run focused regression tests, type checks, build/lint and migration checks. Record actual outcomes. Tests: 702 passed, 2 PostgreSQL-only tests skipped; 8 browser tests passed; types, lint, complete renderer/main/server build and renderer bundle budgets passed.
- [x] Update the Windows readiness audit and README with precise implemented capabilities and remaining acceptance gates.
- [x] Keep broader semantic cross-document discovery, provider-to-neutral-inbox collection, assertion-state review, and source-linked action proposals explicitly outstanding until their complete paths are implemented and verified.

## Test Commands
Use Node 22.23.2 from the workspace runtime directory.

```text
npx vitest run tests/backend/documentInbox.test.ts --maxWorkers=1
npm run typecheck
npm run typecheck:renderer
npm run lint
npx playwright test --config playwright.a11y.config.ts
```
