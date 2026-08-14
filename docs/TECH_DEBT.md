# Technical Debt Register

Updated: 2026-08-14

| # | Debt | Impact | Status / next step |
| --- | --- | --- | --- |
| D1 | All mounted routers are typed and connected to supported UI actions | - | Resolved |
| D2 | Server, Electron, and renderer TypeScript plus ESLint are release-blocking; shipped runtime files cannot use `@ts-nocheck` | - | Resolved and regression-tested |
| D3 | Approved outreach uses provider, ownership, emergency-stop and idempotency gates | - | Resolved |
| D4 | OAuth token encryption uses authenticated AES-256-GCM | - | Resolved |
| D5 | CSRF origin checks, strict CORS and JWT revocation are implemented | - | Resolved |
| D6 | `archiver` remains for evidence ZIP export | Low | Reassess each release |
| D7 | Current runtime lockfile has no known advisory | - | Re-audit each release |
| D8 | Duplicate `shared/` and `src/shared/` contracts | - | Resolved; `shared/` is canonical |
| D9 | Historical excluded tests and audit snapshots remain for traceability | Low | Keep clearly dated; remove only through reviewed archive work |
| D10 | Historical tables use database triggers rather than native foreign-key clauses to avoid destructive installed-data rebuilds | Low | Startup enforces insert/update/delete relationships; readiness verifies every guard and reconciliation covers historical drift; replace with native FKs only through a backup-tested migration |
| D11 | Top-level proprietary license | - | Resolved |
| D12 | CSV and ZIP evidence export include a case-scoped index, redacted metadata, analyses, and available source files; PDF remains unavailable | Low | Keep capability labels honest |
| D13 | Historical subscription, usage-limit, and monetary usage columns remain in installed schemas | Low | Keep for compatibility; new telemetry writes quantity counts only and leaves monetary fields null |
| D14 | Persisted NL/EN runtime and operational-surface translation | - | Resolved with typed catalog, language controls, locale formatting, and browser persistence coverage; source/provider/user content intentionally retains its original language |
| D15 | Desktop scanner previously accepted false connection success and fabricated uploads | - | Resolved with session auth, folder consent, review selection and real evidence storage |
| D16 | Supported Electron/Chromium route accessibility and responsive coverage | - | Resolved with a CI Playwright/axe matrix across all 15 static routes at desktop and mobile sizes; non-target browsers and formal WCAG certification remain outside the packaged-app claim |
| D17 | Evidence, case, and account deletion could leave managed objects after metadata deletion | - | Resolved; managed storage keys are deleted first and failures abort deletion |
| D18 | KvK lookup used a stale query-string contract and a missing LinkedIn enrichment module | - | Resolved; uses the official open-dataset path contract, normalizes its response, and exposes only supported lookup controls |
| D19 | Retention was manual-only and accepted unsafe environment values | - | Resolved; bounded configuration fails startup, and an idempotent observable sweep runs after startup and daily |
| D20 | Legacy evidence scoring UI was connected to lawyer matching and the export view exposed inert buttons | - | Resolved with dedicated owner-scoped scoring/export routers and integration coverage; see `LEGACY_DASHBOARD_PORT_AUDIT.md` |
| D21 | Multiple desktop processes could share one SQLite profile and run duplicate background jobs | - | Resolved with an Electron single-instance lock, tested restore/show/focus handoff, and a packaged two-launch profile probe in the Windows release workflow |
| D22 | Electron sessions had no explicit browser-permission policy | - | Resolved with deny-by-default check/request handlers installed before any window and covered by behavioral/security tests |
| D23 | Desktop could continue with temporary encryption keys when install-secret persistence failed | - | Resolved with atomic first-run creation, strict existing-file validation, explicit environment override, fail-closed startup before SQLite opens, and packaged restart/hash verification in the Windows workflow |
| D24 | Database-only backups could validate successfully without preserving or checking the key required to decrypt provider tokens | - | Resolved with manifest-bound backup sets, bundled desktop keys, external-secret compatibility checks, rollback-safe paired restore, explicit legacy override, and a blocking paired recovery drill |
| D25 | Electron backup sets did not preserve locally managed legal evidence bytes | - | Resolved with versioned local-file inventories, managed-key coverage, stable-source rescans, S3 inventory binding, rollback-safe storage restore, and a blocking database/key/evidence drill |
| D26 | Flask ledger, auth, token-vault, and upload recovery is still separate from the Electron backup CLI | - | Resolved with a manifest-bound four-member recovery set, external-secret compatibility checks, upload-reference coverage, path rebasing, rollback-safe restore, and a blocking destructive drill |
| D27 | Electron and Flask previously remained concurrent application runtimes with independent databases and authentication/session models | - | Resolved by making Electron authoritative and adding an offline owner-bound migration that operationally maps supported records, archives every owner-scoped source row with hashes/redaction, copies verified evidence, rejects changed reruns, and never migrates sessions or vault credentials |
| D28 | Strict historical counters remain text-backed for installed-schema compatibility | Low | Production readiness now blocks malformed, unsafe, and impossible counter data using aggregate-only checks; convert columns only through a backup-tested migration |

D10 is operationally contained without rewriting installed databases. A native
foreign-key conversion remains migration work, not a release blocker while the
guard and reconciliation gates stay green. D16 remains incremental quality
work. Provider rollout must retain credential, consent, approval and audit gates.
