# Backend Endpoint Usage Audit

Updated: 2026-07-20

## Current contract

The renderer tRPC client derives its contract from `AppRouter`. Server and
renderer TypeScript checks are release-blocking, and shipped runtime files may
not disable type checking. The fourteen missing router groups identified by the
original phase-074 snapshot are mounted and typed.

## Supported surface

- Authentication, account security, privacy export, and erasure.
- Owner-scoped cases, evidence, analysis, timelines, deadlines, notes, and export.
- Owner-scoped evidence relevance scoring grounded in persisted case context and versioned document analysis.
- Owner-scoped evidence coverage snapshots with exact input/source revisions,
  availability, review state, unknowns, limitations, and no legal-merit or
  outcome score.
- Lawyer matching and reviewed media/organization target discovery. Automatic
  review is bound to stable IDs from one active case discovery run; the response
  enumerates every created, refreshed, reviewed, skipped, and pending target and
  reports provider/result bounds as partial.
- Draft preparation, approval, explicit delivery, replies, and outreach analytics.
- Gmail/Drive OAuth and evidence collection when configured.
- Operator diagnostics, readiness, recovery, retention, reconciliation,
  emergency stop, and feature flags.

## Explicitly unavailable surface

- PDF evidence export is marked unavailable; case-scoped ZIP (including available
  source files and analyses), JSON, CSV, print, and timeline export remain the
  supported paths.
- Trello, Slack, and other unconfigured providers return an unavailable state
  instead of fabricated success.
- Provider-backed analysis and delivery remain disabled until configured and
  accepted against target accounts.

## Regression controls

- `npm run gate` checks server, Electron, and renderer contracts plus lint.
- `tests/backend/runtimeTypeCoverage.test.ts` prohibits runtime type-check bypasses.
- Browser QA covers every mounted route in the packaged Chromium target.
- New irreversible actions require owner scope, confirmation, audit,
  idempotency, and a visible failure state.
