# Changelog

All notable changes to LARO are documented here. This project follows semantic
versioning; dates are ISO. Version is sourced from `package.json` and surfaced by
`system.appInfo` / `admin.debugBundle`.

## Unreleased

### Changed
- Reduced Google OAuth to Gmail/Drive read access plus account email, removed
  delegated Gmail/Outlook send and Gmail label-write scopes, made incomplete
  Microsoft collection explicitly unavailable, and made Google disconnect
  confirm upstream revocation before erasing the owner's shared encrypted
  credential and refreshing status immediately.

### Added
- Added an evidence-grounded case assistant that ranks completed document
  analyses, validates model-returned document IDs, exposes clickable source
  controls, and provides a deterministic retrieval summary when the optional
  model provider is unavailable or produces invalid citations.
- Completed the safe Paper Trail Visualizer port with neutral document-story
  phases, source-backed key moments, and connected-chain summaries. The
  predecessor's mock browser collectors and unsupported justice-probability
  claims remain intentionally excluded.
- Extended the source-linked document reconstruction with participant and legal-
  topic focus, plus the dated actions retained for each selected station. This
  ports the useful focused-analysis concepts from the predecessor's unrelated
  `feat/document-timeline-generator` history without importing its prototype
  Flask runtime, global cache, or unaudited directory watcher.
- Added a source-linked metro-style case reconstruction that displays every
  evidence document as a dated station, separates provider/reference-backed
  links from confidence-labelled inferred relationships, supports route and
  confidence filters, horizontal/vertical layouts, zoom, chain tracing, an
  accessible list view, and direct source access without mock data.
- Added per-document and one-click batch analysis for supported evidence already
  stored on a case, removing the previous duplicate-upload requirement.
- Added Windows DPAPI-protected setup for Google OAuth and authenticated SMTP
  credentials, with non-echoing prompts, boolean-only status output, restricted
  local file permissions, and automatic injection into the ngrok API container.
- Added a restartable Windows ngrok API deployment that keeps Docker on host
  loopback, supports exact path routing on an existing shared dev domain,
  persists only non-secret gateway settings, verifies local and public health,
  routes the authenticated realtime endpoint under the same prefix, and safely
  stops only LARO's validated tunnel process.
- Added a non-destructive release-acceptance draft command that records exact
  provider checks and brand-asset hashes without reading credentials, approving
  gates, overwriting the canonical record, or replacing an existing draft.
- Added an offline, owner-bound Flask-to-desktop migration with dry-run default,
  automatic target snapshot, deterministic operational mappings, source/file
  SHA-256 binding, complete redacted legacy-row archival, managed evidence copy,
  identity-remap approval, idempotency, and authenticated migration history.
- Added authenticated server-side lawyer directory search and pagination,
  adapted from the predecessor dashboard after fixing its post-pagination
  filtering error, with accurate totals, official NOvA-only filtering, stable
  ordering, and mounted page controls.
- Added coordinated Flask recovery sets for the legal ledger, authentication
  sessions, encrypted OAuth vault, and uploaded evidence, with stable-source
  checks, manifest inventories, external-secret compatibility binding,
  rollback-safe restore, path rebasing, and a blocking destructive drill.
- Added recovery-ready backup sets that bind verified SQLite snapshots to the
  matching desktop or environment-managed token-encryption key, preserve both
  previous files on restore, and reject ambiguous legacy or cross-mode restores;
  version 2 also snapshots referenced local evidence, inventories S3 keys, and
  preserves the previous evidence directory.
- Added persisted desktop keyword-pull jobs with automatic UI recovery, live
  Gmail/Drive/local phase reporting, reviewed-word and item counts, progress,
  ETA, terminal results, and restart-time interruption-safe retry behavior.
- Added one case Timeline workspace for source-linked legal events, source
  documents, and operational activity, with vertical/horizontal event controls.
- Added owner-scoped case-intake draft autosave with restoration across dialog
  close and reload, serialized saves, and clear-on-success semantics.
