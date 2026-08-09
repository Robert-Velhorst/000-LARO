# Final Verification Report

Date: 2026-08-09
Verification target: protected `main` merge commit
`ed177f59d8fc01d05b14c5b84d72b5cc74b7e7bf`, based on starting commit
`b5ae60787000f82b6a9e90a78c2c202674dc7dd1`

This report separates reproducible repository evidence from target-environment
acceptance. It supersedes the 2026-07-06 phase snapshot.

## Automated release evidence

| Gate | Result |
|---|---|
| Server, Electron main, and renderer TypeScript | Pass; 0 shipped runtime `@ts-nocheck` bypasses |
| ESLint | Pass |
| Requirements traceability | 117 rows, 117 cited, 0 broken, 0 implemented without an artifact |
| Runtime no-excuses scan | 0 suspect findings |
| Account-safety scan | 0 high-severity findings |
| Renderer accessibility | 15 routes x 2 viewports; 0 serious/critical axe violations, unnamed controls, overflows, request failures, page errors, or console errors |
| Isolated backup/delete/restore/reopen drill | Pass |
| Target database readiness | SQLite integrity, declared foreign keys, 237 legacy relationship guards, invariants, reconciliation, duplicates, and demo markers clean |
| Vitest | All 67 files exercised; 398 tests passed and 10 explicitly skipped; two suites that hit setup timeout in the full constrained-host run passed immediately in isolation |
| Python unittest discovery | 222 tests passed |
| Runtime dependency audit | 0 known vulnerabilities |
| Renderer, main, and server production builds | Pass |
| Portable Windows packaging | Pass with tracked LARO icon; unsigned by policy; Electron 43.1.0 native SQLite ABI 148 verified |
| Packaged `/api/health` | `healthy`, database ready, version 1.3.0 |
| Packaged document intelligence and Outreach | Eight migrations present, including persisted keyword-pull jobs, the legacy-import archive, and owner-scoped HAI credentials; PDF, DOCX, native parser dependencies, and review-gated Outreach tables present; integrated server booted successfully |
| LARO-to-HAI connector | Dedicated read-only feed; hashed, expiring, revocable owner credential; bounded cursor; minimization and rate limit; LARO and HAI adapter tests pass |
| Desktop scanner contract | Scoped 15-minute token; real bytes/hash; owner/MIME enforcement |
| Branch CI policy | Node, Python, and renderer-accessibility checks run before merge |
| Protected-main CI | Actions run `31289640812`; Node, Python, and renderer-accessibility jobs passed |
| Windows package | Actions run `31289640843`; gate, build, ABI check, package, single-instance profile lock, checksum, and artifact upload passed |
| Packaged matching assets | Seven aligned legal categories; invalid legacy dataset absent |
| Dependency graph | One canonical Node workspace; 0 open Dependabot alerts |

`npm run readiness:production` passed both with strong target-like secrets and
with the current API deployment's standalone secrets plus an integrity-checked
snapshot of its clean target database. The readiness command restores the Node
SQLite ABI itself after Electron packaging, runs the data-readiness gate, and
preserves complete stdout/stderr for any failed step.

A manifest-bound target recovery set was then created and validated against the
current standalone JWT secret. Validation covered 54 tables and complete local
evidence storage; publication and validation left no untracked SQLite temporary,
WAL, or shared-memory sidecars.

The current renderer audit passed four real-browser scenarios in 201.9 seconds:
all 15 routes at 1440x900 and 390x844, persisted locale switching, responsive
legacy-ledger migration presentation, and source-linked document
reconstruction. There were no blocking accessibility violations, unnamed
controls, horizontal overflows, request failures, page errors, or console
errors. The in-app browser surface itself could not attach a local webview on
this host; the independently launched Chromium audit is the acceptance evidence.

## Packaged UI evidence

Playwright exercised the unpacked Windows application at 1440x900 and 390x844:

- sign in with a real persisted account;
- authenticated Socket.IO connection established without console warnings;
- Outreach opened from the sidebar;
- real empty-state metrics, pipeline, quality, and daily activity rendered;
- reporting period changed from 30 to 90 days;
- desktop and mobile layouts remained readable without overlap or horizontal
  tab/content compression.
- lawyer directory search used real loaded records, legal-area and text filters
  updated the result set, and View Profile opened the selected persisted record;
- development proxy, CSRF, and authenticated Socket.IO negotiation completed on
  `127.0.0.1` with no console errors or warnings.
- case intake restored a draft after immediate close and full reload, retained
  the dialog on failure by contract, updated the case list after successful
  creation without a manual reload, and cleared the persisted draft only after
  success.

A second packaged-window run exercised the rebuilt scanner surface:

- account signup established the shared authenticated desktop session;
- the scanner opened on the package-selected loopback port and loaded the real
  empty case state without console warnings or errors;
- folder selection remained available, while scan execution stayed disabled
  without both a selected case and a native-picker-approved folder;
- Settings opened and returned to evidence collection; the viewport had no
  horizontal overflow or overlapping controls.

