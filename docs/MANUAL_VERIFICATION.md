# Manual Verification Evidence

Current as of 2026-08-01. This document supersedes the 2026-07-06 phase
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
- A complete manifest-bound target backup validates with 54 tables, the current
  standalone secret compatibility tag, complete local evidence coverage, and no
  untracked SQLite sidecars.
- Gmail SMTP authentication was verified without sending a message. This proves
  credentials only, not approved delivery, receipt, audit, or duplicate blocking.
- Public branding is owner-approved and hash-bound in `release-acceptance.json`.

## Not Yet Verified

- Google and outbound email are the selected live-provider scope and have not
  completed target acceptance. Google is currently unconfigured pending a valid
  replacement OAuth client secret. Outbound delivery remains disabled pending
  an approved single-delivery test and audit/idempotency verification.
- The ngrok `/laro` public route currently falls through to another service;
  only loopback API health is verified.
- Optional inbound email, S3, and provider-backed AI are not selected for this
  release and remain disabled rather than being treated as verified.
- Trusted public Windows distribution is not selected; the supported artifact
  is unsigned and intended for internal delivery.

Do not infer provider readiness from a successful build. Each enabled provider
requires the acceptance evidence listed in `docs/ROADMAP.md` and
`release-acceptance.json`.