- Added target database readiness checks for SQLite integrity, foreign keys,
  invariants, reconciliation, duplicates, and known demo markers.
- Added official NOvA-backed matching and review-gated media and organization
  directories inside the consolidated Outreach workspace.
- Added persisted source-grounded desktop document intelligence for TXT, CSV,
  HTML, EML, PDF, and DOCX evidence, with versioned findings, source spans,
  citation validation, and optional deep provider enrichment.
- Added bounded local OCR for Dutch and English image evidence, with bundled
  language data, automatic post-upload analysis, confidence reporting, and the
  same source-linked findings used by Papertrail timelines.
- Added automatic local analysis for supported Gmail, Drive, and local-folder
  imports, including Google-native document export to PDF.
- Added an active case Analysis workspace and generated evidence chronology with
  compact source controls that open the owning document.

### Fixed
- Isolated the backup/restore drill from target production JWT, cookie, S3, and
  local-storage settings so production readiness tests its own fixture instead
  of rejecting or redirecting it.
- Unified outbound-email readiness across the sender, provider checklist, and
  admin diagnostics, and stopped treating a lone SMTP host or sender-less
  SendGrid key as a complete production configuration.
- Normalized directly supplied Flask recovery paths before containment checks so
  Windows short/long profile aliases cannot reject evidence inside the same root.
- Unified direct Flask, launcher, environment-template, and recovery upload-root
  defaults while retaining an existing legacy `instance/laro_uploads` directory.
- Made direct production preflight load the project environment and fail closed
  as production when `NODE_ENV` is omitted, matching operator-readiness behavior.
- Allowed the Vite development proxy to target an explicit LARO API URL instead
  of silently reaching an unrelated process already using port 3000.
- Ignored SQLite WAL and shared-memory sidecars so local operation cannot stage
  transient database state.
- Added a compact legal-assistance notice to every authenticated workspace so
  analyses and generated documents are not presented as definitive legal advice.
- Closed case-ID authorization gaps across auto-collection settings, logs,
  keyword matches, local folders, manual runs, and job creation/status reads.
- Replaced filename-based pull word counts with actual extracted-document word
  counts and confined standalone-server local scans to `LOCAL_SCAN_ROOTS`.
- Moved desktop Google/Microsoft OAuth into a sandboxed allowlisted child window
  so callback Close and automatic-close behavior work under Electron, while
  connection badges update through managed query polling without a page refresh.
- Aligned tagged Windows delivery with the owner-selected no-certificate policy:
  unsigned releases are supported with checksums and explicit warnings, while
  configured signing providers still require a valid signature.
- Reworked the reachable Messages surface as truthful local Case Notes: removed
  fabricated unread, delivery, priority, response-time, subject, and fallback
  template states while retaining real persisted note creation and search.
- Fixed the narrow-screen Cases header, floating assistant, and notification
  popover so primary actions and overlays remain inside a 390px viewport.
- Added accessible names to shared navigation, account, assistant, notification,
  search, privacy, note, and comparison controls; converted Help FAQs to
  keyboard-operable disclosure buttons.
- Replaced unsupported Help claims about billing, provider breadth, response
  SLAs, blanket encryption, and compliance with the actual installed behavior.
- Replaced the stale dashboard title and remote Manus favicon with LARO-owned
  shell metadata, and added authentication autocomplete hints.
- Removed obsolete pricing, checkout, quota-alert, grace-period, and upgrade
  prototypes so core document generation cannot return a fabricated paywall.
- Reduced local usage tracking to real operation and quantity counts; it no
  longer invents prices, reports to a payment provider, or sends quota alerts.
- Removed the unused Microsoft Graph client dependency left behind by the dead
  quota-notification path.
- Evidence, case, and GDPR erasure now delete managed objects referenced by
  canonical, scanner, Google, Gmail, and legacy storage records before deleting
  metadata; storage or database failures abort instead of silently leaving
  partial data.
