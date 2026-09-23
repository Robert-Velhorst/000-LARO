# Technical Debt Register

Updated: 2026-09-23

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
| D10 | Historical tables used generated relationship triggers instead of native foreign keys | - | Resolved with the backup-verified `0031` compatibility migration, schema-derived native keys, reviewed delete policies, orphan preflight, and post-migration `foreign_key_check` |
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
| D24 | Database-only backups could validate successfully without preserving or checking the key required to decrypt provider tokens | - | Resolved with a version-4 AES-GCM envelope, an independently escrowed recovery key, authenticated private inventory, rollback-safe restore, explicit retirement of plaintext sets, and a blocking copied-backup drill |
| D25 | Electron backup sets did not preserve locally managed legal evidence bytes | - | Resolved with encrypted local/S3 byte inventories, managed-key coverage, stable-source rescans, rollback-safe storage restore, and a blocking database/key/evidence drill |
| D26 | Flask ledger, auth, token-vault, and upload recovery is still separate from the Electron backup CLI | - | Resolved with a manifest-bound four-member recovery set, external-secret compatibility checks, upload-reference coverage, path rebasing, rollback-safe restore, and a blocking destructive drill |
| D27 | Electron and Flask previously remained concurrent application runtimes with independent databases and authentication/session models | - | Resolved by making Electron authoritative and adding an offline owner-bound migration that operationally maps supported records, archives every owner-scoped source row with hashes/redaction, copies verified evidence, rejects changed reruns, and never migrates sessions or vault credentials |
| D28 | Strict historical counters remained text-backed for installed-schema compatibility | - | Resolved with backup-verified migration `0032`, explicit malformed-value preflight, 27 native numeric fields, named type/range checks, and numeric read/write paths |
| D29 | Gap review derived completeness and case-strength percentages from record counts | - | Resolved with a versioned evidence-coverage inventory, exact source/analysis revisions, explicit unknowns and limitations, legacy-row retirement migrations, and backend/browser regression coverage |
| D30 | Automatic outreach discovery approved an arbitrary owner-wide pending slice | - | Resolved with run IDs, stable candidate-ID dispositions, exact-ID transactional review/matching, manual and historical preservation, and explicit partial-bound reporting |
| D31 | Separate Gmail and Drive disconnect language concealed revocation of their shared Google grant | - | Resolved with one versioned impact review, explicit shared-capability confirmation, stale-review rejection before provider contact, full-state retry on provider failure, transactional schedule/source cleanup, and browser/backend regressions |
| D32 | Public-record searches were not case-owned and provider failures could resemble zero-result history | - | Resolved with pre-fetch ownership checks, metadata-only mandatory receipts, explicit completeness states, null failure counts, and backend/browser regressions across KvK, Rechtspraak, and KOOP |
| D33 | Gap-analysis results could outlive the evidence, source analysis, case, or timeline revision that produced them | - | Resolved with exact input manifests and revision checks, explicit fresh/stale/running/failed/unavailable states, hidden non-current derived output, recomputation gates, and backend/browser regressions |
| D34 | Maintained text searches interpreted punctuation and category failure inconsistently | - | Resolved with the documented `literal-search-v1` normalization/escaping contract, per-category completeness, malformed-row isolation, truthful renderer states, and backend/browser regressions |
| D35 | Notification writes discarded type/context and could mark reminder deduplication complete after a failed insert | - | Resolved with typed owner-validated records, registered destinations, explicit durable outcomes, one atomic row-level deduplication authority, stale-reference suppression, and backend/browser regressions |
| D36 | A second Drive router exposed preview/direct-import/sync logic, repeated deduplication and analysis, and wrote a parallel provider table | - | Resolved by retaining only read-only folder selection plus canonical auto-collection; canonical evidence now owns account-bound source identity, provider revision, version history, hashes, bounded outcomes, and retry-safe failure behavior |
| D37 | Legal drafts were transient renderer blobs with placeholder recipients and no reproducible source/review version | - | Resolved with reviewed recipient revisions, immutable exact-byte snapshots, source/analysis provenance, stale-review rejection, owner-only historical downloads, mandatory content-free audit, and erasure coverage |

D16 remains incremental quality work. Provider rollout must retain credential,
consent, approval and audit gates.
