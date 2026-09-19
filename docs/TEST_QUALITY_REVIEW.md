# Acceptance and Smoke Test Quality Review

Current as of 2026-09-19. This review closes the local implementation of issue
#179. It covers every retained test in `tests/acceptance` and `tests/smoke`.

## Evidence policy

- Product acceptance enters through a mounted tRPC procedure, real HTTP
  middleware, migrated temporary SQLite persistence, a provider mock at the
  transport boundary, the renderer in Playwright, or an exported pure runtime
  contract.
- Reading TypeScript, JavaScript, package metadata, or configuration text does
  not prove runtime behavior. The blocking `verify:behavioral-tests` command now
  rejects filesystem readers in the acceptance and smoke directories.
- Static architecture and packaging checks remain valid supplementary
  tripwires under the security/tooling suites. They are not used as the sole
  evidence for a product or security claim.
- `tests/helpers/app.ts` is the one shared migrated-app/tRPC/SQLite
  infrastructure. S0-06 owns hostile security-boundary behavior (authentication,
  authorization, revocation, scanner scope, proxy identity, and realtime
  scope); S0-09 owns successful product paths and truthful product state. The
  ownership split changes assertions, not the harness.

## Replaced low-signal checks

| Former source claim | Behavioral owner now | Regression that now fails |
| --- | --- | --- |
| Matching router contains `findMatchingLawyers` and no `Math.random` | `noFakeSuccess.smoke.test.ts` | Wrong expertise, fabricated records, or unstable scores |
| Dashboard source lacks old constants/sample names | `noFakeSuccess.smoke.test.ts` | Counters/feed ignore persisted owner rows or leak another owner |
| OCR router contains engine symbols | `noFakeSuccess.smoke.test.ts`; document-intelligence backend suite | Invalid bytes report fake success or real image OCR stops working |
| Case outreach source lacks fixed counters | `noFakeSuccess.smoke.test.ts` | Outreach progress diverges from persisted rows |
| Provider route/source names look canonical | live provider lifecycle smoke and provider backend/security suites | Disabled providers claim availability or lifecycle calls bypass the canonical route |
| Disclaimer constant is nonempty | `acceptance.test.ts` | Generated document omits the actual disclaimer in its result/content |
| Settings/auth source lacks retired labels or demo-query logic | Playwright Settings and `?demo=true` contracts | Inert controls render or a URL query bypasses login |
| GDPR/workflow/template procedure names exist in source | `phase021_030.smoke.test.ts` | Export, erasure, approval persistence, or owner-scoped CRUD stops working |
| Security-header strings exist in `server/index.ts` | shared `securityHeaders` middleware plus a real HTTP response | Mounted response omits CSP, frame, MIME, permissions, or API isolation headers |
| `.env` is absent from one package snippet | blocking account-safety and packaged-artifact checks | Installer configuration or produced package exposes environment secrets |
| Schema/audit/dashboard source contains expected symbols | `opsHardening.smoke.test.ts` | Duplicate outreach, missing/visible-to-wrong-owner audit events, or false next actions |

## Retained acceptance regressions

`tests/acceptance/acceptance.test.ts`

- Creates and persists an owned case: catches intake that reports success
  without an owner-scoped row.
- Persists legal-area classification: catches a classification returned to the
  caller but not saved to the case.
- Returns suitable lawyers: catches a disconnected matching route or empty real
  engine result for a valid seeded candidate.
- Reviews and approves without sending: catches bypass of review or approval
  that dispatches implicitly.
- Generates content with the disclaimer: catches a generator that returns a
  constant separately but omits it from the produced document.
- Exports and erases GDPR data: catches empty exports, partial erasure, or fake
  deletion success.

## Retained smoke regressions

`tests/smoke/authz.smoke.test.ts`

- Anonymous protected-route rejection catches an accidentally public case or
  evidence route.
- Owner/private-not-found behavior catches case existence disclosure.
- Cross-owner read/export/analysis/write rejection catches a missed live
  authorization guard.

`tests/smoke/classification.smoke.test.ts`

- Dutch employment input catches loss of Dutch employment keywords.
- Divorce/alimony input catches family-law multi-signal classification drift.
- English landlord input catches loss of real-estate/litigation mapping.
- Unknown input catches false high-confidence classification instead of `Other`.
- Repeated input catches nondeterministic classification.
- Case-type fallback catches failure to use the explicit intake category when
  prose has no signal.

