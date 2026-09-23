# Final account and lifecycle verification

Date: 2026-09-23

Issue: [#201 S8-08](https://github.com/Robert-Velhorst/000-LARO/issues/201)

Implementation commit: `ec94985e9d78fc95ad14e89473f79dec287b1825`

Branch: `milestone3/remediate-roadmap`

## Result

The repository-controlled acceptance matrix for the final account and lifecycle
round passes on the implementation tree identified above. This verifies the
local source, tests, production builds, fresh-database and recovery operations,
browser behavior, container, and Windows package structure. It does not claim
that the commit is pushed or merged, that GitHub's protected checks passed, or
that a Windows device or Hetzner deployment accepted this build.

## Included implementation issues

| Issue | Commit | Verified outcome |
| --- | --- | --- |
| #194 S1-27 | `0804c39` | Desktop scanner rows, paths, preferences, workers, export, and erasure are bound to the authenticated owner. |
| #195 S1-28 | `6b7c9ef` | Optional usage analytics defaults off and controls the canonical writer in the same database transaction as its consent read. |
| #196 S1-29 | `ad59945` | Account erasure requires a fresh one-use server proof, revokes supported provider grants before local deletion, and reports retryable/pending cleanup states truthfully. |
| #197 S1-30 | `95375c3` | Assistant requests carry an explicit visible case or use product-help mode; account/case changes discard stale answers. |
| #198 S2-24 | `2f716c0` | Home metrics and workflow actions are derived from canonical owner-scoped case, evidence, outreach, collection, and review state. |
| #199 S2-25 | `691f8b3` | Collection monitoring reads the canonical persisted keyword-pull jobs, including restart reconciliation and per-source provenance. |
| #139 S4-10 | `ec94985` | Disconnected Trello and Telegram credential, router, service, and callback stacks are absent; historical labels remain readable only. |

The corresponding GitHub issues were still open when this local report was
written. Local implementation and verification are not remote issue closure.

## Exact-commit release evidence

| Command or artifact | Result |
| --- | --- |
| `npm run gate` | Pass. 188 test files passed, 1 skipped; 1,080 tests passed, 2 skipped. All type, lint, policy, traceability, safety, recovery, Node, and Python gate stages passed. |
| Traceability and static safety in the gate | 117/117 implemented rows cited, 0 broken, 0 uncited; 0 actionable runtime no-excuses markers; 0 HIGH account-safety findings across 233 runtime files. |
| `npm run test:a11y:browser` (stable Chrome, one worker, temporary profile under `/dev/shm`) | Pass, 45/45 scenarios in 7.7 minutes. The run checks rendered content, HTTP responses, console/page errors, failed requests, responsive layouts, keyboard behavior, axe findings, and workflow-specific screenshots. |
| `npm run build` | Renderer, Electron main, and standalone server production builds pass. |
| `npm run db:readiness` on a fresh SQLite database | Pass: integrity `ok`, 0 foreign-key violations, invariants and reconciliation clean, 15/15 numeric fields, 7/7 cross-counter constraints, all 273 relationship guards installed, and no demo/test markers. |
| `npm run recovery:drill` | Pass: encrypted recovery restores the database, matching desktop secrets, and managed evidence while preserving the previous database, secrets, and evidence directory. |
| Isolated Python 3.12.13 environment | All 59 resolved packages pass `pip check`; unittest discovery passes 223/223 tests in 118.246 seconds. |
| Dependency audits | Full and production-only npm audits each report 0 vulnerabilities. |
| Secret scans | Gitleaks 8.24.3 reports no leak in 355 commits, no leak in the exact `ec94985` tree, and no leak in the extracted Windows application payload. |
| Docker build | `laro-server:final-account-ec94985` builds with refreshed bases. Image ID `sha256:9049b144a83899b841ee731e997e996337d98436d0f39ede7f714d6b7022f99f`; size 710,821,430 bytes. |
| Container vulnerability scan | Trivy 0.74.0 reports 0 HIGH/CRITICAL Debian 13.7 or Node findings. |
| Container inventory | CycloneDX SBOM is 595,156 bytes with SHA-256 `90164fba7fe24c86c4349fe4151953a9faeccdba3e5aaaf3bc77f8f23d514e27`. |
| Windows portable packaging | `npm run dist:win` and `npm run verify:packaged:native` pass. The unpacked app, SQLite binding, and Canvas binding are Windows x64 PE candidates. |
| Windows artifact | `release/1.3.0/LARO Desktop 1.3.0.exe`, 160,637,500 bytes, SHA-256 `a51bb2755a978113d145335df03ba7e6ad0fab8b4acf099d042bd3ea0de294e2`. No `.env`, SQLite database, upload directory, or persisted desktop-secret file is present in its ASAR inventory. |

`npm run gate` generates repository evidence files. Its only working-tree output
after the implementation run was the expected account-safety source-count
update from 234 to 233 following removal of a runtime source file. The generated
verification documents are committed separately from the recorded
implementation commit.

## Integrated behavioral proof

| Boundary | Executable proof |
| --- | --- |
| Scanner owner switching | `scannerOwnerAuth.test.ts`, `scannerOwnerIsolation.test.ts`, scanner selection/resume suites, and Chrome account-switch scenarios prove rows, case IDs, folder preferences, events, and upload credentials cannot cross owners. |
| Scanner retention and erasure | `scannerPrivacy.test.ts`, GDPR suites, retention logic, and Chrome privacy flows prove owner-only export/erasure, legacy-row quarantine, path removal, and account-keyed browser storage. |
| Server-side erasure verification | `accountErasure.test.ts`, provider atomicity suites, and Chrome prove password/code verification, session binding, expiry, replay rejection, supported upstream revocation, retryable failure, durable receipts, and cleanup queues. |
| Enforced optional processing | `privacyProcessing.test.ts`, usage telemetry suites, mandatory-audit tests, and Chrome prove default-off, opt-in, opt-out, concurrent ordering, account isolation, direct API enforcement, and required-record separation. |
| Explicit assistant context | `caseAssistant.test.ts`, `productAssistant.test.ts`, and Chrome prove visible owner/case validation, explicit product-help mode, navigation/account invalidation, and stale-response suppression. |
| Truthful Home workflow | `dashboardSummary.test.ts` and Chrome prove canonical counts, definitions, availability, review queues, and registered case destinations without fabricated progress. |
| Restart-safe collection monitoring | `collectionMonitoring.test.ts`, query-efficiency/e2e suites, and Chrome prove one persisted job authority, owner/case filtering, source outcomes, exact revisions, interrupted-run reconciliation, and keyboard-accessible history. |
| Unsupported connectors | `unsupportedConnectors.test.ts`, production-readiness/isolation suites, and maintained-source search prove there is no callable Trello/Telegram route, token procedure, callback, import service, or success response. |

## Maintained-source audit

The affected maintained roots (`server`, `src-main`, `src`, `shared`, and
`scripts`) were searched after the complete test run.

- Scanner inserts require `ownerId` and `caseId`; database triggers reject empty
  owners and identity changes. Reads, selection, resume, export, and erasure use
  owner predicates. The sole runtime `createScan` caller passes the owner
  resolved from the current HTTP-only session, and uploads retain that captured
  owner's credential.
- `active-case-context-id` occurs once in runtime code, only in a
  `localStorage.removeItem` migration. Assistant authority comes from explicit
  component state plus an owner-checked `cases.byId` query and request `caseId`.
- The general privacy value contains only `analytics`; the removed `marketing`
  field is discarded. The only optional usage writer calls
  `isUsageAnalyticsEnabled` in its insert transaction.
- No insert or update of legacy `auto_collection_logs` exists in maintained
  runtime code. The monitoring API and renderer use `keyword_pull_jobs` through
  `getKeywordPullMonitoring`; old rows are retained only for schema/readiness and
  historical live-acceptance cleanup compatibility.
- The Trello/Telegram router and service files are absent. Searches find only
  an explicit unsupported provider checklist and historical-source display
  labels; no credential environment key, token input, callback, webhook,
  download/import/sync handler, exported connector route, or fake-success path
  remains.
- The gate's no-excuses, release-acceptance, security-workflow, account-safety,
  renderer-boundary, and behavioral-boundary checks pass. No new unowned or
  uncalled affected path was found.

## Failure reconciliation

The first complete Chrome attempt passed 41/45 scenarios. Four pages were blank,
and retained Playwright traces showed Chrome rejecting Vite module and image
requests with `net::ERR_INSUFFICIENT_RESOURCES`; the failures did not reach the
product assertions. The same four scenarios passed 4/4 after moving the
temporary browser profile to `/dev/shm`, followed by the recorded 45/45 full
run on unchanged source. This was host temporary-storage exhaustion, not four
independent UI defects.

A broad working-directory Gitleaks pass treated the ignored binary ASAR as one
opaque text stream and reported four dependency fixture signatures. Scanning
all commits and the exact tracked tree produced no findings; extracting the
new ASAR and scanning its 15,385 packaged paths also produced no findings. No
credential value was printed or retained.

No repository-controlled acceptance failure remains. Hosted CI/CodeQL,
protected-branch review, native Windows launch/OCR, live provider retest, real
data migration, and Hetzner browser/desktop acceptance remain external gates
and must not be described as completed by this report.
