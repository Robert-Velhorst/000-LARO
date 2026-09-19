# Third-Round Trust and Resource Verification

Date: 2026-09-19

Issue: [#178 `[S8-06] Verify the third-round trust and resource fixes`](https://github.com/Robert-Velhorst/000-LARO/issues/178)

Candidate branch: `milestone3/remediate-roadmap`

Recorded implementation commit: `6011f45e03145b85820ed8cb94e57a3a94ed5ec8`

## Verdict

The repository-controlled acceptance criteria for issue #178 pass on the
recorded implementation commit. The complete blocking gate, production builds,
fresh-database readiness, encrypted recovery, Python suite, dependency audits,
Docker image build, Windows packaging, maintained-source audit, focused
negative paths, and real-browser checks all passed.

This is a local candidate verification. It does **not** claim that the branch
has been pushed, merged to `main`, accepted by GitHub CI, launched on native
Windows hardware, deployed to Hetzner, or accepted through the public browser
and desktop clients. The GitHub issues remain open until the owner reviews the
candidate and the normal pull-request workflow records those external events.

## Prerequisite implementation ledger

The implementation for every prerequisite named by #178 is present in the
candidate history. An open GitHub issue is not represented here as closed.

| Issue | Implemented by | Repository result |
|---|---|---|
| #154 S0-08 | `33ac434` | Immutable workflow action revisions and verification gate |
| #155 S1-12 | `9ded0cf` | OAuth callback bound to the initiating browser/session |
| #156 S1-13 | `d1dd0ae` | Full-session renderer token path removed; scanner authority retained in Electron main |
| #157 S1-14 | `d2c8dbf` | Credentialed origins bound to the active runtime |
| #158 S1-15 | `db973f1` | Account-bound reset budget across changing client addresses |
| #159 S1-16 | `877854a` | AI timeline corrections stay review-only and source-grounded |
| #160 S1-17 | `27e6f90` | No-case assistant limited to product help |
| #161 S1-18 | `2961a3e` | Unexpected tRPC failures mapped to safe public envelopes |
| #162 S1-19 | `52596a4` | Version-4 recovery payload encrypted with a separate recovery key |
| #163 S1-20 | `a26f1f8` | Scanner approval bound to path identity, bytes, and hash |
| #164 S1-21 | `249f4f4` | KvK output limited to supported factual public-record data |
| #165 S1-22 | `a054df1` | Required audit rows transact with consequential state changes |
| #166 S2-12 | `db41f04` | Bounded, persisted, cancellable, resumable scanner uploads |
| #167 S2-13 | `4ce8400` | Owned clarification answers apply to canonical case fields |
| #168 S2-14 | `42d58a9` | Outreach initiation is atomic, state-valid, and idempotent |
| #169 S2-15 | `35dfaaf` | Global-search results resolve to registered, reload-safe views |
| #170 S2-16 | `5e93efa` | Lawyer comparison uses canonical records and case actions |
| #171 S2-17 | `88137bb` | Account and lawyer IDs no longer derive from timestamps |
| #172 S3-02 | `508f91b` | One persistent owner-scoped model-usage budget |
| #173 S3-03 | `2e3ef99` | Cumulative evidence-ingestion item, byte, queue, and analysis budgets |
| #174 S4-13 | `8dda6d7` | One provider credential lifecycle and canonical exported routes |
| #175 S4-14 | `1cd1148` | Unwired lawyer-rating subsystem retired |
| #176 S4-15 | `87d160e` | One owner-scoped onboarding implementation mounted in the product |
| #177 S4-16 | `cbf21dd` | Inert flags retired; demo mode uses the canonical environment boundary |

## Exact-commit release evidence

| Command or artifact | Result on `6011f45` |
|---|---|
| `npm run gate` | Pass. 174 test files passed, 1 skipped; 1,050 tests passed, 2 skipped; 651.39 seconds. All blocking stages passed. |
| TypeScript and lint within the gate | Server, Electron main, and renderer typechecks pass; ESLint passes. |
| Repository policy gates | 102 maintained renderer files reachable; 34 immutable workflow-action references; renderer bundle budgets pass. |
| Traceability and static safety | 117/117 rows cited, 0 broken, 0 uncited implemented rows; 0 runtime no-excuses suspects; 0 HIGH account-safety findings. |
| Dependency audits | Full and production-only npm audits both report 0 vulnerabilities. Python `pip check` reports no broken requirements. |
| `npm run test:a11y:browser` with installed stable Chrome | 27/27 scenarios pass in 5.9 minutes using one worker. |
| `npm run build` | Renderer, Electron main, and server production builds pass. |
| `npm run db:readiness` on a new database | Pass: SQLite integrity, foreign keys, invariants, reconciliation, canonical-email uniqueness, numeric compatibility, demo markers, and all 255 relationship guards. |
| `npm run recovery:drill` | Pass: encrypted payload restores database, desktop secrets, and managed evidence; previous state is preserved. |
| Flask recovery drill within `npm run gate` | Pass: ledger, sessions, OAuth vault, and uploaded evidence restore with prior paths preserved. |
| Python unittest discovery | 223/223 tests pass in 63.296 seconds. |
| Docker | `laro-server:third-round-6011f45` builds; image ID `sha256:05d9bd5db9ed210e0b2f69cea82b154727a6bac680f5e123f0c0a499e246c367`, size 785,737,820 bytes. |
| Windows portable packaging | `npm run dist:win` and `npm run verify:packaged:native` pass. EXE, SQLite binding, and scanned-PDF canvas binding are Windows x64 PE candidates. |
| Windows artifact | `release/1.3.0/LARO Desktop 1.3.0.exe`, 160,532,432 bytes, SHA-256 `c11ebeef4efd5536380ecc2bb284ba506f5cd1380432aa9667fefe16b2dc401e`. |

The gate also records approved historical release-acceptance metadata. That
record was validated, but this verification did not repeat live provider calls
or extend the historical acceptance to a new public deployment.

## Browser evidence

Playwright launched the actual application server and Vite renderer in stable
Chrome. The suite checked rendered pages, navigation, HTTP response status,
unexpected request failures, page errors, console errors, axe findings,
control names, horizontal overflow, keyboard use, forced colors, 200% zoom,
desktop/mobile reflow, reload persistence, and recovery states.

The suite intentionally exercised sanitized lawyer-matching failure, invalid
login, a temporary notes outage, and a missing-result response. Their expected
console entries were asserted as negative paths; no unexpected browser error or
raw internal detail reached the user.

Fresh screenshots were visually inspected after the exact-commit run:

- `test-results/document-sources-desktop.png`
- `test-results/document-sources-mobile.png`
- `test-results/rendererAccessibility-auth-f473d-s-fields-on-an-inline-error/authentication-desktop.png`
- `test-results/rendererAccessibility-scan-92550-sumes-it-without-rescanning/scanner-resumed.png`

The sampled desktop, mobile, authentication, document-source, and resumed-scan
states were readable and correctly reflowed, with no clipping, overlap,
horizontal overflow, broken controls, or hidden status information.

## Required negative-path evidence

| Required case | Behavioral proof |
|---|---|
| Cross-session OAuth | `tests/backend/oauthSessionBinding.test.ts:51` rejects another browser, provider mismatch, start replay, and callback replay without linking credentials. |
| Malicious loopback | `tests/backend/partials_hardening.test.ts:113` rejects another loopback port for credentialed CORS/mutations; `tests/localGoogleCallback.test.mjs:7` proves the desktop callback bridge is loopback-only, narrowly routed, strips credentials, and closes. |
| Distributed password reset | `tests/security/passwordReset.test.ts:95` enforces one account budget across rotating addresses; line 143 rejects expired and reused challenges with the same public response. |
| Ungrounded AI | `tests/backend/manualTimelineCorrection.test.ts:164` rejects hallucinated support and cross-case references without mutation; `tests/backend/productAssistant.test.ts:20`, `:37`, and `:64` refuse no-case legal improvisation and never call a provider. |
| Raw error leakage | `tests/security/trpcErrorBoundary.test.ts:65` rejects route, database, storage, and provider detail leakage while preserving only reviewed conflict/validation messages. |
| Copied backup | `tests/backend/backupSet.test.ts:74` proves the copied payload does not expose SQLite, evidence, or app-secret bytes; lines 129 and 150 reject tampering and the wrong/separately rotated key. |
| Changed after review | `tests/backend/scannerFileApproval.test.ts:42`, `:56`, and `:68` return edited, replaced, or deleted approved files to review. |
| Unaudited action | `tests/security/mandatoryAuditDurability.test.ts` injects audit-store failures across emergency stop, flags, HAI credentials, privacy, providers, cases, evidence, and outreach; state rolls back or externally ambiguous dispatch is marked uncertain and blocked from blind retry. |
| Over budget | `tests/security/llmUsageBudget.test.ts:28`, `:50`, `:75`, and `:115`, plus `tests/security/evidenceIngestionBudget.test.ts:24` through `:155`, prove per-operation, cumulative owner, item, byte, queue, and concurrency ceilings. |
| Retry/recovery | `tests/backend/scannerUploadResume.test.ts:76` through `:215` covers duplicate, retryable, permanent, restart, cancel, and resume behavior; `tests/backend/oauthTokenRetry.test.ts:15` through `:96` covers bounded OAuth retry/timeout/response limits; browser tests at `rendererAccessibility.spec.ts:1193` and `:1210` prove visible retry and persisted resume. |

## Maintained-source audit

The post-fix search covered `server/routers`, all maintained `server` modules,
`src-main`, the reachable renderer tree, and `shared`.

| Audit question | Result |
|---|---|
| Full-session token export | No `getApiToken`, session-signing export, or renderer-accessible full-session token path found. Server-only cookie handling remains internal to request context. |
| Duplicate refresh path | Exactly one OAuth `refresh_token` grant remains, in `server/providerConnections.ts:312`; Gmail, Drive, collection, and live-acceptance consumers use canonical `getProviderAccessToken`. Authorization-code exchange endpoints are not refresh implementations. |
| Dead onboarding source | Maintained implementation is `server/onboarding.ts`, `server/routers/onboarding.ts`, and `src/renderer/components/OnboardingFlow.tsx`, mounted by `DashboardApp.tsx`. No second maintained wizard exists. |
| Inert feature flag | Only typed, owned, stored, consumed, and tested `outreach.send.enabled` remains. No `analytics.enabled` or `demo.mode` feature flag remains; demo mode uses the environment boundary. |
| Empty lawyer-rating claim | No active lawyer-rating route, table use, ranking boost, or UI claim remains in maintained source. |

## Failures found during verification

One product defect was found and fixed before this report: the initial
Linux-built Windows package included a valid Windows SQLite binding but omitted
the Windows `@napi-rs/canvas` binary needed to rasterize scanned PDFs for OCR.
Commit `6011f45` adds a pinned Windows-native staging step to portable and Store
builds, runs it in Windows CI, and makes packaged-native verification fail
unless both bindings are x64 PE. The final artifact above contains both.

The first Playwright launcher attempt requested a Chromium revision absent from
this host. This was an environment launcher failure before the app opened, not
a product failure. Re-running through the installed stable Chrome channel
passed all 27 scenarios and produced the inspected screenshots.

No unresolved repository failure remains in the verified #178 scope. The
remaining items below require external state rather than another local code
claim.

## Explicit external boundaries

- No branch, commit, image, or installer was pushed or published in this pass.
- No pull request was merged, no GitHub CI run was created, and no issue was
  closed.
- The portable EXE was structurally validated from Linux; a native Windows
  launch still requires a Windows runner or owner machine.
- The Docker image is local and has no registry digest.
- Hetzner, DNS, TLS, public routing, production persistence, browser acceptance,
  and desktop-to-production acceptance were not changed or re-verified.
- Live Google, mail, S3, and optional AI credentials were not exercised in this
  pass. Missing optional providers remain fail-closed.
