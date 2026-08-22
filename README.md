# LARO: Legal Aid Reach Out

![LARO logo](public/laro-logo.png)

LARO is a local-first legal case workspace for turning scattered documents into
an organized, source-linked case record. It helps a case owner collect evidence,
read and compare documents, reconstruct what happened over time, identify
potential support, prepare outreach, and export an auditable case package.

LARO is designed around one rule: **a conclusion should lead back to the source
that supports it**. Extracted events, summaries, legal observations, and inferred
document relationships remain reviewable suggestions. Raw source documents are
not hidden or discarded.

> [!IMPORTANT]
> LARO is an assistance and preparation tool. It is not a lawyer, does not give
> definitive legal advice, and does not determine the legal truth or likely
> outcome of a case. Generated work must be reviewed by a qualified person.

## Contents

- [LARO at a glance](#laro-at-a-glance)
- [Core principles](#core-principles)
- [How a case moves through LARO](#how-a-case-moves-through-laro)
- [Capabilities](#capabilities)
- [User interface](#user-interface)
- [Architecture](#architecture)
- [Installation and quick start](#installation-and-quick-start)
- [Configuration](#configuration)
- [Google and outbound email](#google-and-outbound-email)
- [API-only and ngrok deployment](#api-only-and-ngrok-deployment)
- [Security, privacy, and recovery](#security-privacy-and-recovery)
- [Developer guide](#developer-guide)
- [Testing and production readiness](#testing-and-production-readiness)
- [Legacy Flask migration](#legacy-flask-migration)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Documentation index](#documentation-index)

## LARO at a Glance

### Who It Is For

| Reader | What LARO provides |
| --- | --- |
| A person with a legal matter | One place to organize the case, evidence, chronology, possible lawyers, support organizations, media contacts, and reviewed outreach |
| A legal professional or case worker | Source-linked document analysis, evidence comparisons, case reconstruction, missing-record review, deadlines, obligations, and exportable case material |
| An operator | Provider configuration, health checks, audit history, emergency controls, backups, retention, and controlled deployment |
| A software developer | A React/Electron desktop app, Express/tRPC API, SQLite/Drizzle data layer, deterministic intelligence, provider adapters, tests, and release gates |

### What It Does

- Stores owned cases and their evidence in a structured workspace.
- Imports evidence from uploads, selected local folders, Gmail, and Google Drive
  when those providers are configured.
- Extracts text and builds source-grounded summaries, events, parties, dates,
  amounts, claims, obligations, legal issues, risks, and source spans.
- Answers case questions from completed analyses while preserving references.
- Builds chronological, horizontal, vertical, Gantt, story, and metro-style
  Papertrail views with direct access to source documents.
- Searches and ranks lawyers through the official Dutch NOvA public directory.
- Maintains reviewable directories for media and support organizations.
- Prepares outreach and tracks responses without silently contacting anyone.
- Exports evidence and provenance in reviewable packages.

### What It Does Not Do

- It does not replace a lawyer or establish facts, liability, motive, evidence
  destruction, or a legal outcome.
- It does not treat AI output as confirmed evidence.
- It does not automatically approve or send an external message.
- It does not claim that target discovery is exhaustive.
- It does not provide a trusted, publicly signed Windows installer. The current
  distribution target is an unsigned internal portable build.
- It does not make every configured connector operational. Microsoft collection
  and Trello OAuth remain unavailable until their complete flows are accepted.

## Core Principles

1. **Source before summary.** Evidence retains its origin, content hash, and a
   retrievable managed copy. Findings point to extracted source spans.
2. **Raw evidence remains part of the record.** Analysis adds a review layer; it
   does not replace or exclude the underlying document.
3. **Local-first by default.** Core case work and deterministic analysis do not
   require a paid AI provider. Optional cloud providers are selected explicitly.
4. **Human review before consequence.** Suggestions, timeline corrections,
   shortlists, messages, and exports remain reviewable.
5. **No implicit external action.** Sending requires ownership, exact-message
   approval, an enabled flag, a released emergency stop, a configured provider,
   and an unused dispatch guard.
6. **Unknown stays unknown.** Missing lawyer capacity, availability, performance,
   or provider state receives no invented value.
7. **Fail closed.** Missing credentials, invalid citations, stale approvals,
   unsupported formats, storage failures, and uncertain delivery do not produce
   false success states.
8. **One production data authority.** Electron/Express is authoritative after a
   legacy Flask workspace has been migrated. Bidirectional editing is unsupported.

## How a Case Moves Through LARO

1. **Create a case.** Describe the situation in ordinary language. LARO stores
   the draft, creates the case, and classifies relevant legal areas.
2. **Collect evidence.** Upload files, select a local folder, or connect Gmail and
   Drive. Imported items retain source metadata and SHA-256 provenance.
3. **Review and link.** Case-neutral documents can remain in an inbox until a
   user accepts a deterministic case suggestion. Nothing is silently linked.
4. **Analyze documents.** Supported evidence is extracted locally and turned
   into versioned, source-linked suggestions. Existing stored documents do not
   need to be uploaded again.
5. **Understand the history.** Use the timeline, story, Gantt chart, or metro map
   to inspect who said or did what, when, and in which document.
6. **Identify gaps.** Review missing records, contradictions, deadlines,
   obligations, and open loops. Completeness is not case strength.
7. **Find support.** Search lawyers with official filters and match reviewed
   media or organization targets against the case.
8. **Prepare outreach.** Review the exact recipient, subject, body, disclaimer,
   and content hash before approval.
9. **Send deliberately.** Approval still does not send. A separate send action
   uses the immutable approved message and guarded provider path.
10. **Track and export.** Record responses, inspect analytics, export the case,
    or exercise account and case erasure controls.

## Capabilities

### Case Management

- Owned cases with status, urgency, legal areas, parties, identifiers, claims,
  positions, deadlines, obligations, risks, notes, and audit history.
- Draft autosave and restore during case intake.
- Search, filtering, saved searches, notifications, and activity history.
- Case-scoped checks on documents, analysis, timelines, matching, outreach,
  exports, and destructive actions.
- Case and account data exports.

### Evidence Collection and Provenance

| Source | Current behavior |
| --- | --- |
| Direct upload | Validates type/size, stores real bytes locally or in S3, computes SHA-256, and rolls back if record creation fails |
| Desktop folder | Uses the native folder picker, requires a case, presents files for review, and uploads only selected files |
| Standalone folder | Accepts only paths under operator-configured `LOCAL_SCAN_ROOTS` |
| Gmail | Uses read-only Google OAuth, imports messages/attachments, retains Gmail identity, and supports bounded filtered pulls |
| Google Drive | Uses read-only OAuth, supports explicit account/folder selection, and exports Google-native documents to PDF before analysis |
| Inbox | Holds case-neutral evidence until the owner explicitly links it |

Keyword pulls are persisted jobs rather than page-bound tasks. Their state can
survive navigation or reload and includes source phase, reviewed items,
extracted words and characters, elapsed time, percentage, ETA, result, and
failure detail.

Managed local files open through owner-checked, short-lived signed URLs. The
server verifies the stored hash and does not expose a filesystem path. S3-backed
evidence uses provider-signed URLs.

Supported desktop analysis inputs:

- TXT, CSV, HTML, and EML
- PDF and DOCX
- JPEG, PNG, GIF, WebP, and BMP through Dutch/English OCR

PDF extraction reads embedded text first. Pages with too little readable text
are rendered and passed through Dutch/English OCR, then merged back into the
page-ordered result. OCR quality still depends on scan quality and layout.

### Document Intelligence

The maintained desktop runtime performs deterministic extraction first. It can
retain summaries, document types, parties, contacts, dates, amounts, legal
references, claims, positions, obligations, deadlines, risks, legal issues,
chronology, events, contradictions, and literal source spans.

Optional provider enrichment is accepted only when every retained observation
cites an extracted source segment belonging to that document. Unknown or
uncited findings are discarded. Cache entries bind to the source hash, analysis
version, provider, and model, so a changed input triggers fresh analysis.

The case question interface searches completed analyses. A valid answer keeps
document IDs and source controls. If an optional model is unavailable or returns
invalid citations, LARO falls back to deterministic matches rather than
inventing an answer.

### Timelines, Gantt, and Papertrail

LARO offers several views over the same evidence:

- a neutral chronological story grouped into date-ordered phases;
- source-linked legal events in horizontal or vertical orientation;
- a Gantt-style view for dated work, deadlines, and activity;
- source-document chronology and operational case activity;
- an accessible chronological list;
- a metro-style reconstruction inspired by Paper-trail Visualizer.

In the metro map, documents are stations and event categories are route lines.
Solid directional links come from provider metadata or literal document
references. Dashed links are bounded similarity suggestions based on shared
parties, issues, terms, route, and chronology. They include a basis and
confidence and are not proof of influence or causation.

Users can filter routes, change orientation, zoom, trace a station backward or
forward, focus on an analyzed participant or topic, inspect source-derived
actions, and open the document. Natural-language corrections are audited
overlays; source evidence remains immutable.

### Lawyer Matching

- Queries the official NOvA public lawyer finder from the case workspace.
- Supports official legal area, city/postcode, radius, specialization
  association, and financed-legal-aid filters.
- Sends filter terms, not the case narrative or stored client address.
- Retains official profile/source provenance.
- Ranks with case-derived legal fields and only available data.
- Does not invent capacity, availability, performance, or quality.

Matching is decision support, not an endorsement or availability guarantee.

### Media and Organization Matching

The Outreach workspace includes owner-scoped directories for media programs,
newsrooms, journalists, advocacy groups, support organizations, associations,
and relevant lobbies.

Candidates can be entered manually or found through bounded public searches.
Discovery sends canonical legal-area queries, never private case prose. New
candidates start pending, are deduplicated, and require review before case
matching. Automatic mode may build a shortlist; it never sends a message.

This is a curated review aid, not a comprehensive or continuously verified
database of every possible target on the internet.

### Outreach and Analytics

```text
PendingApproval -> Approved -> Dispatching -> Sent
        |             |             |
        +-> Rejected  +-> Rejected   +-> Approved after confirmed non-delivery
```

- Drafts can be reviewed individually or as a batch.
- Historical `automatic` mode means draft preparation only. Human approval is
  still required.
- Approval hashes outreach ID, case ID, recipient, subject, complete body, and
  disclaimer. Stale or modified content requires a new review.
- Dispatch claims a message atomically before provider contact, preventing
  duplicate sends and send/reject races.
- Provider exceptions remain uncertain instead of being silently retried. An
  operator verifies provider activity and records delivered or not delivered.
- `outreach.send.enabled` is off by default. The emergency stop overrides it.
- Analytics use owned records for prepared, approved, sent, responses, interest,
  declines, follow-ups, progress, and response rates.

### Export, Privacy, and Erasure

- Case-scoped CSV evidence index.
- ZIP package with available source bytes, provenance, analyses, and manifest.
- Case/account data export without credential-shaped fields.
- Case/account erasure with managed-storage deletion tracking and retry.
- Shared-object retention while another record still references it.
- Bounded audit and backup retention.

PDF evidence-package export is not implemented and remains labelled unavailable.

## User Interface

The interface uses progressive disclosure: ordinary tasks appear first, while
advanced analysis and operational controls remain available without crowding
the primary workflow.

| Area | Purpose |
| --- | --- |
| Home | Owned case overview, activity, and next actions |
| Cases | Create, filter, open, update, export, or erase a case |
| Case command center | Evidence, analysis, timelines, gaps, progress, outreach, communications, and exports |
| Evidence | Upload, collect, search, filter, score, compare, validate, and export |
| Analysis | Analyze pending documents, inspect findings, and ask grounded questions |
| Timeline | Legal events, documents, activity, story, Gantt, and Papertrail reconstruction |
| Lawyers | Directory, official filters, comparison, and profiles |
| Outreach | Overview analytics plus Lawyers, Media, and Organizations |
| Messages and Email | Persisted communications and configured account workflows |
| Settings | Account, language, workflow, analysis provider, integrations, and HAI |
| Privacy | Data export, privacy preferences, and account erasure |
| Admin | Health, invariants, flags, retention, emergency stop, and uncertain dispatches |
| Help | Guidance, error catalog, and legal boundary |

The shipped dashboard supports Dutch and English for authentication, navigation,
legal safety messaging, and the scanner. Source and user text retain their
original language.

## Architecture

```text
Electron main process
  -> creates/loads installation secrets
  -> opens and migrates SQLite
  -> starts Express/tRPC on loopback
  -> loads the React renderer
  -> provides narrow native IPC

React renderer -> /api/trpc with an HTTP-only session

Express/tRPC server
  -> enforces authentication, roles, ownership, limits, and state machines
  -> reads/writes SQLite through Drizzle
  -> stores evidence locally or in S3
  -> owns provider credentials and external calls
```

| Layer | Technology | Source |
| --- | --- | --- |
| Desktop shell | Electron 43 | `src-main/` |
| Interface | React 18, Vite 8, Tailwind, Radix UI, TanStack Query | `src/renderer/` |
| API | Express, tRPC, Zod | `server/` |
| Persistence | SQLite, better-sqlite3, Drizzle | `server/schema.ts`, `drizzle/` |
| Evidence storage | Confined local storage or AWS S3 | server storage modules |
| Extraction | pdf-parse, Mammoth, Cheerio, Tesseract.js, local parsers | analysis modules |
| Legacy source | Flask, SQLAlchemy, local encrypted vault | `app.py`, `legal_ledger.py`, `frontend/` |

### Deployment Modes

| Mode | Includes | Intended use |
| --- | --- | --- |
| Electron desktop | UI, API, database, native picker, local provider config | Primary local workspace |
| API-only Docker | Express/tRPC, SQLite/evidence volumes, operations | Controlled remote/API integration |
| Legacy Flask | Old command center and ledger | Offline review and one-way migration |

Docker does not include Electron or Flask. The API-only ngrok deployment does
not publish the Electron interface.

### Data and Ownership

- `laro-server.sqlite` is the maintained application database.
- `laro-agent.db` stores scanner progress/review state.
- Evidence lives under Electron user data, in Docker volumes, or in S3.
- Owner rows carry `userId`; case children pass `assertCaseOwnership`.
- Lawyers are global reference data; private matches/outreach are owner-scoped.
- Media and organization directories are owner-scoped.
- Provider tokens stay server-side, encrypted, and absent from API responses.
- SQLite uses WAL, foreign-key enforcement, migrations, a busy timeout, and
  additional relationship guards for historical tables.

## Installation and Quick Start

### Requirements

- Windows 10/11 for the primary desktop and packaging workflow.
- Node.js `>=22.12 <23` and npm.
- Python 3.11+ only for legacy Flask review, migration, and Python tests.
- C++ build tools only if npm cannot obtain a native SQLite binary.
- Optional Docker Desktop and provider credentials.

### Desktop Development

```powershell
npm ci
npm run setup
npm run doctor
npm run dev
```

`npm run setup` creates `.env` from `.env.example` only when absent. It never
overwrites existing configuration.

```powershell
npm run dev:server      # Express/tRPC only
npm run dev:renderer    # Vite renderer only
npm run build           # all production builds
npm run dist:win        # unsigned Windows portable package
```

Packaged desktop generates durable per-install secrets under Electron user data.
A standalone server requires strong `JWT_SECRET` and `COOKIE_SECRET` values.

### First Account

- Packaged desktop signup creates a local owner through the UI.
- API-only deployment requires a one-time 32-256 character
  `STANDALONE_SIGNUP_TOKEN`; the first account becomes administrator.
- Standalone enrollment closes after the first owner exists.

Current Windows artifacts are unsigned and intended for internal distribution
after checksum verification. Windows may show an unknown-publisher warning.

## Configuration

Copy `.env.example` to `.env` and set only what the runtime needs. Never commit
secrets, databases, token vaults, or evidence.

| Area | Important variables |
| --- | --- |
| Runtime | `NODE_ENV`, `HOST`, `PORT`, `SERVER_ONLY`, `API_BODY_LIMIT` |
| Auth | `JWT_SECRET`, `COOKIE_SECRET`, `STANDALONE_SIGNUP_TOKEN`, `ALLOWED_ORIGINS` |
| Public path | `PUBLIC_PATH_PREFIX`, `LARO_PUBLIC_BASE_URL`, `LARO_PUBLIC_ORIGIN`, `LARO_PUBLIC_PATH_PREFIX` |
| Data | `DATABASE_URL`, `LOCAL_STORAGE_DIR`, `LOCAL_SCAN_ROOTS`, `AWS_S3_*` |
| Backups | `LARO_BACKUP_HOST_DIRECTORY`, destination kind, retention, and maximum age |
| Audit | `AUDIT_RETENTION_DAYS` (30-3650) |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE_URL`, legacy `GOOGLE_REDIRECT_URI` |
| Email | `SENDGRID_API_KEY`, `EMAIL_FROM`, or `SMTP_*` |
| Desktop AI | Provider keys and matching `LARO_*_MODEL` values |
| Legacy Flask | `LARO_FLASK_PORT`, `LARO_HOST`, `SECRET_KEY`, ledger/upload/auth/token variables |
| Legacy Ollama | `LARO_ANALYSIS_PROVIDER`, loopback base URL, model, timeout, and batch size |

### Analysis Providers

Local deterministic analysis is the default and needs no API key. The owner can
select one configured provider in **Settings > Workflow**.

| Provider | Credential | Model override |
| --- | --- | --- |
| Forge | `FORGE_API_KEY`, optional `FORGE_API_URL` | `LARO_FORGE_MODEL` |
| OpenAI | `OPENAI_API_KEY` | `LARO_OPENAI_MODEL` |
| Anthropic | `ANTHROPIC_API_KEY` | `LARO_ANTHROPIC_MODEL` |
| Google Gemini | `GOOGLE_GEMINI_API_KEY` | `LARO_GOOGLE_MODEL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `LARO_DEEPSEEK_MODEL` |
| Groq | `GROQ_API_KEY` | `LARO_GROQ_MODEL` |
| Together | `TOGETHER_API_KEY` | `LARO_TOGETHER_MODEL` |

Credentials make a provider available; they do not prove live acceptance.

### Connector Status

| Connector | State |
| --- | --- |
| Gmail and Drive | Implemented with read-only Google OAuth |
| NOvA lawyer finder | Implemented through the official public directory |
| SMTP and SendGrid | Implemented; sending disabled by default |
| AWS S3 | Optional managed evidence storage |
| HAI | Owner-bound, revocable, read-only feed |
| KvK public records | Supported official open-data contract |
| Telegram | Bot/API and desktop-export import paths are available when configured; bot history is limited by Telegram and target verification is still required |
| Microsoft/OneDrive/Outlook | Reserved configuration; collection unavailable |
| Trello OAuth | Unavailable until durable token lifecycle is complete |
| Google Calendar/Contacts | Not implemented as LARO evidence connectors |

## Google and Outbound Email

The Google connector requests Gmail read, Drive read, and account-email identity.
It does not request send, delete, calendar, or contacts access.

Desktop loopback callback:

```text
http://127.0.0.1:8768/api/oauth/gmail/callback
```

Gateway callback:

```text
https://<gateway-domain>/<prefix>/api/oauth/gmail/callback
```

After consent, status updates without page reload. Disconnect revokes the Google
grant before deleting local encrypted credentials. If revocation fails, the
credential remains for retry and no false success is recorded.

### Protected Windows Configuration

Use DPAPI-backed, non-echoing prompts instead of `.env` for live Google/SMTP
secrets:

```powershell
.\scripts\configure-live-providers.ps1 -Google -Smtp
.\scripts\configure-live-providers.ps1 -Status
```

The command stores `provider-config.json` in the resolved LARO/Electron user-data
location and reports the path. Secrets are encrypted for the current Windows
user and decrypted only in memory. It migrates an older worktree-local config.

For Gmail SMTP, use a 16-character app password, not the account password.

Explicit live acceptance commands:

```powershell
npm run acceptance:outbound-live
npm run acceptance:google-evidence-live
npm run acceptance:google-drive-evidence-live
```

These use real external accounts and are consequential. Run them only with the
intended owner account and recipient. Automated tests do not replace them.

## API-only and ngrok Deployment

### Local Docker

```powershell
docker compose up --build
```

The image runs Express/tRPC on Node 22. SQLite and local evidence persist in the
named `laro-data` volume. Keep `LARO_COMPOSE_PROJECT_NAME` stable across checkout
moves.

```text
/api/live    process liveness
/api/ready   database and service readiness
/api/health  non-sensitive operational summary
```

### Existing ngrok Gateway

```powershell
.\scripts\start-ngrok-api.ps1 `
  -ComposeProjectName laro `
  -GatewayUrl https://example.ngrok-free.dev `
  -PathPrefix /laro

.\scripts\start-ngrok-api.ps1 -SkipBuild
.\scripts\stop-ngrok-api.ps1
```

This publishes the API below `/laro`, not the Electron UI. The launcher validates
the route, loads protected providers, and persists non-secret deployment markers.
A plain Compose restart fails closed after an accepted provider contract rather
than silently losing providers or changing the callback.

Direct tunnel fallback:

```powershell
.\scripts\start-ngrok-api.ps1 -ComposeProjectName laro -DirectPublicTunnel
```

Assigned free domains can change. A stable gateway path is recommended.

### HAI Read-only Source

`/api/integrations/hai/feed` serves the dedicated HAI adapter. Its token is
owner-bound, `hai:read` only, stored as a digest, shown once, revocable, and
limited to 365 days. The bounded feed includes case status and selected analysis
summary fields, but excludes contacts, source bytes/quotes, and provider secrets.

## Security, Privacy, and Recovery

### Security Boundaries

- bcrypt passwords; signed HTTP-only sessions; revocation, origin/CSRF, role,
  rate, and ownership controls.
- Per-install desktop secrets; no packaged `.env`.
- Scanner uploads keep session and scanner authority in the Electron main
  process; reusable API credentials are not exposed to renderer JavaScript.
- Server-owned encrypted provider credentials.
- Owner-checked short-lived evidence links.
- Bounded uploads, parsing, exports, searches, and provider calls.
- Electron context isolation, sandbox, restricted navigation, denied browser
  permissions, narrow IPC, and single-instance profile lock.
- Demo mode and sample account seeding disabled in production.

### Review Boundaries

- Model observations stay unconfirmed until reviewed.
- Gap scores measure completeness, not legal strength.
- Generated requests/letters are drafts without invented authority.
- Bundle approval binds to an exact case snapshot and becomes stale after change.
- Outreach approval binds to the exact recipient and content shown.
- Missing/failed providers never create a false `Sent` state.

### Privacy and Erasure

- Private data and source access are owner/case scoped.
- Exports omit password, token, key, secret, authorization, and cookie fields.
- Evidence, case, and account erasure coordinate metadata and storage cleanup.
- Pending provider cleanup is reported and retried.
- Audit retention is bounded and does not delete owner business records.
- No third-party product analytics or payment/upgrade enforcement is present.

### Backup and Restore

Electron recovery sets bind database, `laro-secrets.json`, local evidence, and a
manifest:

```powershell
npm run db:backup
npm run db:validate -- <backup-path>
npm run db:restore -- <backup-path>
npm run recovery:drill
```

The default `.laro-backups` is a same-device copy, not off-device protection.
Use a truthful synced/network destination and configure count/age limits.

## Developer Guide

### Repository Map

| Path | Responsibility |
| --- | --- |
| `src-main/` | Electron lifecycle, secure startup, native picker, scanner, provider config |
| `src/renderer/` | React app, routes, case workspace, visualizations, review controls |
| `server/` | API, authorization, data, providers, analysis, matching, workflow, health |
| `shared/` | Shared constants and contracts |
| `drizzle/` | Maintained SQLite migrations |
| `assets/`, `public/` | Matching datasets and approved branding/static assets |
| `tests/`, `test_*.py` | Maintained and legacy test suites |
| `scripts/` | Setup, build, deployment, backup, readiness, acceptance, release |
| `docs/` | Product, architecture, operations, security, privacy, and audits |
| `app.py`, `legal_ledger.py`, `frontend/` | Legacy Flask migration source |

### Common Commands

```powershell
npm run doctor
npm run typecheck
npm run typecheck:renderer
npm run lint
npm test
npm run test:a11y:browser
npm run build
npm run check:renderer-bundle
npm run gate
npm run readiness
npm run readiness:production
npm run db:readiness
npm run preflight
npm run audit:deps
```

Native SQLite mismatch recovery:

```powershell
npm run rebuild:node
npm run rebuild:electron
npm run verify:electron-native
```

### Development Invariants

- Private data is scoped at the server, never trusted to the renderer.
- Credentials never enter renderer state or API responses.
- Evidence retains source identity, bytes, and hash provenance.
- Model findings require valid source spans.
- Unsupported or uncertain behavior is explicit.
- Approval and delivery remain separate.
- Live tests use owner-controlled targets and explicit gates.
- Migrations are recoverable and use validated backups.
- Updates are proposed through a pull request to `main`.

A provider is complete only with server-owned credentials/revocation, least
privilege, authorization, bounded calls, truthful errors, provenance/audits,
deterministic tests, explicit live acceptance, and documentation.

## Testing and Production Readiness

`npm run gate` blocks on native rebuild, all TypeScript checks, ESLint, bundle
budgets, dependency audits, release-record validity, traceability, safety scans,
Electron and Flask recovery drills, and Vitest.

At merged commit `e043667f` on 2026-08-15, the gate passed **87 test files and
499 tests**, with 0 dependency vulnerabilities, 117/117 traceability rows cited,
0 suspect runtime placeholders, and 0 high-severity account-safety findings.
PR 101 also passed Node, Python, and renderer-accessibility jobs. This is a dated
snapshot; use a fresh gate and the latest
[GitHub Actions run](https://github.com/Robert-Velhorst/000-LARO/actions) for the
current commit.

```powershell
python -m unittest discover -v -p "test_*.py"
```

### Evidence Levels

| Evidence | What it proves |
| --- | --- |
| Unit/integration | Deterministic behavior under controlled fixtures |
| Production build | Type and bundle correctness |
| Packaged Electron | Native ABI, migrations, startup, secrets, profile lock, packaged UI |
| Docker readiness | Production dependencies, volumes, health, auth boundaries |
| Browser accessibility | Routes, responsive overflow, labels, errors, selected interactions |
| Provider-live | Target account, scopes, import/delivery, provenance, revocation, audit |

No narrow category proves a broader one. Credentials and mocked tests do not
prove live Google import or delivery.

```powershell
npm run release:prepare
npm run acceptance:providers
npm run release:check
npm run dist:win
```

Public trusted Windows distribution requires a separately accepted Store or
Authenticode identity. Internal tagged releases may remain unsigned.

## Legacy Flask Migration

The Flask command center remains because older LARO/Papertrail workspaces hold
valuable source-linked ledger data. It is not the maintained product.

```powershell
python -m pip install -r requirements.txt
Copy-Item .env.example .env
.\run_local.ps1
```

Open `http://127.0.0.1:8768/case_command_center.html`. Its convenience bootstrap
is loopback-only and limited to `LARO_LOCAL_ACCOUNT_EMAIL`.

Migration is one-way and owner-bound: stop both runtimes, validate backups, map
one Flask owner to one existing desktop account, verify hashes/bytes, archive
legacy sources without passwords/sessions/tokens/send state, verify Desktop,
then keep Flask stopped. See
[Flask to Desktop Migration](docs/FLASK_TO_DESKTOP_MIGRATION.md).

```powershell
npm run flask:backup -- <backup-path>
npm run flask:validate -- <backup-path>
npm run flask:restore -- <backup-path> --confirm-stopped
npm run flask:recovery:drill
```

External Flask keys stay in independent operator escrow.

## Known Limitations

- LARO cannot establish legal truth or replace professional review.
- Scanned PDF pages use an OCR fallback; poor scans, handwriting, or complex
  layouts can still need manual review or higher-quality source material.
- Public target discovery is bounded, not exhaustive.
- Dashed map links are suggestions, not factual causation.
- Optional AI quality varies, but citations remain mandatory.
- Microsoft, Google Calendar/Contacts, and Trello OAuth are not operational
  evidence connectors.
- Sending is disabled by default.
- Flask remains a separate recovery responsibility until migration.
- Historical tables still use extra relationship guards pending native-FK work.
- SQLite/local storage target one desktop/API owner process, not active-active
  multi-node service.
- Windows portable builds are unsigned and intended for internal use.
- Formal WCAG conformance is not claimed, though automated accessibility,
  keyboard, responsive, and console checks are blocking.
- Historical docs are dated snapshots. Current code, README, fresh gate, and
  commit-specific CI are authoritative.

## Troubleshooting

### Google Consent Keeps Loading

1. Confirm LARO is running and you are signed into the intended LARO account.
2. Match the Google redirect URI exactly, including prefix and port.
3. Ensure the callback reaches the same instance that created OAuth state.
4. Check `/api/ready` and logs for callback, state, or session errors.
5. Retry from LARO rather than a stale Google consent tab.

Never place authorization codes, refresh tokens, or browser sessions in logs.

### Native SQLite Mismatch

Run the Node or Electron rebuild command above, then retry.

### Sending Is Disabled

Check ownership, Approved state, unchanged approval hash, feature flag, emergency
stop, provider configuration, and dispatch state. `Dispatching` after a provider
exception requires operator verification, not a blind retry.

### ngrok Routes the Wrong Service

Use the verified launcher, stable Compose identity, expected path, and exact
public callback. The stop script verifies a process before stopping it.

### Evidence Cannot Be Analyzed

Check format/size, managed bytes and hash, and the OCR result for scanned pages.
Poor image quality may require a better scan. Supported text should retain
deterministic analysis after an optional provider failure.

See [Troubleshooting](docs/TROUBLESHOOTING.md) and in-app Help.

## Documentation Index

### Product and Architecture

- [Product Definition](docs/PRODUCT_DEFINITION.md)
- [User Guide](docs/USER_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Frontend Architecture](docs/FRONTEND_ARCHITECTURE.md)
- [Data Model](docs/DATA_MODEL.md)
- [Domain Model](docs/DOMAIN_MODEL.md)
- [State Machines](docs/STATE_MACHINES.md)

### Operations

- [Fresh Clone](docs/FRESH_CLONE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Operator Runbook](docs/OPERATOR_RUNBOOK.md)
- [Operator Readiness](docs/OPERATOR_READINESS.md)
- [Backup and Restore](docs/BACKUP_RESTORE.md)
- [Release Process](docs/RELEASE_PROCESS.md)
- [Feature Flags](docs/FEATURE_FLAGS.md)
- [Providers](docs/PROVIDERS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

### Security and Privacy

- [Security](docs/SECURITY.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Privacy](docs/PRIVACY.md)
- [Privacy Impact Assessment](docs/PRIVACY_IMPACT_ASSESSMENT.md)
- [Compliance](docs/COMPLIANCE.md)
- [Data Retention](docs/DATA_RETENTION.md)
- [Supply Chain](docs/SUPPLY_CHAIN.md)

### Engineering and Evidence

- [Migrations](docs/MIGRATIONS.md)
- [Accessibility](docs/ACCESSIBILITY.md)
- [Performance](docs/PERFORMANCE.md)
- [Technical Audit](docs/TECHNICAL_AUDIT.md)
- [Technical Debt](docs/TECH_DEBT.md)
- [Traceability](docs/TRACEABILITY.md)
- [Final Verification Report](docs/FINAL_VERIFICATION_REPORT.md)
- [Acceptance Tests](docs/ACCEPTANCE_TESTS.md)
- [Manual Verification](docs/MANUAL_VERIFICATION.md)
- [Definition of Done](docs/DEFINITION_OF_DONE.md)
- [Changelog](CHANGELOG.md)

### Migration and Port Audits

- [Flask to Desktop Migration](docs/FLASK_TO_DESKTOP_MIGRATION.md)
- [Paper-trail Timeline Generator Audit](docs/PAPER_TRAIL_TIMELINE_GENERATOR_AUDIT.md)
- [Legacy Dashboard Port Audit](docs/LEGACY_DASHBOARD_PORT_AUDIT.md)
- [Lawyer Automation Dashboards Port Audit](docs/LAWYER_AUTOMATION_DASHBOARDS_PORT_AUDIT.md)

## License

See [LICENSE](LICENSE).
