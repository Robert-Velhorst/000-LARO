# Frontend Architecture

Current as of 2026-08-14.

## Shipped surfaces

`src/renderer/main.tsx` selects two React surfaces:

- `DashboardApp`: the authenticated case, evidence, timeline, matching,
  outreach, analytics, messaging, settings, privacy, help, and administration
  workspace.
- `App`: the desktop evidence scanner, loaded only with `?mode=scanner`.

Both use the Electron-owned loopback API origin. Major dashboard routes are
lazy-loaded. The packaged entry bundle is approximately 162 KB before gzip.
Advanced evidence views load only when selected; the default Evidence route is
approximately 38 KB before gzip and uses lightweight native DOM/SVG summary
charts. Release checks cap every JavaScript chunk at 200 KiB, the Evidence route
at 80 KiB, and stylesheets at 100 KiB.
Unmounted legacy analytics components and their Recharts/D3 runtime are not
shipped; the supported analytics surfaces are Admin, Outreach Analytics, and
the Evidence summary workspace listed below.

## Dashboard routes

| Route | Purpose |
| --- | --- |
| `/` | Owned dashboard and next actions |
| `/cases`, `/cases/:id` | Case workflow and case command center |
| `/lawyers`, `/lawyers/:id` | Persisted lawyer directory and profiles |
| `/outreach` | Consolidated owned analytics, lawyers, media, and organizations; public-source review and case matching |
| `/analytics` | Case and platform analytics |
| `/messages`, `/email` | Persisted communications |
| `/settings`, `/privacy` | User, provider, and data controls |
| `/admin`, `/admin-analytics` | Role-gated operator controls |
| `/help` | Product help and legal boundary |

Pricing, checkout, quota, and upgrade prototypes have been removed. Unfinished
reports and email-automation routes are not mounted in the production router.

The Outreach tabs use progressive disclosure: Overview shows current results,
Lawyers embeds the official NOvA-backed directory, and Media/Organizations expose
case selection, bounded discovery, manual source import, review, matching, and
shortlist controls. Mutations invalidate the relevant queries so users do not
need to reload the page. The workspace is verified without horizontal overflow
at 390x844 and 1280x800.

## Scanner boundary

- The scanner reuses the authenticated main-window session; it never creates an
  offline or anonymous identity.
- It receives a 15-minute user JWT only after `auth.me` succeeds.
- Folder access is allowed only for paths returned by the native folder picker.
- Empty folder selections and implicit whole-home scans are rejected.
- Files are reviewed and selected before upload; automatic upload is forced off.
- The main process uploads real bytes through `evidenceFiles.upload`, which
  rechecks ownership and persists SHA-256 provenance.
- The scanner window uses context isolation, sandboxing, restricted navigation,
  and a narrow validated IPC bridge.

## Quality boundary

Renderer TypeScript, Electron/server TypeScript, ESLint, production bundle
budgets, security scans, tests, and recovery verification are release-blocking. External links are
protocol-checked by Electron, local API traffic is loopback-bound, and OAuth
authorization opens in the system browser.