The 2026-07-20 isolated-profile package check additionally verified account
signup, the retained Gmail and Google Drive connection controls, the local-folder
picker entry point, user-scoped account and activity exports, mobile navigation,
and a clean browser console. Settings no longer exposes inert outreach,
notification, matching, personalization, or restorable-backup controls.

A clean-profile packaged evidence run then created a case, configured a local
folder, and pulled 40 matching text records through the real background job:

- the interface exposed queued/running state, word and item counters, progress,
  completion state, and disabled conflicting controls while work was active;
- completion reported actual extracted-document words and `40 / 40 items`, and
  persisted one job;
- all 40 records were extracted and analyzed, and the visible evidence list
  replaced its empty state automatically without a reload;
- the consolidated Timeline workspace generated 40 source-linked legal events,
  exposed Legal events, Source documents, and Case activity views, and switched
  between vertical and horizontal layouts while retaining all 40 source buttons;
- desktop and 390x844 responsive checks had no page-level horizontal overflow,
  framework overlay, console error, or console warning.

A clean-profile packaged run created a new local account and checked the 14
routes mounted at that time at both 1440x900 and 390x844. The subsequent
automated renderer audit adds `/evidence`, covering all 15 currently supported
static routes at both sizes:

- all 30 current route/viewport combinations rendered meaningful content and an `h1`;
- no route had horizontal overflow, unnamed visible buttons, unlabeled visible
  fields, missing image alternative text, blank content, or a framework error;
- the 366x820 assistant remained inside the 390x844 viewport and exposed named
  open, minimize, close, input, and send controls;
- the notification popover, Help accordion, and Case Notes compose flow worked
  without fabricated delivery filters or support promises;
- the shell used the packaged LARO favicon and title, and authentication exposed
  correct email, current-password, new-password, and one-time-code metadata;
- no page error, console error, or console warning occurred during the sweep.

The authenticated shell also carries a compact, programmatically named
legal-assistance notice on every route. A development-renderer check created a
real local account, moved from Home to Cases, and observed the notice after both
renders with no console warning, console error, framework overlay, or horizontal
overflow at 2560x1440.

The legacy-dashboard port audit also exercised the consolidated Evidence route
at 1440x1000 and 390x844. A persisted local case selected without reload, the
CSV export downloaded real case-scoped bytes, ZIP and CSV availability matched
the server contract, PDF remained visibly unavailable, and batch scoring stayed
disabled with a collection prompt while the case had no evidence. The inherited
dark-theme recommendation contrast defect found during this pass was corrected
and visually rechecked.

The current local candidate `LARO Desktop 1.3.0.exe` is 151,855,902 bytes with
SHA-256 `5d2bef95bf76adb258c0b1a38b9ef820937d2de9992c15dfea16059c0069198f`.
It was built on 2026-08-09 and passed the Electron native SQLite check.

The protected-main portable artifact is GitHub Actions artifact `9031062536`
from run `31289640843`. Its executable is 151,920,228 bytes with SHA-256
`c620deecd8ea4ddb171a7a95ad40bce8f2790f9bfa54a2c48187285b90c09125`;
the downloaded executable matches its packaged checksum sidecar. The workflow
passed the production gate, build, Electron ABI/database-binding check,
portable packaging, packaged single-instance profile lock, artifact staging,
and upload. Windows reports `NotSigned`, matching the selected unsigned
internal distribution policy.

The API-only Docker deployment was rebuilt on Node 22 from the current release
line while retaining its explicitly named data volume. Local `/api/live`,
`/api/ready`, and `/api/health` checks pass, the reported version is `1.3.0`,
and SMTP authentication succeeds without sending a message. The Google web
client is configured, but the owner's OAuth grant is not yet stored. The ngrok
gateway now routes `https://laro-api-000.ngrok.app/laro` to LARO; public root,
live, ready, health, and protected HAI route ownership were verified on
2026-08-09.

The deployed HAI bridge completed its live acceptance on 2026-08-09. A temporary
owner credential returned health 200 and a bounded feed, then returned 401
immediately after revocation. A separate 90-day credential is retained only in
HAI's protected ignored environment. HAI created source
`9a4adef2-41ad-4cc9-95cf-cf0438b15688`, reported the `laro` adapter operational,
completed an incremental sync with zero failures, and retained its read audit
event. LARO contained zero cases, so zero synchronized items is the truthful
result; no sample legal record was created. The LARO database retains one active
and one revoked connector credential, two feed-read audit entries, two creation
entries, one revocation entry, and no bootstrap secret file.

Packaged clean-profile evidence for this release line also verified fresh local
secrets and databases, all eight packaged migrations, healthy version `1.3.0`
startup, SQLite integrity with zero foreign-key violations, and all 237 required
relationship guards. Packaged resources contain the current migrations,
PDF/DOCX parsers, native parser dependency, consolidated managed-storage
deletion, legacy-import archive and HAI credential schemas, and seven-category matching data.

An earlier isolated package from the same release line was launched with
`NODE_ENV=development` deliberately injected by its parent process. It still
served `/api/health` as `healthy`,
`production`, version `1.3.0`, opened only the dashboard window, and created no
DevTools or startup-error window. Packaged builds therefore cannot inherit a
development renderer path from the launching shell.

