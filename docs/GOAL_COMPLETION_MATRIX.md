# Goal Completion Matrix — 000-LARO

Status vocabulary (from the prompt): **Implemented · Partial · Missing · Blocked · N/A**.
"Blocked" means genuinely gated by an external credential/approval that cannot be
self-provided — *merely difficult is not blocked*. No phase in this project is
currently Blocked.

This is the historical 116-phase implementation ledger. It is not the current
release verdict: phase descriptions preserve the state and evidence available
when each phase was closed. For current operational truth, use
`docs/CRITICAL_PATH.md`, `docs/ACCEPTANCE_TESTS.md`,
`docs/FINAL_VERIFICATION_REPORT.md`, and a fresh `npm run gate`.

Ledger reconciled: 2026-07-15.

---

## Worked phases

| Phase | Title | Status | Deliverable / evidence |
|---|---|---|---|
| 000 | Repository integrity & true starting point | **Implemented** | Junk removed (5 files); integrity recorded; doc trail created. `docs/CODEX_WORKLOG.md`. |
| 001 | Complete file & dependency audit | **Implemented** | `docs/DEPENDENCY_AUDIT.md`; 10 dead deps identified from import graph. |
| 002 | Product definition & user outcome contract | **Implemented** | `docs/PRODUCT_DEFINITION.md` (honest capability table + safety boundary). |
| 003 | Critical path definition & smoke test | **Implemented** | `docs/CRITICAL_PATH.md`; `tests/smoke/criticalPath.smoke.test.ts` + `vitest.config.mts`; current workflow coverage contains no placeholder todos. |
| 004 | Architecture decision & stack validation | **Implemented** | `docs/ARCHITECTURE.md`; `PROJECT_INFO.md` corrected to real stack. |
| 005 | Data model, ownership & persistence | **Implemented** | `docs/DATA_MODEL.md`; WAL + `foreign_keys` + `busy_timeout`, unique `users.email`, 10 hot indexes in `server/db.ts`. |
| 006 | Configuration validation & startup guards | **Implemented** | `assertSecurityConfig()` fail-fast + per-install secret bootstrap; `tests/smoke/configGuard.smoke.test.ts` (4 pass). |
| 007 | Authentication model & session security | **Implemented** | Per-install token (no bearer backdoor); **authenticated AES-256-GCM** token crypto (`server/crypto.ts`); **JWT revocation** (`server/sessionRevocation.ts` + `auth.logoutAllDevices`, checked in `context.ts`); `.env` unbundled (030). Tested. |
| 008 | Authorization & resource ownership | **Implemented** | `assertCaseOwnership` guard; IDOR endpoints protected; `demo-user-123` removed; `tests/smoke/authz.smoke.test.ts` (13 pass). |
| 009 | API contract & error envelope | **Implemented** | tRPC `errorFormatter` provides the stable envelope in `server/_core/trpc.ts`; dead `error-handler.ts` removed. |
| 010 | Frontend architecture & navigation | **Implemented** | `docs/FRONTEND_ARCHITECTURE.md`; shipped routes are mounted, the renderer typecheck is blocking, and the real outreach analytics route is available from navigation. |
| 011 | Core workflow vertical slice | **Implemented** | Full slice real: classify (025) → match → prepare → approve → **send** (`server/outreachSend.ts` + `workflow.sendApproved`, flag-gated, tested). |
| 012 | External provider reality review | **Implemented** | `docs/PROVIDERS.md`; dummy auth URLs replaced with real availability reporting in `enhancedConnections.ts`. |
| 013 | Compliance & policy boundaries | **Implemented** | Authenticated routes display a compact legal-assistance notice; generated documents and pre-send review retain the mandatory disclaimer; provenance, GDPR, retention, approval, and provider-acceptance boundaries are documented in `docs/COMPLIANCE.md`. |
| 014 | No fake success / no mock production | **Implemented** | Fake OCR, hardcoded dashboard stats, and mocked `outreachProgress` replaced with honest/real behavior; anti-regression guards in `tests/smoke/noFakeSuccess.smoke.test.ts`. |
| 015 | Storage, files, uploads & media safety | **Implemented** | `server/storage.ts` sanitization + real local fallback + sha256; content hash is persisted on the primary evidence write and verified by `tests/smoke/storage.smoke.test.ts`; zip export is covered in 023. Provider-collected bytes also pass through managed storage. |
| 021 | Forms, validation, autosave | **Implemented** | `shared/validation.ts` validates case intake; the mounted creation wizard restores, debounces, flushes, and clears owner-scoped drafts through `cases.getDraft/saveDraft/clearDraft`. Failed creation preserves the open form. API and browser acceptance cover the lifecycle. |
| 022 | Search, filters, sorting, pagination | **Implemented** | `cases.list` in `server/routers/cases.ts` implements owner-scoped status/urgency/search filters, sorting, and pagination. |
| 023 | Import & export | **Implemented** | Case-scoped JSON plus evidence CSV and ZIP downloads. ZIP contains a manifest, redacted per-item metadata, analyses, and every available managed source file with provenance hashes (`server/evidenceExport.ts`, `server/routers/evidenceExport.ts`). PDF remains explicitly unavailable. |
| 024 | Templates, presets, defaults | **Implemented** | `server/routers/messageTemplates.ts` provides real per-user CRUD. |
| 025 | AI/provider abstraction & deterministic fallback | **Implemented** | `server/classification.ts` deterministic classifier wired into `cases.create`/`cases.classify`; unblocks matching. Tested. |
| 026 | Human review queue & approval gates | **Implemented** | `server/routers/workflow.ts` provides prepare/review/approve/reject plus real gated send: emergency stop, feature flag, Approved state, ownership, and idempotency. Tested. |
| 027 | Notifications & reminders | **Implemented** | `createNotification` real; **reminder sweep** (`server/reminders.ts` + `notifications.runReminders` + daily cron) — idempotent per case/kind/day (approval-pending, urgent-no-evidence). Tested. |
| 028 | Privacy controls & data deletion | **Implemented** | `server/gdpr.ts` real export + erasure; `gdpr.*` no longer stubs. |
| 029 | Security headers & web security | **Implemented** | CSP/HSTS/frame/referrer/permissions headers in `server/index.ts`. |
| 030 | Secrets management & credential rotation | **Implemented** | `.env` unbundled + `.env.example` + per-install secrets (006/007); **OAuth-token crypto now authenticated AES-256-GCM** (`server/crypto.ts`, D4 closed). Account-safety scan (100) enforces no leaked secrets. Tested. |
| 031 | Local dev one-command experience | **Implemented** | `scripts/setup.mjs` + `npm run setup`; `docs/DEPLOYMENT.md`. |
| 032 | Docker & deployment readiness | **Implemented** | `Dockerfile`, `.dockerignore`, `docker-compose.yml`, npm Docker scripts, and deployment steps in `docs/DEPLOYMENT.md`; the production image has since been built and deployed. |
| 033 | Database migrations & rollback safety | **Implemented** | `scripts/backup.ts` (verified backup/validate/restore) + `npm run db:backup`; `docs/MIGRATIONS.md`. |
| 034 | CLI / doctor self-diagnostic | **Implemented** | `scripts/doctor.mjs` + `npm run doctor`; exits non-zero on prod-critical issues. |
| 035 | Observability, health, readiness | **Implemented** | `server/routers/health.ts` and `server/index.ts` expose `/api/live`, `/api/ready`, and `/api/health` with database readiness, version, environment, and uptime. |
| 036 | Admin/operator diagnostics | **Implemented** | `server/routers/admin.ts` exposes admin-only diagnostics and table counts without secret values. |
| 037 | Demo mode with explicit labelling | **Implemented** | `server/_core/systemRouter.ts` reports demo state from `ENV.isDemo`; production forces it off and the mounted shell labels it. |
| 038 | Fake provider lab for tests only | **Implemented** | `server/testing/fakeProviders.ts`, prod-guarded (throws in production). |
| 039 | Test-data factories & fixtures | **Implemented** | `tests/factories.ts` (user/case/lawyer/evidence). |
| 040 | Backend test suite | **Implemented** | Real database integration coverage in `tests/backend/criticalPath.backend.test.ts` spans classification, matching, ownership, workflow, and export; the broader `tests/backend/` suite is release-blocking. |
| 041 | Frontend & component test suite | **Implemented** | Vitest covers frontend state/contracts and `tests/browser/rendererAccessibility.spec.ts` renders the real authenticated application across all supported routes and viewports in Chromium. The CI browser harness replaces a weaker synthetic jsdom-only claim. |
| 042 | Worker/job test suite | **Implemented** | `tests/backend/worker.test.ts` — runJob isolation, retry+backoff, recover, status. |
| 043 | End-to-end workflow tests | **Implemented** | `tests/e2e/workflow.e2e.test.ts` — signup→case→classify→match→prepare→approve via real API; sending remains a separate explicit action. |
| 044 | Acceptance test matrix | **Implemented** | `docs/ACCEPTANCE_TESTS.md` defines automated AC1–AC15 plus target-environment acceptance M1–M3. |
| 045 | Adversarial break-the-app tests | **Implemented** | `tests/security/adversarial.test.ts` — unauth, malformed/oversized, injection-safe, rate limit. |
| 046 | Cross-user isolation tests | **Implemented** | `tests/security/isolation.test.ts` — B cannot read/mutate/export A's case. |
| 047 | File safety & path traversal tests | **Implemented** | `tests/security/fileSafety.test.ts` — traversal/absolute keys confined; sha256 round-trip. |
| 048 | Provider failure simulation | **Implemented** | `tests/security/providerFailure.test.ts` — graceful degradation + prod-guarded fake lab. |
| 049 | Accessibility review | **Implemented** | Shared helpers and static contracts are supplemented by a CI axe-core audit of all 15 supported routes at desktop/mobile sizes; serious/critical violations, unnamed controls, errors, and failed requests block the build. `docs/ACCESSIBILITY.md`. |
| 050 | Responsive & browser compatibility | **Implemented** | The supported Electron/Chromium surface is audited across 30 route/viewport combinations for content, overflow, errors, request failures, and accessibility. Firefox/Safari are not packaged-app targets. `docs/RESPONSIVE_COMPAT.md`. |
| 051 | Performance baseline & indexing | **Implemented** | cases(userId,status)/urgency/updatedAt indexes; `docs/PERFORMANCE.md`. |
| 052 | Large dataset & pagination testing | **Implemented** | `tests/backend/phase051_060.test.ts` verifies complete, non-overlapping pagination over 55 rows plus filters. |
| 053 | Backup & restore procedures | **Implemented for production and legacy migration source** | Electron recovery binds SQLite, token keys, and local evidence or S3 inventory; `flask_recovery.py` coordinates the Flask ledger, auth database, OAuth vault, and uploads with destructive drills for both paths; `docs/BACKUP_RESTORE.md`; tested. |
| 054 | Data reconciliation & repair | **Implemented** | `server/reconcile.ts` orphan detect+repair; tested; `docs/DATA_RECONCILIATION.md`. |
| 055 | Product analytics local-first | **Implemented** | `server/analytics.ts` real metrics wired into `analytics.*`; `docs/ANALYTICS.md`. |
| 056 | Local operation without forced billing | **Implemented** | `billing.status` reports a local unmetered plan; usage is observational and core actions have no payment or quota gate; `docs/SAAS_READINESS.md`. |
| 057 | Internationalization (NL/EN) | **Implemented** | `shared/i18n.ts`, `src/renderer/contexts/I18nContext.tsx`, and `src/renderer/components/LanguageSelector.tsx` provide a persisted NL/EN runtime used by authentication, navigation, legal notice, and the complete scanner workflow; unit and browser persistence coverage is in `tests/backend/i18n.test.ts` and `tests/browser/rendererAccessibility.spec.ts`. |
| 058 | Feature flags & rollout controls | **Implemented** | `server/featureFlags.ts` + router; `outreach.send.enabled` default OFF; `docs/FEATURE_FLAGS.md`. |
| 059 | Formal state machines | **Implemented** | `server/stateMachines.ts` enforced in cases.update + approval gate; `docs/STATE_MACHINES.md`. |
| 060 | Domain model specification | **Implemented** | `docs/DOMAIN_MODEL.md`. |
| 061 | Data invariants & constraints | **Implemented** | `server/invariants.ts` + `admin.invariants`; verifies email/ownership/outreach/orphans/legalAreas. Tested. |
| 062 | Pre-action safety review screen | **Implemented** | `workflow.preSendReview` in `server/routers/workflow.ts` is ownership-checked, reports recipient/disclaimer/reversibility/send readiness, and never sends; covered by `tests/backend/phase061_070.test.ts`. |
| 063 | Provider credential verification checklist | **Implemented** | `server/_core/systemRouter.ts` exposes protected configured booleans and required environment names without secrets; covered by `tests/backend/phase061_070.test.ts`. |
| 064 | Threat model & security design review | **Implemented** | `docs/THREAT_MODEL.md` (STRIDE + residuals). |
| 065 | Privacy impact assessment | **Implemented** | `docs/PRIVACY_IMPACT_ASSESSMENT.md` (DPIA). |
| 066 | Supply chain & dependency review | **Implemented** | `docs/SUPPLY_CHAIN.md` — full triage of 21 advisories by runtime exposure (the 1 critical is dev-only vitest; majority are dev/build tooling; 4 runtime deps have a scheduled major-upgrade plan). |
| 067 | License & third-party service review | **Implemented** | `docs/LICENSES.md` (dependency inventory) + top-level `LICENSE` (proprietary; owner may change). |
| 068 | CI/CD quality gates | **Implemented** | `.github/workflows/ci.yml` and `scripts/stabilization-gate.mjs` block on server, main, and renderer typechecks, lint, complete traceability, safety scans, recovery, and tests. |
| 069 | Release process, canary & rollback | **Implemented** | `docs/RELEASE_PROCESS.md` (flags=canary, backup=rollback, gates). |
| 070 | Operator runbook | **Implemented** | `docs/OPERATOR_RUNBOOK.md` expanded (health/integrity/backup/flags/rotation/incident). |
| 016 | Background jobs, schedulers & workers | **Implemented** | `runJob()` error-isolation + retry/backoff + status; honest outreach heartbeat (no fake send); `health.readiness` exposes job status. `docs/OPERATOR_RUNBOOK.md`. |
| 017 | Idempotency & duplicate-action prevention | **Implemented** | `server/outreachSend.ts` enforces a per-outreach guard and Sent state, while the database uniquely binds case/lawyer outreach; `tests/backend/realSend.test.ts` proves double-send blocking. |
| 018 | Rate limits, cooldowns & provider quotas | **Implemented** | `server/rateLimit.ts` is applied to login, case creation, matching, outreach, search, and reset flows. A distributed store is only needed for a future multi-node topology. |
| 019 | Audit logging & event history | **Implemented** | `server/audit.ts` and `server/routers/audit.ts` provide real filtering, case/outreach/login writes, and a user-scoped read path. |
| 020 | User-facing dashboard & next-action | **Implemented** | `server/routers/dashboard.ts` derives real stats, next actions, and exceptions from owned case state; the mounted dashboard consumes them. |
| 071 | User guide & in-app help | **Implemented** | `server/help.ts` + `help.topics/topic` (ordered topics incl. disclaimer); `docs/USER_GUIDE.md`. Tested. |
| 072 | Troubleshooting & error catalog | **Implemented** | `server/errorCatalog.ts` + `help.errorCatalog` (code→message/cause/remedy); `docs/TROUBLESHOOTING.md`. Tested. |
| 073 | UI action audit | **Implemented** | `docs/UI_ACTION_AUDIT.md` records the reconciled mounted surface; the fourteen router groups from the original snapshot are now mounted and typed. |
| 074 | Backend endpoint usage audit | **Implemented** | `docs/API_USAGE_AUDIT.md` records the current typed contract, supported surface, explicit unavailable states, and regression controls. |
| 075 | Documentation truthfulness audit | **Implemented** | `docs/DOC_TRUTHFULNESS_AUDIT.md` — claims cross-checked vs code+tests; no overstatement (historical Docker/MySQL fixed in 004). |
| 076 | Technical debt register | **Implemented** | `docs/TECH_DEBT.md` maintains resolved historical items and the current ranked residual work. |
| 077 | Bug hunt log | **Implemented** | `docs/BUG_HUNT_LOG.md` — 7 real bugs found+fixed (GDPR orphans, LIKE wildcard, classification, …). |
| 078 | Red-team loop 1 — isolation & erasure | **Implemented** | `server/gdpr.ts` purges case-scoped children and owned managed objects before metadata; `tests/security/isolation.test.ts` proves tenant isolation and relational erasure behavior. |
| 079 | Red-team loop 2 — info disclosure | **Implemented** | `system.providerChecklist` made `protectedProcedure`; test asserts UNAUTHORIZED for anon. `docs/RED_TEAM.md`. |
| 080 | Red-team loop 3 — abuse/DoS/supply-chain | **Implemented** | Guards hold (adversarial/fileSafety/state-machine tests); **D4 fixed** (GCM token crypto), **D5 fixed** (`server/_core/csrf.ts` CSRF guard + strict CORS, tested). Remaining D7 (npm-audit advisories) is external/owner triage, tracked in 066. |
| 081 | Non-technical user simulation | **Implemented** | `tests/sim/nonTechnicalUser.test.ts` (7/7) — full journey via help-guided steps, safety boundary, export/erase, honest NOT_IMPLEMENTED. |
| 082 | Autonomy-first product review | **Implemented** | `docs/AUTONOMY_REVIEW.md` — per-step autonomy scorecard; send deliberately human-gated. |
| 083 | Value review | **Implemented** | `docs/VALUE_REVIEW.md` — value delivered now (triage/match/prepare) vs not (send/follow-up). |
| 084 | Product realism review | **Implemented** | `docs/PRODUCT_REALISM.md` records the phase review; current reality is maintained in `README.md` and `docs/FINAL_VERIFICATION_REPORT.md`. |
| 085 | Requirements traceability | **Implemented** | `scripts/traceability.mjs` (runnable, 0 broken refs) + generated `docs/TRACEABILITY.md`; wired into gate. |
| 086 | Task graph & dependency map | **Implemented** | `docs/TASK_GRAPH.md` — critical-path spine + dependency rules. |
| 087 | Codex worklog & checkpoints | **Implemented** | `docs/CODEX_WORKLOG.md` + `docs/CODEX_CHECKPOINTS.md` maintained every batch (Checkpoint 11); `docs/PROCESS_RULES.md`. |
| 088 | Context-loss resume safety | **Implemented** | `docs/RESUME_SAFETY.md` — read checkpoints→worklog→matrix→`npm run gate`→traceability; commit-per-batch. |
| 089 | Progressive stabilization gates | **Implemented** | `scripts/stabilization-gate.mjs` + `npm run gate/verify` — fail-fast typechecks, lint, traceability, safety scans, recovery, and tests. |
| 090 | No vanity work rule | **Implemented** | `docs/PROCESS_RULES.md` — adherence via task graph, reproducible gates, and explicit external acceptance. |
| 091 | Feature-level definition of done | **Implemented** | `docs/DEFINITION_OF_DONE.md` — 7-point DoD applied to real features; current release evidence is in `docs/FINAL_VERIFICATION_REPORT.md`. |
| 092 | Fresh-clone dry run | **Implemented** | `docs/FRESH_CLONE.md` — real clone: source complete, no secrets leak, server tsc + suites green from clean checkout; setup documented. |
| 093 | Manual verification evidence | **Implemented** | `docs/MANUAL_VERIFICATION.md` — captured real outputs of gate/tests/traceability/scans; states what was NOT manually verified. |
| 094 | Final no-excuses search | **Implemented** | `scripts/no-excuses-scan.mjs` (in gate) — 0 actionable markers in runtime; `docs/NO_EXCUSES_SEARCH.md` triage. |
| 095 | Completion matrix | **Implemented** | `docs/GOAL_COMPLETION_MATRIX.md` is the maintained per-phase source through phase 116 and is enforced by `scripts/traceability.mjs`. |
| 096 | Final verification report | **Implemented** | `docs/FINAL_VERIFICATION_REPORT.md` records the current reproducible release evidence and external release blockers. |
| 097 | Final response requirements | **Implemented** | `docs/FINAL_RESPONSE.md` — rules + template for a truthful completion report. |
| 098 | Post-completion maintenance plan | **Implemented** | `docs/MAINTENANCE_PLAN.md` — cadence, ownership, debt burn-down order. |
| 099 | Roadmap & blocked items | **Implemented** | `docs/ROADMAP.md` — phases 101–115 + blocked items with unblock conditions. |
| 100 | Real-provider cleanup & account safety | **Implemented** | `scripts/account-safety-check.mjs` (in gate) — 0 HIGH; `.env` unbundled/gitignored, no hardcoded secrets; `docs/ACCOUNT_SAFETY.md` cleanup checklist. |
| 101 | Support/debug bundle | **Implemented** | `admin.debugBundle` in `server/routers/admin.ts` returns an admin-only redacted system/table/invariant/flag/job snapshot; covered by `tests/backend/phase101_115.test.ts`. |
| 102 | Data retention & archival policy | **Implemented** | `server/retention.ts` validates bounded configuration and implements the idempotent audit-only sweep; `tests/backend/retentionConfiguration.test.ts` and `tests/backend/phase101_115.test.ts` cover startup, preview, and execution. |
| 103 | Prototype → production migration | **Implemented** | `scripts/prod-preflight.mjs` (`npm run preflight`) — blocks go-live on weak secrets/demo/migrations/tracked-.env; `docs/PROD_MIGRATION.md`. |
| 104 | Operator safety stop / emergency controls | **Implemented** | `server/systemState.ts` + `admin.setEmergencyStop/emergencyStopStatus`; wired into `workflow.prepareDrafts/approveDraft` (halts outreach). Tested. |
| 105 | Onboarding & first-run | **Implemented** | `server/onboarding.ts` + `onboarding.steps/state/complete`; per-user completion tracked. Tested. |
| 106 | Role-based settings & permissions | **Implemented** | Roles (`server/_core/roles.ts` + `system.capabilities`) + **real multi-user teams** (`server/teams.ts` + `teams` router): shared case access enforced in `assertCaseOwnership`; stranger still blocked (isolation preserved). Tested. |
| 107 | Quality scoring & confidence display | **Implemented** | `server/confidence.ts` — honest confidence derived from real match score (no hardcoded 0.98); applied in `matching.findLawyers`. Tested. |
| 108 | Human decision minimization | **Implemented** | `docs/DECISION_MINIMIZATION.md` — auto vs human decisions; exceptions + clarifications minimize prompts (real endpoints). |
| 109 | Exception-based workflow dashboard | **Implemented** | `dashboard.exceptions` in `server/routers/dashboard.ts` surfaces missing-contact, unclassified, no-evidence, and awaiting-approval cases; covered by `tests/backend/phase101_115.test.ts`. |
| 110 | Safe retries & recovery | **Implemented** | `server/retry.ts` `retryWithBackoff` (isRetryable/cancel/jitter); live job runner delegates to it. Tested. |
| 111 | Ambiguous external-action resolution | **Implemented** | `clarifications.pending/answer` in `server/routers/index.ts` computes and persists real multi-area/missing-contact resolutions; covered by `tests/backend/phase101_115.test.ts`. |
| 112 | Versioning & changelog discipline | **Implemented** | `CHANGELOG.md` and `package.json` are aligned at 1.3.0; `scripts/prod-preflight.mjs` blocks a version without a changelog entry. |
| 113 | Regression baseline | **Implemented** | `scripts/regression-baseline.mjs` + `docs/regression-baseline.json` enroll every currently blocking test file and fail if any enrolled file is removed. |
| 114 | Maintenance & refactoring review | **Implemented** | `docs/MAINTENANCE_REVIEW.md` — completed refactors (shared retry/system-state) + maintainability backlog. |
| 115 | Final human-operator readiness | **Implemented** | `scripts/operator-readiness.mjs` (all green) + `docs/OPERATOR_READINESS.md`. D1 (14 routers) + D3 (gated real send) now done; end-to-end path exists behind the safety flag. |
| 116 | Flask runtime consolidation | **Implemented** | `scripts/migrate_flask_ledger.py`, migration `0006`, authenticated archive history, and `docs/FLASK_TO_DESKTOP_MIGRATION.md` make Electron authoritative while preserving owner-scoped source rows and verified evidence without transferring sessions, vault tokens, or live-send state. |

## Current reconciliation

The old tally and "not yet worked" section were removed because they contradicted
the current code and release gate. Historical row statuses remain useful as a
record of phase closure, but they must not be aggregated into a current product
claim. The renderer now typechecks and lints as a blocking gate; real outreach
send and response recording are implemented behind ownership, approval,
feature-flag, provider, emergency-stop, audit, and idempotency controls.

Current limitations and external acceptance requirements are maintained in
`README.md`, `docs/TECH_DEBT.md`, `docs/OPERATOR_READINESS.md`, and
`docs/FINAL_VERIFICATION_REPORT.md`.
