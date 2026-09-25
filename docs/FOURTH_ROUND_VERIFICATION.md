# Fourth-Round Consent and Workflow Verification

Date: 2026-09-22

Issue: [#193 `[S8-07] Verify the fourth-round consent and workflow fixes`](https://github.com/Robert-Velhorst/000-LARO/issues/193)

Candidate branch: `milestone3/remediate-roadmap`

Recorded implementation commit: `dc3884b5db3521101a2c735f7d49be0ddc18f0fe`

## Verdict

The repository-controlled acceptance criteria for issue #193 pass on the
recorded implementation commit. The complete blocking gate, stable-Chrome
browser suite, production builds, fresh-database readiness, encrypted recovery,
isolated Python suite, dependency audits, Docker build and vulnerability scan,
Windows packaging, focused negative paths, and maintained-source audit all
passed.

This is local candidate evidence. It does **not** claim that the branch has been
pushed or merged, that GitHub CI has accepted it, that the executable has run on
native Windows hardware, that the image has been published, or that this
candidate is deployed and accepted on Hetzner. The GitHub issues remain open
until those external review and release events occur.

## Prerequisite implementation ledger

Every prerequisite named by #193 is present in the candidate history. The
repository result below is not a claim that the corresponding open GitHub issue
has been closed.

| Issue | Implemented by | Repository result |
| --- | --- | --- |
| #179 S0-09 | `80f13cc` | Acceptance and smoke tests execute mounted product boundaries rather than reading source text |
| #180 S0-10 | `a0b9f6c` | Blocking source, secret, workflow, dependency, and container scanning policy |
| #181 S1-23 | `d779f39` | Explicit purpose-specific consent before optional cloud document processing |
| #182 S1-24 | `3221a7a` | HAI credentials limited by reviewed case, field, and future-record grants |
| #183 S1-25 | `46a0107` | Minimal public health and capability-protected operator diagnostics |
| #184 S1-26 | `3b745ef` | Evidence coverage replaces unsupported merit, strength, and completeness scores |
| #185 S2-18 | `d883b04` | Automatic target review limited to IDs from the active discovery run |
| #186 S2-19 | `598cc44` | Gmail and Drive disconnect represented as one reviewed shared-Google revocation |
| #187 S2-20 | `fc7ae82` | Public research is case-owned, receipt-backed, and failure-aware |
| #188 S2-21 | `21e188b` | Derived gap output becomes stale after any relevant input revision |
| #189 S2-22 | `0518385` | Literal-safe Unicode search reports per-scope completeness and failures |
| #190 S2-23 | `b3248cf` | Typed notifications have validated destinations and atomic retry-safe deduplication |
| #191 S4-17 | `82b2ec5` | Duplicate Drive preview/import/sync stack retired in favor of canonical collection |
| #192 S7-02 | `dc3884b` | Reviewed legal-draft versions persist exact bytes, hashes, and source/review provenance |

## Exact-commit release evidence

| Command or artifact | Result on `dc3884b` |
| --- | --- |
| `npm run gate` | Pass. 183 test files passed, 1 skipped; 1,077 tests passed, 2 skipped. Every blocking stage passed. |
| TypeScript, lint, and repository policy within the gate | Server, Electron main, and renderer typechecks pass; ESLint, renderer boundary, immutable workflow actions, security workflow, and behavioral-test boundary pass. |
| Traceability and static safety | 117/117 rows cited, 0 broken, 0 uncited implemented rows; 0 runtime no-excuses suspects; 0 HIGH account-safety findings. |
| `npm run test:a11y:browser` with installed stable Chrome | Pass, 37/37 scenarios in 6.9 minutes with one worker. |
| `npm run build` | Renderer, Electron main, and server production builds pass. |
| `npm run db:readiness` on a new database | Pass: SQLite integrity, 0 foreign-key violations, invariants and reconciliation clean, 15/15 numeric fields, 7/7 cross-counter constraints, 273 relationship guards, and no demo/test markers. |
| `npm run recovery:drill` | Pass: database, desktop secrets, and managed evidence restore while prior state is preserved. |
| Flask recovery drill within the gate | Pass: ledger, sessions, OAuth vault, and referenced uploads restore while prior paths are preserved. |
| Isolated Python 3.12 environment | All 59 requirements are compatible; unittest discovery passes 223/223 tests in 117.998 seconds. |
| Dependency audits | Full and production-only npm audits report 0 vulnerabilities. |
| Docker build | `laro-server:fourth-round-dc3884b` builds from refreshed bases; image ID `sha256:f1c65ef844f29b7c60e2a79382c2894ccaeba65fa23bc1fdf8223f09270bd8d5`, size 710,883,876 bytes. |
| Docker vulnerability scan | Trivy 0.74.0 reports 0 HIGH/CRITICAL Debian or Node findings. The CycloneDX SBOM is 591,669 bytes with SHA-256 `4dee0fb466cd381bef5022f38dfaa505dc124b2d394e79db635fd8b8cbc01425`. |
| Windows portable packaging | `npm run dist:win` and `npm run verify:packaged:native` pass. The app, SQLite binding, and Canvas binding are Windows x64 PE candidates. |
| Windows artifact | `release/1.3.0/LARO Desktop 1.3.0.exe`, 160,599,254 bytes, SHA-256 `0decd4422424ab7517f2a6db7fe7b39ce544fc828346fdb44475f40a0078b60d`. |

The gate validated the approved historical live-provider release record. This
run did not repeat live Google, mail, S3, or optional AI calls and does not
extend that historical acceptance to a new public deployment.

## Integrated behavioral proof

| Required boundary | Executable proof |
| --- | --- |
| Cloud consent | `workflowPreferences.test.ts`, document-intelligence/inbox suites, and dossier suites prove provider contact is blocked until the reviewed purpose is enabled and audited. |
| HAI scope | `haiIntegration.test.ts`, mandatory-audit tests, and Playwright prove grants restrict cases, fields, future records, expiry, and revocation. |
| Public health | `healthDiagnostics.test.ts` and Playwright prove public endpoints return only minimal status while detailed topology and history require operator/admin capability. |
| Evidence framing | `evidenceCoverage.test.ts`, `gapDetectionSafety.test.ts`, migration tests, and Playwright prove counts are not represented as legal merit, case strength, or completeness. |
| Discovery review scope | `outreachDirectory.test.ts` and Playwright prove automatic review touches only IDs created/refreshed by the active run and preserves unrelated/manual rows. |
| Shared Google disconnect | Provider atomicity/backend suites and Playwright prove one reviewed Gmail/Drive impact, stale-review rejection, upstream-failure preservation, and multi-account isolation. |
| Public research | `publicResearchScope.test.ts`, provider integration suites, and Playwright prove pre-contact ownership plus complete, partial, unavailable, failed, and genuine-empty states. |
| Derived freshness | `gapAnalysisFreshness.test.ts`, acceptance, and Playwright prove evidence, source-analysis, timeline, or case revisions suppress stale derived output until recomputation succeeds. |
| Search truthfulness | `literalSearchCompleteness.test.ts` and Playwright prove literal punctuation/Unicode semantics, malformed-row isolation, pagination, saved replay, and partial/failed scope presentation. |
| Notification durability | `notificationDurability.test.ts` and Playwright prove typed context, registered destinations, stale-reference suppression, and retry after failed persistence. |
| Canonical Drive ingestion | `googleDriveCanonical.e2e.test.ts` executes real tRPC, SQLite, managed-storage, and controlled Drive boundaries for create, unchanged skip, changed revision, bounded partial, and failed-revision preservation. |
| Reviewed draft versioning | `legalDraftSnapshots.test.ts`, acceptance, production-readiness, and Playwright prove reviewed recipients, stale-review rejection, immutable exact bytes/hash, one-use owner download, history, content-free audit, and erasure. |

The real-browser run also asserted rendered desktop/mobile states, HTTP status,
unexpected network failures, page errors, console errors, accessibility, control
names, keyboard paths, zoom/reflow, and exact downloaded draft bytes/hash. The
sanitized lawyer-matching, invalid-login, notes-outage, and missing-result logs
were expected negative scenarios; no unexpected browser error was accepted.

## Maintained-source audit

The audit covered maintained `server`, `src-main`, reachable renderer, `shared`,
acceptance/smoke, and release-policy paths.

| Audit question | Result |
| --- | --- |
| Uncalled Drive import coordinator | Zero maintained references to `googleDriveImport`, `googleDriveSync`, `runDriveImport`, `DriveImport`, or `importFromDrive`. The selector is read-only and calls `autoCollection.listDriveFolders`; ingestion remains in canonical auto-collection. |
| Duplicate provider tracking | No registered `googleDrive` router or direct preview/import UI remains. Canonical evidence rows own account/file identity, revisions, managed-storage key, and hash. |
| Source-string-only acceptance | `npm run verify:behavioral-tests` passes: all 9 acceptance/smoke files execute product boundaries and none imports a filesystem reader. Static checks remain supplementary security tripwires. |
| Placeholder/fake success | The blocking no-excuses scan reports 0 runtime suspects. Remaining descriptive placeholder terms are documented configuration, SQL, or UI-input usage rather than fabricated success. |
| Public surface | Public health stays minimal; operator diagnostics, provider state, job history, and metrics remain capability protected. |

## Verification false starts and disposition

No unresolved product defect was found during #193 verification. The following
host/tooling events were corrected and did not become accepted passes:

- The host's global Python 3.10 environment contains unrelated `openai-whisper`
  and `PyNaCl` dependency drift. The repository requirements were therefore
  installed from scratch under Python 3.12.13; all 59 packages passed `pip
  check`, and 223/223 repository tests passed.
- The first Trivy invocation used the retired `--hide-progress` spelling. It
  exited before scanning; the supported `--no-progress` invocation then
  generated the SBOM and the blocking scan passed with zero HIGH/CRITICAL
  findings.
- A user turn interrupted the first long-running Docker scan session. The scan
  was restarted from the pinned scanner image and completed; interruption was
  not counted as product evidence.
- A supplementary shell source-count command had an unmatched quote after the
  official behavioral-boundary command had already passed. The count was rerun
  with a Node walker and returned zero source readers.

## Explicit external boundaries

- No branch, commit, image, installer, or SBOM was pushed or published here.
- No pull request was merged, no protected GitHub CI run was created, and no
  GitHub issue was closed.
- The portable EXE was cross-built and structurally checked on Linux; native
  Windows launch, scanned-PDF OCR, and operator acceptance still require a
  Windows runner or owner machine.
- The Docker image is local and has no registry digest.
- Hetzner, DNS, TLS, public routing, production persistence, migrated owner
  data, and browser/desktop acceptance against a public target were not changed
  or re-verified.
- Live provider consent and revocation remain target-account acceptance events;
  missing optional providers continue to fail closed.
