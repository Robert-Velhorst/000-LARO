# September 2026 consolidation review

## Inputs and preservation

The integration branch includes the original main, the Codex architecture branch,
and all six Dependabot branches. The original branch histories are retained.
The reviewed application changes are incorporated into this build branch without
publishing the private operational handoff history. The original handoff remains
in a separate local audit checkout. No original branch was reset or deleted.
The code handoff is not a database, managed-originals or private-key backup.

## Results before combining the handoff

- The eight-branch integration passed its complete stabilization gate: 691 tests
  passed, two skipped, no dependency vulnerabilities, and both recovery drills.
- Its compiled production server passed browser signup/enrollment closure,
  authenticated cases and byte-verified evidence, analysis, ZIP export, desktop
  and fresh-mobile rendering, separate browser sessions, authorization/CSRF,
  unknown-route handling, and restart persistence.
- The unchanged handoff passed all three TypeScript checks, lint, production
  build, bundle budgets, the recovery drill, and the local Google callback test.
- Its full suite reported 902 passing, four failing, and two skipped tests.
  Three failures were source-text assertions for the former navigation property,
  old Google connection labels, and old loading component. The corresponding
  rendered screens passed browser checks. The fourth failure was a cold import
  timeout; its unchanged token-transport assertions passed a focused rerun.
- The handoff browser flows passed local test-ticket redemption and replay
  rejection, offline recovery, isolated cookies, restart, disabled workers,
  source progress/rechecking, multi-account Google screens, and timeline
  corrections. Expected connection errors occurred only in deliberate outage
  checks. Google consent and provider responses used test doubles; this is not
  live provider acceptance.
- The unchanged handoff's dependency audit reported four vulnerabilities. Its
  code was combined with the dependency fixes rather than downgrading to the
  handoff's lockfile. The combined dependency audit reports zero vulnerabilities.

## Consolidation-specific adaptations

- Preserve the handoff authentication redesign and local test controls while
  retaining first-owner setup-code enrollment for the shared server.
- Serve both browser assets and APIs with Express 5-compatible fallback routing.
- Keep remote desktop cases, evidence, and accounts on the same backend; retain
  isolated native scan/review state and explicit local-workspace mode.
- Preserve custom local-workspace cookies. Use the standard shared-server cookie
  for remote native uploads, without transmitting local scanner credentials.
- Block server-local source intake from a remotely connected desktop, including
  a separately hosted loopback API. The inbox Folder upload and consent-gated
  case scanner remain available; Windows paths are never interpreted as server
  folders merely because they were selected on the desktop.
- Update the three outdated source-text assertions to check the reviewed UI's
  equivalents. Give only the full router-import test a larger cold-transform
  budget; its security assertions remain unchanged.
- Align the source-control browser test with the handoff's existing structured
  Google failure display. It now checks the cause, reconnection guidance, and
  failure code instead of the raw provider error that the UI no longer renders.
- Force local operator test tickets off in shared Compose configuration. Keep
  the existing server's proxy and ports isolated from unrelated applications.
- Arm the bounded HTTP shutdown drain before awaiting Socket.IO's shutdown.
  An open browser connection otherwise kept the compiled server alive after
  SIGTERM. Both idle preconnection and in-flight-request regression cases pass.

## Combined local verification

- The full combined stabilization gate passed: **920 tests passed, two skipped**
  across 148 files; all three TypeScript checks, lint, bundle budgets, both
  dependency audits, safety scans, and both recovery drills passed.
- The subsequent shutdown correction passed all **19 targeted tests** for HTTP
  lifecycle, local-source admission, and native cookie authorization. These
  overlap the full suite; they are not 19 additional unique tests. The complete
  gate above preceded that final lifecycle correction.
- Actual Chrome and Linux Electron 43.4.0 passed **15 shared-backend checks**:
  setup-code enrollment, same-case evidence, native selected-folder upload,
  inbox original-byte integrity, signed-in restart, logout authorization,
  mobile reload, browser routes, exports, and server persistence. There were
  no captured page, console, request, or HTTP-response errors. The OS folder
  selection was automated; the scan, upload, authorization, and storage were real.
- The native SQLite module was compiled and verified for Electron ABI 148 in
  an isolated test runtime, without replacing the backend's Node binding or
  using an installed user profile. This does not prove a packaged Windows build
  or owner-device acceptance.
- The combined compiled build also passed all five workspace browser flows:
  local access/session isolation/live-browser restart, source progress, source
  screening/failures/rechecks, Google multi-account controls, and timeline
  corrections. The observation report has no page errors or HTTP error responses.
  Eight connection-refused requests occurred during the deliberate backend
  outage. Google provider responses were test doubles, not live account access.
- The final renderer browser/accessibility suite passed **20 of 20 tests**,
  including 15 supported routes on desktop/mobile, keyboard and zoom behavior,
  case actions, source controls, dossier assignment, notes, and recovery states.
  Its first run passed 19 and exposed the outdated raw-Google-error assertion
  described above. After correcting only that assertion, the entire suite passed.
  Rejection and unavailable-data scenarios include logged tRPC errors; this is
  not a zero-console-error claim for every deliberately failing test scenario.
- Final lint, browser-script syntax checks, and Git whitespace checks passed.
- Final Compose parsing verified loopback-only application exposure, an optional
  TLS proxy, disabled local test tickets, and fresh-secret overwrite refusal.
  Dockerfile build checks completed with no warnings (metadata/static checks).
  Container image build/run and GitHub CI acceptance remain pending; the local
  Docker filesystem has insufficient safe headroom for another full build.

## Reproduce local browser checks

Use Node 22, install dependencies, rebuild the Node SQLite binding, and build the
application before running these checks. They create synthetic test workspaces;
never point them at the owner's database or private provider environment.

```sh
npm ci --ignore-scripts
npm run rebuild:node
npm run build
node scripts/verify-shared-deployment.mjs
node scripts/verify-workspace-browser.mjs --source-progress --source-checks --google-accounts --timeline
LARO_BROWSER_CHANNEL=chrome LARO_BACKGROUND_JOBS=false CI=true npm run test:a11y:browser
```

The commands above use installed Chrome for browser verification. The shared
deployment script also supports `LARO_BROWSER_CHANNEL=chromium` after installing
Playwright's Chromium. Its basic run does not exercise Electron unless a separate
Electron-compatible runtime is supplied; do not replace the server's native
SQLite module with an Electron build in the same dependency directory.

Reports are written under `out/shared-verification/`,
`out/workspace-verification/`, and `playwright-report/`. Workspace flow screenshots
are in the disposable directory printed by that run. These artifacts are local
test evidence, not material to include in a workspace-data migration.

## Acceptance boundary

The complete gate and subsequent focused/browser checks are described separately
above so that their coverage is not confused. Local logs and synthetic screenshots
are verification evidence, not owner-data migration or Hetzner production evidence.
Historical product/benchmark documents from the handoff are not new claims of
accepted functionality. This branch is prepared for Windows build verification,
not a tagged production release. The original handoff audit remains local and
the remote main branch is not changed by publishing this separate build branch.

The existing server has not been changed. Production completion still needs an
authorized Linux access method, the intended domain's DNS setup, and a complete
private workspace recovery set. Preserve the source data and matching keys,
restore an isolated copy, and validate before cutover. The shared server must not
be reset, rebooted, or have unrelated services replaced to obtain access.