`tests/smoke/configGuard.smoke.test.ts`

- Default production JWT rejection catches a server accepting shipped secrets.
- Empty production secret rejection catches unsigned/forgeable sessions.
- Strong production secrets passing catches an over-broad startup refusal.
- Development warnings catch silent insecure local configuration.
- Required-provider refusal catches production claiming accepted integrations
  without credentials.
- Complete provider/public-route acceptance catches rejection of a valid public
  deployment contract.
- OAuth/public-base drift refusal catches callbacks being sent to a different
  route than the deployed application.

`tests/smoke/criticalPath.smoke.test.ts`

- Single-area normalization catches storage of a scalar instead of canonical
  JSON.
- Multi-area normalization catches loss of valid areas.
- Unknown-area rejection catches unvalidated matching categories.
- Empty-input rejection catches an unclassifiable case entering matching.
- Sanitize/parse round-trip catches canonical areas being lost in persistence.
- Parse filtering catches legacy/hostile values reaching the matching engine.
- Vocabulary check catches an empty/incomplete legal-area contract.

`tests/smoke/noFakeSuccess.smoke.test.ts`

- Stable persisted matching catches fabricated lawyers, wrong expertise, and
  randomized scores.
- Persisted dashboard metrics catch hardcoded counters and cross-owner totals.
- Owned activity feed catches sample activity and tenant leakage.
- Persisted outreach progress catches fixed contact/response/time values.
- Invalid OCR rejection catches canned extraction success for unsupported data.
- Unavailable provider lifecycle catches a disabled integration claiming that a
  connection can begin.

`tests/smoke/opsHardening.smoke.test.ts`

- Rate-window enforcement catches a limiter that never blocks.
- Named finite limits catch removal/zeroing of sensitive-route policies.
- Direct-client IP handling catches trust in forged forwarded headers.
- Trusted-chain handling catches attribution to a proxy instead of the client.
- Successful job status catches a scheduler that does not record completion.
- Retried failure status catches missing retries or an exception escaping the
  scheduler boundary.
- Live reset-bucket identity catches IP rotation through forged headers.
- Idempotent outreach initiation catches duplicate drafts or reset review state.
- Owner-only audit read catches missing events, unmounted history, or tenant
  leakage.
- Derived next actions catch hardcoded advice and cross-owner case visibility.

`tests/smoke/phase021_030.smoke.test.ts`

- Live intake validation catches invalid email/name/urgency reaching storage and
  missing defaults on a valid case.
- Owner-scoped message-template CRUD catches no-op writes, false success, or a
  cross-owner update.
- Approval persistence catches a route returning `sent: false` without saving
  the approved state.
- GDPR persistence check catches an export/erasure facade that leaves rows.
- Real HTTP header check catches production middleware not being mounted even
  when header strings still exist elsewhere.

`tests/smoke/storage.smoke.test.ts`

- Leading-slash removal catches absolute storage paths.
- Parent-segment removal catches traversal through storage keys.
- Backslash normalization catches Windows-style traversal ambiguity.
- Legitimate nested-key preservation catches destructive over-sanitization.
- Filename baselining catches directory components reaching downloads.
- Empty filename fallback catches invalid response filenames.
- Stable SHA-256 catches nondeterministic provenance identifiers.
- Content-sensitive SHA-256 catches identical provenance for changed bytes.
- Empty storage-key rejection catches reads escaping the managed storage
  contract.

## Renderer contracts

The Playwright suite now verifies the actual Settings page at desktop and mobile
widths: retired inert controls are absent, Account archive is present, the owned
legacy import renders, and the page has no horizontal overflow. A separate live
browser check confirms that `/?demo=true` remains on the sign-in screen. These
are renderer behaviors; no component source is read as evidence.

## Local verification

- Focused acceptance/smoke run: 4 files, 27 tests passed.
- Chrome renderer contracts: 2 tests passed against the real Vite/Express
  runtime (Settings at desktop/mobile widths and demo-query authentication).
- Complete blocking gate: 174 files passed and 1 skipped; 1,030 tests passed and
  2 skipped in 630.65 seconds.
- Server, Electron-main, and renderer typechecks; lint; renderer/source/action
  boundaries; bundle budgets; release acceptance; 117/117 traceability;
  dependency audits with 0 vulnerabilities; account/runtime scans; and both
  recovery drills passed.

These are local results. Issue #179 remains open until this branch is pushed,
protected GitHub checks pass, and the owner reviews/merges the change.
