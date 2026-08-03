# Acceptance Test Matrix

Current as of 2026-08-03. Automated criteria exercise real tRPC procedures and
temporary SQLite databases; they do not contact external people or accounts.

| ID | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| AC1 | Create an owned case | `tests/acceptance/acceptance.test.ts` | Automated |
| AC2 | Classify the case into legal areas | acceptance and classification suites | Automated |
| AC3 | Return suitable lawyers with deterministic scores | acceptance, backend, and e2e suites | Automated |
| AC4 | Persist evidence bytes with SHA-256 provenance | file-safety and hardening suites | Automated |
| AC5 | Prepare outreach drafts in one start action | `tests/e2e/workflow.e2e.test.ts` | Automated |
| AC6 | Never send before explicit approval | acceptance and real-send suites | Automated |
| AC7 | Fail honestly when no delivery provider exists | `tests/backend/realSend.test.ts` | Automated |
| AC8 | Send exactly once when enabled, approved, and delivered | `tests/backend/realSend.test.ts` | Automated with injected provider |
| AC9 | Record only owned inbound outcomes and update analytics | `tests/backend/realSend.test.ts` | Automated |
| AC10 | Export a non-empty ZIP evidence package | `tests/backend/partials_hardening.test.ts` | Automated |
| AC11 | Export and erase user data | acceptance and GDPR suites | Automated |
| AC12 | Prevent cross-user access | isolation and outreach lifecycle suites | Automated |
| AC13 | Reject hostile input and unsafe paths | adversarial and file-safety suites | Automated |
| AC14 | Recover validated SQLite, matching desktop encryption secrets, and referenced local evidence while preserving every previous path | backup-set suite and blocking recovery drill | Automated |
| AC15 | Boot the packaged desktop on a free loopback port | clean-profile packaged runtime probe | Automated locally |
| AC16 | Discover media/organization candidates without sharing case prose | `tests/backend/outreachDirectory.test.ts` | Automated with a controlled public-search response |
| AC17 | Prevent unreviewed or rejected targets from appearing as active case matches | `tests/backend/outreachDirectory.test.ts` | Automated |
| AC18 | Keep outreach directory records and matches tenant-scoped | `tests/backend/outreachDirectory.test.ts` | Automated |
| AC19 | Recover the Flask legal ledger, auth sessions, OAuth vault, and referenced uploads while preserving every previous path | `test_flask_recovery.py` and blocking Flask recovery drill | Automated |
| AC20 | Migrate exactly one Flask owner into Electron without cross-owner records, provenance loss, secret transfer, duplicate imports, or live-send activation | `test_flask_to_desktop_migration.py` and `tests/backend/legacyImports.test.ts` | Automated |
| AC21 | Reconstruct every owned case document as a source-linked station while distinguishing explicit links from confidence-labelled suggestions | `tests/backend/caseReconstruction.test.ts`, document-intelligence and production-readiness suites | Automated |
| AC22 | Focus a reconstruction by source-derived participant or legal topic and retain the selected document's dated actions | `tests/backend/caseReconstruction.test.ts`, renderer accessibility suite | Automated |
| AC23 | Bind every Drive operation to the selected owner's Google account | `tests/backend/googleDriveAccountSelection.test.ts`; `tests/security/liveProviderAcceptance.test.ts` | Automated |
| AC24 | Resolve uncertain delivery without automatic retransmission | `tests/backend/realSend.test.ts` | Automated |

## Target-Environment Acceptance

| ID | Criterion | Required evidence |
| --- | --- | --- |
| M1 | Live outreach delivery | Approved test recipient receives one message; duplicate send produces no second message |
| M2 | Gmail/Drive intake | Target OAuth client connects, pull completes, and imported records retain provenance |
| M3 | Optional trusted public Windows release | When public distribution is selected: a Store-signed package or version-matched portable release with valid Authenticode signature, approved icon, and matching SHA-256 checksum |

M1-M2 require organization-controlled credentials and accounts and must be
recorded for the target environment rather than replaced by local test doubles.
M3 is intentionally out of scope for the current unsigned internal distribution
path and becomes required only if trusted public Windows distribution is enabled.