## Verified product path

- Core local workflows are unmetered. Usage telemetry stores operation and
  quantity counts only; there is no checkout, upgrade, quota, or payment-provider
  enforcement path.
- Case creation, deterministic classification, lawyer matching, and idempotent
  draft preparation are real database-backed actions.
- Starting outreach prepares reviewable drafts in one action. It does not send.
- Approval and irreversible delivery remain separate. Delivery requires the
  owner, Approved state, enabled feature flag, released emergency stop, a real
  provider, and an unsent idempotency state.
- Lawyer responses are owner-scoped and update response timing, audit history,
  notifications, analytics, and the matched case state when interested.
- Outreach analytics are derived from the authenticated user's records rather
  than mock counters.
- Persisted notifications are emitted only to the authenticated user's realtime
  room; the client retains polling as a recovery path.
- Desktop scanning requires explicit native folder consent and per-file review;
  selected bytes are persisted through the canonical evidence upload route with
  content-hash provenance. Scanner bearer tokens cannot access other protected
  procedures.
- Supported Gmail, Drive, local-folder, and direct uploads persist retrievable
  bytes and trigger versioned local analysis. Google-native documents are
  exported to PDF instead of being passed through an invalid media download.
- The desktop Google grant is limited to Gmail read, Drive read, and account
  email identity. Disconnect revokes the durable refresh grant before local
  encrypted credentials are erased; a provider or network failure retains the
  owner-scoped credential for retry. Unfinished Microsoft collectors cannot
  start a new OAuth connection or appear configured.
- Evidence, case, and account deletion remove owned managed-storage objects
  before metadata and abort on storage or database failure instead of silently
  leaving partial data.
- TXT, CSV, HTML, EML, PDF, and DOCX evidence produces source-grounded parties,
  dates, amounts, claims, obligations, legal issues, risks, and chronology.
  Optional provider enrichment is retained only when every observation resolves
  to an extracted source segment.
- The active case workspace exposes document analysis and an automatically
  generated evidence timeline. Each event retains a compact source control that
  opens the owned evidence document.
- Lawyer matching loads a valid curated terminology dataset whose seven category
  keys are checked against the specialization taxonomy. It no longer silently
  falls back around the truncated asset or claims unsupported 877k-case scoring.
- KvK public-record lookup follows the current official open-dataset path and
  response contract. The interface accepts the supported eight-digit identifier
  and no longer presents unavailable LinkedIn enrichment as a lookup result.
- The obsolete nested `assets` npm/Electron workspace was removed. It was not a
  runnable product surface and was the sole source of 72 stale dependency alerts.
- `main` requires pull requests, strict Node/Python status checks, stale-review
  dismissal, resolved review conversations, and disallows force pushes/deletion.

## External acceptance still required

| Gate | Current state | Required evidence |
|---|---|---|
| Trusted public Windows distribution | Deliberately out of scope | Configure Store or certificate signing only if platform publisher trust becomes a requirement; unsigned tagged delivery remains supported with a checksum and warning |
| Public branding | Approved on 2026-07-21 | Owner-approved LARO timeline mark is stored in `build/icon.png` / `public/laro-logo.png`; release acceptance binds both files to SHA-256 `134ca32789b6dd24f0c39d461f0c405f1e1156475dceb0fa4e525373ab200a0f` |
| Live providers | Google and outbound email selected; live checks pending | Complete the recorded Google checks (`credentials`, consent, Gmail/Drive read, evidence/source opening, revocation) and outbound-email checks (approved single delivery, audit record, duplicate blocking) with owner-controlled production accounts |

These external states are represented in `release-acceptance.json`. Normal
development builds may retain pending gates, but the tagged release workflow
requires a reviewed approver, timestamp, evidence, provider scope, and complete
provider-specific checks before it can publish.

## Residual engineering work

- Existing Flask ledgers remain separate immutable migration sources until the
  operator completes the documented offline, owner-bound migration. Electron is
  the sole production authority afterward; concurrent or bidirectional editing
  is unsupported.
- Historical tables use non-destructive database relationship triggers until a
  future backup-tested migration can replace them with native foreign keys;
  reconciliation remains the explicit repair path for pre-existing drift.
- Route-level lazy loading keeps the production entry chunk near 276 KB before
  gzip; the largest route chunk is near 266 KB.
- The persisted NL/EN runtime covers authentication, application navigation,
  legal safety messaging, and the complete desktop scanner workflow. Source,
  provider, and user-authored content retains its original language. Firefox
  and Safari are not targets for the packaged Electron application; formal
  WCAG conformance is not claimed.

## Verdict

The repository is a verified unsigned release candidate: the code,
tests, recovery path, packaged startup, authenticated realtime channel, and
tested user flow are operational. Public signing and Store certification are not
part of the selected distribution path. Windows may show an unknown-publisher
warning. Live-provider and public-brand acceptance remain environment and owner
gates respectively and continue to block a versioned release until recorded.