- Evidence analysis uploads now persist the actual source bytes and SHA-256 hash
  instead of creating metadata-only rows or treating binary files as plain text.
- Scheduled Gmail collection now honors every selected account ID, and enabling
  attachment collection later backfills only the missing message attachments.
- Local evidence links are allowed through Electron only when their resolved path
  remains inside LARO's configured evidence-storage directory.
- Windows distribution documentation now reflects the owner's no-certification
  decision: unsigned internal builds are active and public signing routes are optional.
- Replaced the desktop scanner's false offline login and fabricated upload path
  with shared-session authorization, explicit native folder consent, per-file
  review, real byte persistence, and SHA-256 provenance.
- Restricted 15-minute scanner JWTs to the evidence upload mutation and bound
  `desktop_scanner` provenance to those credentials; removed the obsolete
  all-access local-agent bearer path.
- Removed unreachable scanner, sync, mobile, annotation, and inbox prototypes,
  replaced the old OCR stub with source-grounded local image analysis, and
  removed filename-based confidence labels and invented upload progress from
  reachable evidence controls.
- Removed seven unused runtime packages and their obsolete type packages,
  reducing the install by 33 transitive packages.
- Lawyer search now stores filters under the correct directory type, removes
  fabricated recent-search counts, exposes real filters without a second panel,
  and opens the selected lawyer profile.
- Unfinished placeholder routes and the dead mock email-campaign screen are no
  longer exposed by the production renderer.
- Dashboard routes load on demand, reducing the production entry chunk from
  roughly 891 KB to 274 KB before gzip.
- Local Vite sessions use the same-origin API proxy consistently for
  `localhost` and `127.0.0.1`; authenticated Socket.IO uses resilient
  polling-first negotiation without startup console warnings.
- Packaged Desktop ignores arbitrary launch-directory `.env` files and accepts
  configuration only from deliberately shipped package resources.
- Packaged Desktop cannot inherit Vite, DevTools, or other development behavior
  from a launcher that sets `NODE_ENV=development`.
- Outreach initiation now prepares idempotent lawyer drafts in the same action,
  while approval and irreversible provider delivery remain separate controls.
- Lawyer replies can be recorded through an owner-scoped workflow action and
  update case state, response time, audit history, notifications, and analytics.
- Outreach analytics now use real user-owned pipeline, response, lawyer,
  legal-area, region, and daily trend data instead of hardcoded zero metrics.
- Operator readiness rebuilds the native SQLite driver for Node and preserves
  complete failure output after Electron packaging.
- Renderer builds force production React before Vite loads, regardless of a
  developer machine's local `.env`, preventing development-only reconnects.
- The renderer now uses a local LARO logo, and Windows packaging is configured
  with the same tracked application mark instead of a remote CDN/default icon.
- Historical readiness documentation was reconciled so current release claims
  point to reproducible gates and explicit target-environment acceptance.
- Database backup now uses SQLite's online backup API and validates integrity,
  foreign keys, and core tables before success.
- Restore now stages and validates the replacement, preserves the previous
  database, and rolls back a failed file replacement.
- Operator readiness includes an isolated backup/restore drill.
- Desktop packaging allowlists matcher data instead of shipping the unrelated
  development service and cached Python files under `assets`.
- Packaged Desktop binds to an available loopback port instead of failing when
  port 3000 is occupied.
- Explicit loopback OAuth callback configuration preserves its registered port,
  and operational endpoints report the package version consistently.
- Tagged Windows releases now fail closed on tag/version mismatch, missing
  signing credentials, or an invalid signature and publish a SHA-256 checksum.
- Tagged Windows releases support Microsoft Artifact Signing through GitHub OIDC
  as the preferred alternative to storing a PFX certificate in GitHub secrets.
- Tagged Windows releases also support SSL.com eSigner as a cloud-HSM signing
  provider that does not require an Azure subscription or local hardware token.
- Microsoft Store distribution is supported as the no-recurring-certificate
  path: CI creates and verifies an identity-bound APPX submission package for
  Microsoft to re-sign after Store certification.

