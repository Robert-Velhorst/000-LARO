# Codex Checkpoints — 000-LARO

Resumable checkpoints for context-loss safety (Phase 088). Each checkpoint states
where work stopped and what the next safe action is, so work can resume without
re-deriving state.

---

## Checkpoint 1 — 2026-07-06 — Foundation phases 000–004 complete

**Branch / commit:** `staging` @ `1b78ed6` (working tree modified, not committed)

**Done:**
- Full repository + PDF audit → `docs/phase-audit.md` (completion matrix for all 116 phases).
- Phase 000: repo cleanup (removed 5 junk/harmful files), integrity recorded.
- Phase 001: `docs/DEPENDENCY_AUDIT.md` (10 dead deps identified from import graph).
- Phase 002: `docs/PRODUCT_DEFINITION.md` (honest capability contract).
- Phase 003: `docs/CRITICAL_PATH.md` + runnable smoke test + `vitest.config.ts`. Verified: 7 pass / 9 todo.
- Phase 004: `docs/ARCHITECTURE.md` + corrected `PROJECT_INFO.md`.

**Verified by:**
- `npx vitest run tests/smoke` → 7 passed, 9 todo, 0 failed.
- `git ls-files` → no secrets/DB/uploads committed.

**Next safe action (Stage A — safety/honesty, do before feature work):**
1. Phase 006 — startup config guards: make `JWT_SECRET`/`COOKIE_SECRET` required in production, fail-fast; stop bundling `.env` into the artifact.
2. Phase 007 — remove the `local-default`/`local-dev-token` bearer backdoor in `server/context.ts:29-52`.
3. Phase 008 — replace `demo-user-123` fallbacks and add `userId` filters to the IDOR endpoints (`outreach.byCaseId`, `gapAnalysis.get*`, `cases.*progress`).

**Do NOT:** commit until owner approves; do not begin feature phases (011/025/026) before Stage A closes the auth/secrets holes — that ordering is deliberate (see `docs/phase-audit.md` §8).

---

## Checkpoint 2 — 2026-07-06 — Phases 005–010 complete

**Branch / commit:** `staging` @ `1b78ed6` (working tree modified)

**Done (real code + tests):**
- Phase 005: DB pragmas (WAL/foreign_keys/busy_timeout), unique email, hot indexes (`server/db.ts`).
- Phase 006: fail-fast `assertSecurityConfig()` + per-install secret bootstrap (`env.ts`, `src-main/index.ts`).
- Phase 007: removed production bearer backdoor → per-install `LOCAL_AGENT_TOKEN`; 30-day sessions. **Partial** (residuals in `docs/SECURITY.md` §5).
- Phase 008: `assertCaseOwnership` guard; IDOR endpoints protected; `demo-user-123` removed.
- Phase 009: tRPC error envelope; removed dead `error-handler.ts`.
- Phase 010: `docs/FRONTEND_ARCHITECTURE.md`; demo-mode no longer leaks data. **Partial**.

**Verified:** `tsc -p tsconfig.server.json` clean; `tsc -p tsconfig.main.json` clean; `npx vitest run tests/smoke` → 24 pass / 9 todo.

**Process caution:** do NOT run `git stash` mid-task — a stash during a long typecheck once reverted the working tree; recovered via `git stash pop`. Avoid.

**Next safe action:** Phase 029/030/100 security follow-ups (stop bundling `.env`; AES-GCM token crypto; helmet/CSRF), then Stage B features — Phase 011 (wire real matching), 025 (classification), 026 (approval gate).

---

## Checkpoint 3 — 2026-07-06 — Phases 011–015

**Branch:** `Phase-Imp` (not pushed — owner pushes next)

**Done (real code + tests):**
- 011: real matching engine wired into `matching` router (Partial — needs classification 025).
- 012: honest provider connectors (`enhancedConnections.ts`) + `docs/PROVIDERS.md`.
- 013: `LEGAL_DISCLAIMER` on generated legal docs + `docs/COMPLIANCE.md` (Partial).
- 014: removed fake OCR / dashboard stats / mocked outreachProgress → honest.
- 015: `storage.ts` sanitize + real local fallback + sha256 (Partial — wire hash everywhere; export 023).

**Verified:** server + main `tsc` clean; `npx vitest run tests/smoke` → 43 pass / 9 todo.

