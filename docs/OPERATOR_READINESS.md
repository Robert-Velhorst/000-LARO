# Operator Readiness

This checklist separates repository evidence from target-environment approval.

## Automated Evidence

`npm run readiness` first rebuilds the native SQLite driver for Node, then
requires traceability, no-excuses and account-safety scans, the regression
baseline, and isolated Electron plus Flask backup/restore round trips. It also runs the environment
preflight as an advisory check and prints both stdout and stderr for a failed
step so the blocker remains visible.

`npm run readiness:production` makes the production preflight blocking. Run it
with the target API environment, including strong `JWT_SECRET` and
`COOKIE_SECRET`. LARO Desktop generates equivalent per-install secrets in its
user-data directory.

`npm run preflight` loads the project `.env` and defaults to production when
`NODE_ENV` is omitted. It therefore fails closed on missing or weak secrets;
development exemptions require an explicit `NODE_ENV=development`.

Production mode also runs the `db:readiness` checks against the configured
database. It blocks on SQLite integrity errors, declared foreign-key violations,
missing legacy relationship guards, failed invariants, reconciliation findings,
duplicate emails, or exact known demo/test account markers. The report contains
counts only and does not print case or user data. The same command is packaged
as a compiled operation in the API-only production image; it does not require
development dependencies such as `tsx`. In a source checkout, the command
prefers the current TypeScript source and first restores the Node ABI for
`better-sqlite3`, including after an Electron build or package operation.

## Release Checklist

- [ ] `npm ci` succeeds on supported Node 22.
- [ ] `npm run gate` and the Python test suite pass.
- [ ] `npm audit --omit=dev` reports no unresolved runtime vulnerability.
- [ ] `npm run readiness` passes, including both runtime recovery drills.
- [ ] `npm run readiness:production` passes for an API deployment.
- [ ] The Windows portable artifact builds and launches on a clean profile.
- [ ] A second desktop launch returns focus to the existing window instead of
      opening another process against the same SQLite profile. The Windows
      workflow enforces this against the packaged executable.
- [ ] Browser permission checks and requests remain denied unless a reviewed
      product feature explicitly introduces a narrowly scoped exception.
- [ ] `laro-secrets.json` is readable and durable; startup never falls back to
      temporary keys. The Windows workflow verifies restart preservation, while
      `db:backup`, `db:validate`, and the Electron recovery drill prove a
      manifest-bound database/key/local-evidence set. `flask:backup`,
      `flask:validate`, and the Flask drill separately prove ledger, auth,
      OAuth-vault, and upload recovery. S3 objects retain their documented
      external recovery controls.
- [ ] A target Flask recovery set validates with the escrowed `SECRET_KEY` and,
      when configured, `LARO_TOKEN_ENCRYPTION_KEY`; the server and workers are
      stopped before `flask:restore -- --confirm-stopped`.
- [ ] The scanner requires a selected case and native-picker-approved folder,
      exposes a review list, and persists a test file with matching SHA-256.
- [ ] Demo data is absent from the target database.
- [ ] `npm run db:readiness` passes; equivalently, `admin.invariants` and
      `admin.reconcileReport` are clean and SQLite checks pass.
- [ ] A target-data backup is validated before migration or release.
- [ ] The emergency stop and `outreach.send.enabled` state are confirmed.
- [ ] Google, storage, LLM, and outreach providers show their intended state.
- [ ] Every provider intended to be enabled has target-account evidence. Missing
      optional providers remain disabled and visibly unavailable.
- [ ] Each approved provider has a complete `providerChecks` entry in
      `release-acceptance.json`; configuration presence alone is not evidence.
- [ ] For internal unsigned distribution, the artifact reports `NotSigned`, its
      SHA-256 matches the reviewed checksum, and the recipient accepts the normal
      Windows publisher warning.
- [ ] For trusted public distribution only, `release-acceptance.json` is approved
      and the Store or Authenticode identity and checksum match the submission.

## Supported Operating Modes

The application supports local desktop operation and an API-only container. AI,
Google import, S3 storage, and outreach delivery depend on configured providers;
when absent, those actions fail explicitly rather than fabricating results.
Outreach delivery remains disabled by default and requires operator approval,
the feature flag, provider readiness, ownership checks, idempotency, and a
released emergency stop.

The current owner-selected target is unsigned internal distribution. Store
certification and a recurring certificate are intentionally outside that target;
they become requirements only if trusted public distribution is selected.