## [1.3.0] — 2026-07-06
Closing renderer-independent Partials with real code.

### Added
- **14 missing routers (010/D1):** `server/routers/extendedRouters.ts` — adminAnalytics,
  outreachAnalytics, relevanceScoring, evidenceAggregation, enrichment, evidence,
  evidenceExport, bulkFileOperations, caseManagement, legalChecklists, emailMessages,
  syncScheduler, trello, unifiedInbox. Real DB-backed data or honest typed results.
- **Real outreach send (011/026/017):** `server/outreachSend.ts` + `workflow.sendApproved`
  — gated by emergency stop + `outreach.send.enabled` (default OFF) + Approved state +
  ownership + idempotency. Fails honestly with no provider. Tested (3/3).
- **Multi-user teams (106):** `server/teams.ts` + `teams` router; shared case access
  enforced in `assertCaseOwnership`; isolation preserved. Tested (3/3).
- **Supply-chain review (066):** `docs/SUPPLY_CHAIN.md` — 21 advisories triaged by
  runtime exposure (critical is dev-only vitest; 4 runtime deps scheduled).

### Status
- Historical phase-closure snapshot: **109 Implemented / 7 Partial / 0 Missing**.
  Those renderer residuals were resolved after 1.3.0; current release status is
  maintained in `docs/FINAL_VERIFICATION_REPORT.md`, not this dated snapshot.

## [1.2.0] — 2026-07-06
Closing Partial phases with real code (security & data hardening).

### Added / Fixed
- **Authenticated token crypto (007/030/D4):** AES-256-GCM via `server/crypto.ts`
  (was unauthenticated CBC with a weak key); legacy values still decrypt.
- **CSRF + strict CORS (080/D5):** `server/_core/csrf.ts` — origin guard on
  mutations, never `*` with credentials.
- **Session/JWT revocation (007):** `server/sessionRevocation.ts` +
  `auth.logoutAllDevices`; verified in `context.ts`.
- **Evidence provenance (015):** sha256 content hash persisted on evidence writes.
- **ZIP evidence export (023):** `cases.exportZip` (real `archiver` package).
- **Reminders (027):** `notifications.runReminders` + daily cron, idempotent.
- **LICENSE (067):** top-level proprietary license file.

## [1.1.0] — 2026-07-06
Phases 101–115: operator-readiness, safety controls, and lifecycle.

### Added
- **Emergency stop (104):** operator kill switch (`admin.setEmergencyStop`) that
  halts all outreach prepare/approve immediately; backed by system_config.
- **Data retention (102):** `server/retention.ts` + `admin.retentionPreview/Run` —
  purges audit logs older than the retention window (default 365 days).
- **Safe retries (110):** `server/retry.ts` `retryWithBackoff` with `isRetryable`
  gating, cancellation, jitter; the live job runner now delegates to it.
- **Onboarding (105):** `onboarding.steps/state/complete` first-run flow.
- **Roles (106):** `server/_core/roles.ts` role hierarchy + `system.capabilities`.
- **Debug bundle (101):** `admin.debugBundle` redacted diagnostic snapshot (no secrets).
- **Exception dashboard (109):** `dashboard.exceptions` — only cases needing attention.
- **Real clarifications (111):** `clarifications.pending/answer` computed from case state.
- **Honest confidence (107):** `server/confidence.ts` derives confidence from real scores.
- **Operator tooling:** `npm run preflight` (103), `npm run readiness` (115),
  `npm run regression:baseline` (113), plus `CHANGELOG.md` (112).

### Notes
- Real outreach **send** remains intentionally unbuilt and flag-gated (D3).
- 14 renderer-only routers remain unimplemented (D1) — tracked, hidden work.

## [1.0.0] — earlier
Phases 000–100: honest matrix, critical path (classify→match→prepare→approve, no
send), GDPR, security hardening, tests, CI gates, audits, verification tooling.
See docs/CODEX_CHECKPOINTS.md for the full per-batch history.
