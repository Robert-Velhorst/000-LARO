# Manual Verification Evidence

Current as of 2026-08-14. This document supersedes the 2026-07-06 phase
snapshot; exact release evidence is maintained in
`docs/FINAL_VERIFICATION_REPORT.md`.

## Verified Locally

- The blocking gate covers server, Electron main, and renderer TypeScript;
  ESLint; traceability; no-excuses and account-safety scans; both recovery
  drills; and the complete Node test baseline. Runtime dependency audit,
  browser accessibility, production builds, and packaging are separate release
  checks.
- Production readiness has run with strong target-like secrets and an explicit
  clean database, including integrity, foreign-key, invariant, reconciliation,
  duplicate, and demo-marker checks.
- The unsigned portable app has launched with isolated user data and returned a
  healthy production response after applying all packaged migrations.
- Browser QA covered authenticated desktop and mobile layouts, Outreach,
  lawyer filtering, case-intake autosave across close and reload, immediate case
  list refresh, and scanner consent controls without console errors.
- Packaging contents, SQLite schema, document parsers, matching data, checksum,
  and Windows signature state were inspected directly.
- The current API deployment passes local live, ready, and health probes. Its
  actual standalone secret configuration and a clean target-database snapshot
  passed `npm run readiness:production`.
- A complete manifest-bound target backup validates with 55 tables, the current
  standalone secret compatibility tag, complete local evidence coverage, and no
  untracked SQLite sidecars.
- Gmail SMTP authentication was verified without sending a message. This proves
  credentials only, not approved delivery, receipt, audit, or duplicate blocking.
- Public branding is owner-approved and hash-bound in `release-acceptance.json`.
- The LARO-to-HAI connector contract is covered by real SQLite migration,
  token hashing, owner isolation, bounded cursor, minimization, revocation, and
  HAI source-ingestion tests.
- Live cross-application acceptance passed on 2026-08-09 and the retained
  connector was rechecked on 2026-08-14: HAI reported the
  adapter operational, created its owner-scoped source, completed a zero-item
  incremental sync against the truthfully empty LARO case database, and retained
  the read audit event. A temporary LARO credential changed from health 200 to
  401 after revocation; the retained credential exists only in HAI's protected
  ignored environment.
- The protected-main unsigned Windows artifact from Actions run `31758745277`
  is 151,940,420 bytes with SHA-256
  `56484bd1cf5a2d5a371fc6cb129c956750721bf93a29080a5a2ea683d8180d55`.
  Its downloaded bytes match the checksum sidecar, and Electron 43.1.0 loaded
  the native SQLite ABI 148 binding successfully.
- A 120-request public health probe returned only HTTP 200 responses. Readiness
  p95 was 51.5 ms and health p95 was 54.4 ms through ngrok; afterward the API
  container returned to 0% CPU with 166.2 MiB resident memory.
- The current real-browser audit passed all four scenarios, including all 15
  routes at both desktop and mobile sizes, locale persistence, responsive
  migration controls, and source-linked document reconstruction.

## Not Yet Verified

- Google and outbound email are the selected live-provider scope and have not
  completed target acceptance. The Google web client and SMTP provider are
  configured, and a non-destructive live check authenticated SMTP. The owner's
  Google consent grant is not stored yet, so Gmail/Drive reads and the controlled
  self-delivery, evidence, source-opening, revocation, and duplicate-blocking
  acceptance sequence remain pending.
- The ngrok gateway now routes `https://laro-api-000.ngrok.app/laro` to LARO.
  Public root, live, ready, health, and OAuth callback routing were rechecked on
  2026-08-14. The callback returned the expected 400 response for an intentionally
  invalid consent result, proving route ownership without creating a grant.
- Optional inbound email, S3, and provider-backed AI are not selected for this
  release and remain disabled rather than being treated as verified.
- Trusted public Windows distribution is not selected; the supported artifact
  is unsigned and intended for internal delivery.
Do not infer provider readiness from a successful build. Each enabled provider
requires the acceptance evidence listed in `docs/ROADMAP.md` and
`release-acceptance.json`.
