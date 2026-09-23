# Backend Endpoint Usage Audit

Updated: 2026-09-20

## Current contract

The renderer tRPC client derives its contract from `AppRouter`. Server and
renderer TypeScript checks are release-blocking, and shipped runtime files may
not disable type checking. The fourteen missing router groups identified by the
original phase-074 snapshot are mounted and typed.

## Supported surface

- Authentication, account security, privacy export, and erasure.
- Owner-scoped cases, evidence, analysis, timelines, deadlines, notes, and export.
- Literal-safe global, case, evidence, timeline, lawyer, suggestion, hybrid,
  and saved-search paths use `literal-search-v1`; global and suggestion APIs
  return requested/completed/partial/failed scope metadata without raw storage
  errors.
- Owner-scoped evidence relevance scoring grounded in persisted case context and versioned document analysis.
- Owner-scoped evidence coverage snapshots with exact input/source revisions,
  availability, review state, unknowns, limitations, and no legal-merit or
  outcome score. Every run records its exact case and input manifest; derived
  results from the case-scoped coverage routes are returned only while that
  revision remains current.
- Lawyer matching and reviewed media/organization target discovery. Automatic
  review is bound to stable IDs from one active case discovery run; the response
  enumerates every created, refreshed, reviewed, skipped, and pending target and
  reports provider/result bounds as partial.
- Draft preparation, approval, explicit delivery, replies, and outreach analytics.
- Owner-only reviewed legal-draft snapshots. Recipient revisions retain manual
  or evidence-linked provenance; generation persists exact bytes plus case,
  source, analysis, and recipient revisions; review revalidates those inputs;
  and a one-use server route serves only the reviewed snapshot.
- Typed owner-scoped notifications with registered case, evidence, and lawyer
  destinations. The canonical writer returns durable created/already-exists/
  failure outcomes, and reminder deduplication is the notification row itself.
- Gmail/Drive OAuth and one canonical Drive evidence-collection path when
  configured. `autoCollection.listDriveFolders` performs read-only source
  selection; `pullEvidenceByKeywords` owns bounded download, account-plus-file
  deduplication, revisioning, analysis policy, explicit outcomes, and canonical
  evidence provenance. Shared-grant disconnect retains its versioned review and
  one confirmed cleanup operation.
- Case-owned KvK, Rechtspraak, and KOOP research with durable metadata-only
  receipts and explicit complete, empty, partial, unavailable, and failed
  outcomes; failures carry null counts rather than fabricated zero results.
- Operator diagnostics, readiness, recovery, retention, reconciliation,
  emergency stop, and feature flags.

## Explicitly unavailable surface

- PDF evidence export is marked unavailable; case-scoped ZIP (including available
  source files and analyses), JSON, CSV, print, and timeline export remain the
  supported paths.
- Trello and Telegram have no exported connector routes; the mounted provider
  checklist reports both as unsupported. Slack and other unfinished providers
  remain unavailable instead of returning fabricated success.
- Provider-backed analysis and delivery remain disabled until configured and
  accepted against target accounts.

## Regression controls

- `npm run gate` checks server, Electron, and renderer contracts plus lint.
- `tests/backend/runtimeTypeCoverage.test.ts` prohibits runtime type-check bypasses.
- Browser QA covers every mounted route in the packaged Chromium target.
- New irreversible actions require owner scope, confirmation, audit,
  idempotency, and a visible failure state.
- Google disconnect confirmation is bound to the reviewed account, capabilities,
  scheduled collection, source-record disposition, and current owner state;
  changed state must be reviewed again before provider contact.
- Public-source lookup tests reject cross-owner access before network contact and
  cover successful results, authoritative empty results, partial zeroes, and
  provider failure without storing provider result content in audit history.
- Gap-analysis reads revalidate the saved input revision. Evidence create,
  delete, same-source revision, timeline correction, concurrent input change,
  and failed recomputation regressions keep old derived results hidden.
- Notification reads batch-revalidate current owner context. Cross-owner,
  deleted, or non-registered destinations expose no action or entity identity;
  concurrent and failed reminder writes are covered behaviorally.
- Repository controls reject restoration of the retired `googleDrive` router,
  direct folder preview/import controls, parallel `google_drive_files` writes,
  and the legacy collection coordinator.
- Legal-draft regressions reject client-created download blobs, placeholder
  recipients, unreviewed download tickets, cross-owner access, stale review,
  content-bearing audit events, and account erasure gaps.