**Next safe action:** Phase 025 (classification) so matching has legal areas to work with; then 026 (approval gate) before any real outreach send; then 016–019 (jobs/idempotency/rate-limits/audit) on the outreach path.

---

## Checkpoint 4 — 2026-07-06 — Phases 016–020

**Branch:** `Phase-Imp` (not pushed — owner pushes next)

**Done:**
- 016: cron `runJob()` retry+status; honest outreach heartbeat; `health.readiness`. **Implemented**.
- 017: unique outreach index + idempotent initiateOutreach. **Partial** (send-path keys → 026).
- 018: `enforceRateLimit` on login/case-create/matching/outreach. **Implemented**.
- 019: audit filtering + `audit.list` read + wired into CRUD/login/outreach. **Implemented**.
- 020: `dashboard.nextActions` from real case state. **Partial** (UI surface → 037/109).

**Verified:** server + main `tsc` clean; `vitest tests/smoke` → 53 pass / 9 todo.

**Next safe action:** Phase 021–024 (forms/validation/autosave, search/filters, import/export, templates) or jump to the Stage-B remainder (025 classification → 026 approval gate) to unblock the real outreach path that 016–019 are waiting on.

---

## Checkpoint 5 — 2026-07-06 — Phases 021–030

**Branch:** `Phase-Imp` (not pushed).

**Done (real code + tests):**
- 021 validation schemas + case-draft autosave; 022 list filters/sort; 023 case export JSON+CSV;
  024 message-template CRUD; 025 **deterministic classifier** (unblocks matching); 026 **approval gate**
  (drafts → approve/reject, no send); 027 real notifications; 028 **real GDPR export+erasure**;
  029 security headers; 030 removed .env from installer + .env.example.

**Verified:** server + main `tsc` clean; `npx vitest run tests/smoke` → 72 pass / 9 todo.

**Key unblock:** case creation now auto-classifies legal areas, so Phase 011 matching produces
real results; the approval gate is ready to gate a real send.

**Next safe action:** implement the real outreach **send** through a configured provider behind the
approval gate (the one remaining critical-path gap), then 031–039 (dev/deploy/observability) and
040–044 (make the full test suite runnable).

---

## Checkpoint 6 — 2026-07-06 — Phases 031–040

**Branch:** `Phase-Imp` (not pushed).

**Done (all Implemented):** 031 setup script; 032 Dockerfile/compose (server backend);
033 db-backup + restore; 034 doctor CLI; 035 /api/live+/ready+/health; 036 admin diagnostics;
037 demo-mode labelling (system.appInfo); 038 fake-provider lab (prod-guarded); 039 test factories;
040 **real DB-backed backend test suite**.

**Key wins:** rebuilt better-sqlite3 for Node so the backend suite runs here; it exercises
classification → real matching → ownership → GDPR export/erasure end to end, and **caught a real
bug** (SQL `LIKE '__%'` wildcard excluded every table, breaking GDPR delete + cases.delete cascade) —
fixed in gdpr.ts, admin.ts, cases.ts.

**Verified:** server+main tsc clean; `npx vitest run` → 9 files, 76 passed, 9 todo; doctor/setup/db-backup run.

**Next safe action:** Phase 041 (repair the legacy tests/*.test.ts and add frontend/component tests),
then the real outreach **send** behind the approval gate — the last critical-path gap.

---

## Checkpoint 7 — 2026-07-06 — Phases 041–050

**Branch:** `Phase-Imp` (not pushed).

**Done:** real test harness (`tests/helpers/app.ts` — `createCaller` over the actual API).
- 042 worker tests, 043 e2e workflow, 044 acceptance matrix, 045 adversarial, 046 isolation,
  047 file-safety, 048 provider-failure — all **Implemented** (real tests).
- 041 frontend-logic tests + 049 a11y + 050 responsive — **Partial** (jsdom/component render,
  per-screen axe audit, visual-regression pending; documented).

**Verified:** server+main tsc clean; `npx vitest run` → 18 files, 117 passed, 9 todo, 0 failed.

**Next safe action:** the real outreach **send** behind the approval gate (last critical-path gap),
then 051–054 (perf/indexing, large-dataset pagination, backup/restore, reconciliation) and jsdom
component tests (041 follow-up).

---

## Checkpoint 8 — 2026-07-06 — Phases 051–060

**Branch:** `Phase-Imp` (not pushed).

**Done (real code + tests):** 051 indexes, 052 pagination test, 053 backup/restore
(+CLI), 054 reconciliation, 055 local-first analytics, 056 billing status (free tier),
057 i18n foundation (Partial), 058 feature flags (outreach.send.enabled default OFF),
059 formal state machines (enforced in cases.update + approval gate), 060 domain model spec.

**Verified:** server+main tsc clean; `npx vitest run` → 21 files, 138 passed, 9 todo.

**Next safe action:** the real outreach **send** — now state-machine-ready
(Approved→Sent) and feature-flag-gated (outreach.send.enabled). Then 061+
(invariants/constraints, pre-action safety screen, provider credential checklist).

---

## Checkpoint 9 — 2026-07-06 — Phases 061–070

**Branch:** `Phase-Imp`.

**Done:** 061 invariants (`admin.invariants`), 062 pre-send safety review
(`workflow.preSendReview`, never sends), 063 provider checklist, 064 threat model,
065 DPIA, 066 supply-chain (npm audit: 2 critical/22 high — Partial), 067 licenses
(Partial — no top-level LICENSE), 068 CI quality gates (tsc+vitest blocking),
069 release/canary/rollback, 070 expanded operator runbook.

**Verified:** server+main tsc clean; `npx vitest run` → 22 files, 143 passed, 9 todo.

**Next safe action:** the real outreach **send** (scaffolded + gated), then 071–075
(user guide, troubleshooting, UI/endpoint/doc audits) and triage the npm-audit
advisories (066) + add a top-level LICENSE (067).

---

## Checkpoint 10 — 2026-07-06 — Phases 071–080

**Branch:** `Phase-Imp`.

**Done:** 071 in-app help (`server/help.ts`, `help.topics/topic`) + USER_GUIDE;
072 error catalog (`server/errorCatalog.ts`, `help.errorCatalog`) + TROUBLESHOOTING;
073 UI-action audit (found **14 renderer routers with no backend** = broken UI
actions; + billing/agent method gaps); 074 endpoint-usage audit (46 routers /
187 procedures; called-but-missing / mounted-but-unused / honest empty stubs);
075 doc-truthfulness audit (no overstatement); 076 tech-debt register (14 ranked);
077 bug-hunt log (7 real bugs); 078–080 three red-team loops.

**Real bugs fixed this batch (not just documented):**
- **078 (High/privacy):** GDPR erasure left caseId-scoped child rows (outreach,
  gaps, patterns…) orphaned. `deleteUserData` now purges them for the user's cases
  first. Proven by test (outreach rows gone after erasure).
- **079 (Low/disclosure):** `system.providerChecklist` was public → now
  `protectedProcedure`. Test asserts UNAUTHORIZED for anon.

**Verified:** server tsc clean; `npx vitest run tests/backend/phase071_080.test.ts`
→ 4/4 passed. (080 residuals — token crypto D4, CSRF/CORS D5, npm-audit D7 —
tracked in TECH_DEBT, not fixed here.)

**Next safe action:** remediate D1 (hide/implement the 14 dead-router UI screens)
and the real outreach **send** (still scaffolded + flag-gated), then 081+.

---

## Checkpoint 11 — 2026-07-06 — Phases 081–090

**Branch:** `Phase-Imp`.

**Done (real code + grounded reviews):**
- **081** `tests/sim/nonTechnicalUser.test.ts` (7/7) — first-time user completes the
  whole journey using only in-app help; safety boundary + export/erase verified;
  an unbuilt action (OCR) rejects with NOT_IMPLEMENTED (no fake success).
- **085** `scripts/traceability.mjs` — runnable generator that parses the matrix,
  verifies every cited artifact exists (0 broken across 91 rows), writes
  `docs/TRACEABILITY.md`; fixed a multi-dot path-regex false-positive.
- **089** `scripts/stabilization-gate.mjs` + `npm run gate/verify` — fail-fast
  server-tsc → main-tsc → traceability → tests; renderer tsc reported as
  non-blocking debt (surfaces the D1 dead routers).
- **082/083/084/086/088** grounded reviews: `AUTONOMY_REVIEW`, `VALUE_REVIEW`,
  `PRODUCT_REALISM`, `TASK_GRAPH`, `RESUME_SAFETY`.
- **087/090** `PROCESS_RULES.md` — worklog/checkpoints confirmed; no-vanity rule.

**Verified:** `npm run gate` → all blocking gates green; `npx vitest run` → 24
files, 154 passed, 9 todo. Server+main tsc clean; traceability 0 broken.

**Next safe action:** 091+ (feature-level DoD, fresh-clone dry run, manual
verification evidence). Highest-leverage product work remains D1 (hide/implement
the 14 dead-router UI screens) and D3 (real outreach send, still flag-gated).

---

## Checkpoint 12 — 2026-07-06 — Phases 091–100

**Branch:** `Phase-Imp`.

**Done (real code + grounded verification):**
- **094** `scripts/no-excuses-scan.mjs` (in gate + `npm run scan:no-excuses`) —
  splits actionable (TODO/FIXME) from review markers; **0 actionable in runtime**;
  triaged review hits as honest; `docs/NO_EXCUSES_SEARCH.md`.
- **100** `scripts/account-safety-check.mjs` (in gate + `npm run scan:safety`) —
  **0 HIGH**: `.env` untracked/gitignored/unbundled, no hardcoded secrets;
  `docs/ACCOUNT_SAFETY.md` + operator cleanup checklist.
- **092** real fresh clone performed — source complete, no secret leak, server tsc
  + suites green from clean checkout; `docs/FRESH_CLONE.md` (honestly notes the
  symlinked-deps `main` tsc TS2742 artifact that does not occur with real `npm ci`).
- **093** `docs/MANUAL_VERIFICATION.md` — captured real gate/test/scan outputs +
  what was NOT manually verified (UI click-testing, send path).
- **091** DoD, **095** matrix (maintained), **096** final verification report,
  **097** final-response rules, **098** maintenance plan, **099** roadmap (101–115).

**Verified:** `npm run gate` → 6 blocking gates green (server+main tsc, traceability
0/101, no-excuses 0 actionable, account-safety 0 HIGH, vitest 24 files/154 passed).

**Next safe action:** phases 101–115 (see docs/ROADMAP.md). Product blockers before
any "autonomous outreach" claim: D1 (dead UI routers) and D3 (real send).

---

## Checkpoint 13 — 2026-07-06 — Phases 101–115 (program complete through 115)

**Branch:** `Phase-Imp`.

**Done — real backend features (all tested, `tests/backend/phase101_115.test.ts` 11/11):**
- **104 Emergency stop** `server/systemState.ts` + `admin.setEmergencyStop`; wired
  into `workflow.prepareDrafts/approveDraft` — outreach halts under stop, admin-gated.
- **102 Retention** `server/retention.ts` + `admin.retentionPreview/Run` — purges
  audit logs > window, never business data.
- **110 Safe retries** `server/retry.ts` `retryWithBackoff`; live job runner delegates.
- **105 Onboarding** `server/onboarding.ts` + `onboarding.*` (per-user completion).
- **106 Roles** `server/_core/roles.ts` + `system.capabilities` (Partial: no teams).
- **101 Debug bundle** `admin.debugBundle` (redacted, no secrets).
- **109 Exceptions** `dashboard.exceptions` (only cases needing attention).
- **111 Clarifications** real compute+resolve (was empty stub).
- **107 Confidence** `server/confidence.ts` from real score (no hardcoded constant).

**Scripts:** `prod-preflight` (103), `regression-baseline` (113, 25 files),
`operator-readiness` (115), `CHANGELOG.md` + version 1.1.0 (112). Docs: 102/103/108/
114/115.

**Verified:** `npm run gate` → 6 blocking gates green; traceability 116 rows / 0
broken; vitest **25 files, 165 passed, 9 todo**; all readiness scripts green.

**Honest residuals (unchanged, tracked):** D3 outreach send unbuilt/flag-gated,
D1 renderer dead routers, D4 token crypto, multi-user teams (106). The product is
operator-ready for triage/match/prepare with real safety controls, NOT end-to-end
autonomous send.

---

## Checkpoint 14 — 2026-07-06 — Closing Partials with real code

**Branch:** `Phase-Imp`. Converted 7 Partial phases to Implemented with real, tested code.

**Done:**
- **007/030/D4** authenticated AES-256-GCM token crypto (`server/crypto.ts`),
  rewired `emailOAuth`; legacy CBC still decrypts.
- **007** JWT revocation (`server/sessionRevocation.ts` + `auth.logoutAllDevices`,
  checked in `context.ts`).
- **080/D5** CSRF origin guard + strict CORS (`server/_core/csrf.ts`), wired in `index.ts`.
- **015** evidence content hash persisted (`createEvidenceFile` → metadata sha256).
- **023** real ZIP export (`server/evidenceExport.ts` + `cases.exportZip`, archiver).
- **027** reminder sweep (`server/reminders.ts` + `notifications.runReminders` + daily cron).
- **067** top-level `LICENSE`.

**Verified:** `npm run gate` 6/6 green; vitest **26 files / 175 passed / 9 todo**;
`tests/backend/partials_hardening.test.ts` 10/10. Tech-debt D4/D5/D11 marked RESOLVED.

**Matrix now: 102 Implemented / 14 Partial / 0 Missing.** Remaining 14 Partials are
renderer/UI (D1/D2), real outreach send (D3), and external/teams — honestly named,
not faked.

**Next safe action:** the renderer pass (D1/D2) or the real send loop (D3) — both
are large, product-level efforts.

---

## Checkpoint 15 — 2026-07-06 — Closing renderer-independent Partials

**Branch:** `Phase-Imp`. Partials 14 → 7 (all remaining are renderer/UI).

**Done (real, tested):**
- **010/D1** — implemented the 14 missing routers (`server/routers/extendedRouters.ts`),
  typed + mounted; every previously-dead UI action now hits a real endpoint.
- **011/026/017** — real gated outreach send (`server/outreachSend.ts` +
  `workflow.sendApproved`): emergency-stop + flag(OFF) + Approved + ownership +
  idempotency; honest failure with no provider. `tests/backend/realSend.test.ts` 3/3.
- **106** — multi-user teams (`server/teams.ts` + `teams` router); shared case access
  in `assertCaseOwnership`; stranger still blocked. `tests/backend/teams.test.ts` 3/3
  + isolation 5/5.
- **066** — supply-chain advisories triaged by runtime exposure (`docs/SUPPLY_CHAIN.md`).
- **020/115** — dashboard exceptions + end-to-end send now real.

**Verified:** `npm run gate` 6/6 green; vitest **28 files / 181 passed / 9 todo**;
traceability 0 broken. Tech-debt D1 RESOLVED.

**Remaining 7 Partials (honest):** 010 renderer tsc (~500 errors), 013 disclaimer UI,
021 autosave UI, 041 component tests (jsdom), 049 a11y audit, 050 responsive, 057
i18n string migration — a dedicated frontend pass. Backend for all is done.

---

## Checkpoint 16 - 2026-08-08 - Giant-goal completion audit

**Branch:** `agent/giant-goal-completion` · **Start:** `b5ae607`

**Done:** source PDF phases 000-115 reconciled against current main; required
current technical audit added; phase 057 moved from a dormant catalog to a
persisted and reachable NL/EN renderer capability; all 117 matrix rows now cite
existing artifacts; traceability fails closed on uncited implementation claims;
new `nanoid` and `js-yaml` advisories were cleared with patched lockfile releases.

**Verified at checkpoint:** i18n unit suite 7/7, renderer typecheck without
diagnostics, traceability 117 cited / 0 broken / 0 uncited.

**Next safe action:** full release gate, browser route and locale acceptance,
fresh database/runtime smoke, production health, and live-provider acceptance
state review. Never convert an external consent gate into a code-completion claim.

---

## Checkpoint 17 - 2026-08-09 - HAI connector and release candidate

**Done:** owner-scoped HAI token lifecycle and minimized cursor feed; native HAI
adapter; Settings credential controls; transient-auth reconnect state; eighth
migration and query indexes; current audit and verification evidence.

**Verified:** LARO HAI tests 3/3, HAI source package tests, all typechecks and
lint, repository gates before the full-test stage, 222 Python tests, all Vitest
files exercised with the two host-timeout suites passing in isolation,
Playwright 4/4, production build, portable Windows packaging, and Electron
SQLite ABI verification.

**Next safe action:** protected pull requests and CI, merge to `main`, rebuild
the retained API data volume, verify the ngrok route, and complete one explicit
HAI synchronization. Google consent and approved outbound delivery remain
owner/provider acceptance gates.
