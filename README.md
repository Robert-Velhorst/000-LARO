# LARO: Legal Aid Reach Out

LARO is a local-first legal case workspace for collecting evidence, understanding source documents, building a reviewable chronology, matching support, and preparing controlled outreach. Its core design principle is provenance: findings should lead back to the document and passage that support them.

LARO assists with organization and preparation. It is not a lawyer, does not provide definitive legal advice, and must not present generated analysis as a confirmed legal conclusion. External communication is never implicit: approval, feature, provider, ownership, and emergency-stop checks protect the send path.

## Current Architecture

This repository has one maintained Express/tRPC application architecture with
two production deployment modes: the Electron desktop and an API-only Docker
service. The Flask command center is retained as a legacy review and migration
source so existing source-linked ledgers can be moved without treating two
databases as concurrent authorities.

| Runtime | Primary use | Source | Default address | Persistence |
| --- | --- | --- | --- | --- |
| Electron desktop + Express/tRPC | Desktop case workflow, connectors, matching, controlled outreach, administration | `src-main/`, `src/renderer/`, `server/` | `http://localhost:3000` inside Electron | SQLite via Drizzle plus local or S3 evidence storage |
| Express/tRPC API-only service | Authenticated remote API and provider operations through a controlled gateway | `server/`, `Dockerfile`, `docker-compose.yml` | Loopback Docker port routed through the configured HTTPS gateway | SQLite and local evidence in the persistent Docker volume, or configured S3 |
| Legacy Flask migration source | Review/export an existing source-linked legal ledger before owner-bound migration | `app.py`, `legal_ledger.py`, `frontend/` | `http://127.0.0.1:8768/case_command_center.html` | `instance/laro_ledger.sqlite3` plus ignored local uploads and token vault |

The Electron main process starts the Express/tRPC server and React renderer together. `npm run dev:server` runs only that API server. The Flask launcher remains loopback-only for legacy review. Stop both applications before applying the one-way Flask-to-desktop migration; after migration, Electron is authoritative.

## Capabilities

### Case and evidence work

- Persist cases, parties, identifiers, status, risk, deadlines, obligations, open loops, claims, positions, and audit history.
- Upload or stage PDF, DOCX, HTML, text, email-shaped, and Drive-shaped records while retaining source metadata and content hashes.
- Keep case-neutral documents in an inbox until a user reviews deterministic case suggestions and explicitly links them.
- Pull selected Gmail and Google Drive records through real read-only OAuth when credentials are configured; multi-account owners explicitly choose which Drive account each folder belongs to.
- Run desktop keyword pulls as persisted, resumable jobs with live source phase,
  extracted-word and item counts, percentage, and estimated seconds remaining.
- Deduplicate imported evidence while preserving source URIs and locally retrievable files.
- Open managed local evidence through ownership-gated, five-minute signed HTTP
  links that verify the stored SHA-256 hash and never expose a desktop or
  container filesystem path. Configured S3 storage continues to use provider-
  signed URLs.
- Scan only folders selected through the native desktop picker, review the discovered files, and upload only the selected evidence.
- Standalone servers reject local-folder collection unless the path resolves
  inside an operator-configured `LOCAL_SCAN_ROOTS` allowlist.
- Store actual scanner bytes under the owned case with SHA-256 provenance; scanner credentials expire after 15 minutes and cannot call other protected APIs.
- Persist Gmail messages, attachments, local files, and Drive files under the same evidence contract; Google-native documents are exported to analyzable PDF while retaining their source identity.
- Score case evidence against persisted case context and source-linked document analyses, with the score, matched terms, method, and reasoning retained in evidence metadata.
- Export a case-scoped CSV index or ZIP evidence package containing provenance metadata, analyses, and every available managed source document.

### Document intelligence and Papertrail

- Extract readable text and create review-only suggestions for events, claims, evidence links, contradictions, deadlines, obligations, and missing evidence.
- Analyze TXT, CSV, HTML, EML, PDF, DOCX, and JPEG/PNG/GIF/WebP/BMP image evidence locally in the desktop runtime; Dutch and English image OCR feeds the same versioned summaries, parties, dates, amounts, claims, obligations, legal issues, risks, and source spans. Scanned PDFs must first be converted to images.
- Run local citation extraction automatically for supported Gmail, Drive, and folder imports; optional deep analysis is accepted only when every finding cites a real extracted source segment.
- Ask case questions against the most relevant completed document analyses. Answers
  must preserve valid document IDs, expose direct source controls, and fall back
  to deterministic evidence matches when the optional model provider is
  unavailable or returns invalid citations.
- Analyze one or all pending stored case documents from the Analysis workspace;
  documents uploaded through the normal Evidence flow do not need to be
  uploaded again.
- Run full-source deterministic comparisons or optional loopback-only Ollama analysis in bounded batches.
- Reject uncited model observations; retained suggestions include literal source support and remain unconfirmed until reviewed.
- Build who-said-or-did-what-and-when timelines with actor, action, affected party, event type, date, summary, and direct document access.
- Reconstruct the case history as a metro-style document map: every real case
  document is a dated station, event categories form route lines, and provider
  metadata or literal document references form solid directional links.
- Show similarity-based relationships only as dashed suggestions with a
  confidence threshold and reviewable basis. LARO does not relabel similarity
  as proven influence or causation.
- Trace a selected document backward and forward, filter routes, switch between
  horizontal and vertical maps, zoom, and use an accessible chronological list;
  each station retains a direct source-document control.
- Focus the reconstruction on one source-derived participant or legal topic and
  inspect every dated action retained for the selected document.
- Read the evidence as neutral date-ordered story phases, jump to source-backed
  key moments, and inspect connected chains with separate verified and inferred
  link counts. These views never infer motive or a legal outcome.
- Browse source-linked legal events horizontally or vertically, source documents,
  and operational case activity from one Timeline workspace.
- Inspect the same evidence history as a metro map, chronological list, or Gantt chart. Natural-language timeline corrections are stored as audited overlays; source evidence remains immutable.
- Generate source-linked case summaries, lawyer briefings, red-line drafts, and approval-bound case bundles.

### Matching and outreach

- Query the official NOvA public lawyer finder from the desktop case workspace, retain source/profile provenance, and rank lawyers using the case's legal fields plus only attributes that are actually available. Unknown capacity, availability, or performance receives no invented score.
- Apply official legal-area, city/postcode, radius, specialization-association, and financed-legal-aid filters. City/postcode sharing is explicit; LARO does not send case prose or a client's stored address to NOvA.
- Use one desktop Outreach workspace for analytics, lawyers, media, and organizations. Media and organization candidates follow the owner's per-item, batch, or automatic shortlist-review setting; preparing a shortlist never sends a message.
- Discover or manually import media/organization candidates from bounded public searches, deduplicate them per owner and category, and rank only approved records against the selected case. Discovery sends canonical legal-area queries, never case prose, and does not claim exhaustive internet coverage.
- Legacy Flask outreach records are archived during migration but are never inserted into a live desktop send queue.
- Track outreach totals, progress, responses, acceptance, and pending work per case.
- Prepare and approve outreach drafts without sending them automatically.
- Send an approved desktop-runtime lawyer outreach only when the global emergency stop is released, `outreach.send.enabled` is enabled, the caller owns the case, a real email provider is configured, and the idempotency guard has not already recorded the send.
- Resolve an ambiguous provider outcome from the admin operations view only after checking provider activity. Confirmed delivery finalizes the send-once guard without retransmission; confirmed non-delivery safely permits a controlled retry, and both decisions are audited.
- Prove the target environment's outbound path with an explicit owner self-test that verifies one Gmail inbox copy, exercises duplicate prevention, stores only signed redacted acceptance evidence, and removes its temporary case/outreach records.
- Prove the target environment's Google intake with an explicit owner self-test
  that reuses the labelled outbound message, exercises the real Gmail collector,
  deterministic email analysis, signed source retrieval, and source-open audit,
  then stores only signed redacted proof and removes the temporary case and bytes.

## Prerequisites

- Windows 10/11 for the primary desktop and PowerShell workflow.
- Node.js 22.12 or newer in the Node 22 LTS line. CI, Electron 43, and the native-module rebuild scripts use this baseline.
- Python 3.11 or newer only when reviewing, recovering, or migrating a legacy Flask workspace.
- C++ build tools may be needed if npm cannot obtain a compatible native binary.
- Optional: a local [Ollama](https://ollama.com/) installation for deeper local document reading.
- Optional: provider credentials for Google, Microsoft, S3, Trello, Telegram, AI models, or outbound email.

## Desktop Quick Start

From the repository root in PowerShell:

```powershell
npm ci
npm run setup
npm run dev
```

`npm run setup` creates `.env` from `.env.example` only when `.env` does not already exist. It never overwrites existing configuration. The packaged desktop app atomically creates durable local JWT and cookie secrets in its Electron user-data directory; standalone production server operation requires strong values in `.env`. Keep `laro-secrets.json` with its matching database backup because it also protects encrypted provider tokens. A desktop single-instance lock prevents concurrent processes from opening that shared profile; a later launch restores and focuses the existing window. Electron browser permissions are denied by default because LARO uses reviewed native IPC for local-file selection and external links instead of browser device APIs.

API-only deployments do not expose unrestricted registration. Their first
account requires a one-time `STANDALONE_SIGNUP_TOKEN` of 32-256 random
characters and becomes the administrator. After that owner exists, standalone
enrollment stays closed even when the token remains configured. Packaged desktop
signup is unchanged.

Useful desktop commands:

```powershell
npm run dev:server       # Express/tRPC API only, port 3000
npm run doctor           # environment and native-module checks
npm run lint             # TypeScript/TSX correctness lint
npm test                 # Vitest suite
npm run gate             # blocking quality and safety gates
npm run test:a11y:browser # 15-route Playwright/axe renderer audit
npm run build            # renderer, main process, and server builds
npm run dist:win         # Windows package
npm run release:prepare  # non-approved brand/provider acceptance draft
npm run acceptance:providers # non-destructive provider evidence report
npm run acceptance:google-evidence-live # controlled Gmail intake/source proof
```

## Legacy Flask Review

From the repository root in PowerShell:

```powershell
python -m pip install -r requirements.txt
Copy-Item .env.example .env
.\run_local.ps1
```

Open [http://127.0.0.1:8768/case_command_center.html](http://127.0.0.1:8768/case_command_center.html). To use another local port:

```powershell
.\run_local.ps1 -Port 8770
```

The convenience session bootstrap is loopback-only and accepts only `LARO_LOCAL_ACCOUNT_EMAIL` (default `robert.local@laro`). It is not a remote authentication mechanism. Do not operate Flask and Electron as parallel authoritative workspaces. Follow [Flask To Desktop Migration](docs/FLASK_TO_DESKTOP_MIGRATION.md) after review.

## Configuration

Copy `.env.example` to `.env`; never commit real secrets. The template is grouped by runtime:

| Area | Important variables |
| --- | --- |
| Desktop server | `NODE_ENV`, `HOST`, `PORT`, `API_BODY_LIMIT`, `JWT_SECRET`, `COOKIE_SECRET` |
| HAI connector | `LARO_PUBLIC_BASE_URL` (set automatically by the ngrok launcher); credentials are created and revoked in Settings |
| Development renderer | `VITE_LARO_API_URL` (API proxy target when it is not `http://127.0.0.1:3000`) |
| Desktop data | `DATABASE_URL`, `LOCAL_STORAGE_DIR`, `AWS_S3_*` |
| Standalone local scan | `LOCAL_SCAN_ROOTS` (path-delimited allowlist; desktop uses the native folder picker) |
| Provider-backed desktop AI | Select a configured provider in **Settings > Workflow**. Supported keys: `FORGE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`. Model IDs have matching `LARO_*_MODEL` overrides in `.env.example`. |
| Optional active connectors | `TELEGRAM_BOT_TOKEN`, `SENDGRID_API_KEY`, `SMTP_*` |
| Reserved Microsoft connector config | `MICROSOFT_*` (collection remains unavailable until implemented and accepted) |
| Flask server | `LARO_FLASK_PORT`, `LARO_HOST`, `LARO_DEBUG`, `SECRET_KEY` |
| Flask ledger | `LARO_LEDGER_DATABASE_URL`, `LARO_UPLOAD_ROOT`, `LARO_MAX_UPLOAD_BYTES`, `LARO_BUNDLE_MAX_BYTES` |
| Flask identity and vault | `LARO_AUTH_DATABASE_PATH`, `LARO_LOCAL_ACCOUNT_EMAIL`, `LARO_TOKEN_STORE_DIR`, `LARO_TOKEN_ENCRYPTION_KEY` |
| Flask password reset | `LARO_PASSWORD_RESET_URL_TEMPLATE`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_STARTTLS` |
| Local analysis | `LARO_ANALYSIS_PROVIDER`, `LARO_OLLAMA_BASE_URL`, `LARO_OLLAMA_MODEL`, `LARO_LOCAL_ANALYSIS_MAX_CHARS` |
| Google intake | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` |

Keep `LARO_HOST` and `LARO_OLLAMA_BASE_URL` on loopback for the local Flask workflow. The Flask analysis engine rejects a non-loopback Ollama endpoint.
Document-analysis cache entries are bound to the source hash, analysis version,
selected provider, and selected model. Changing any of those inputs triggers a
fresh analysis instead of silently reusing a result from another configuration.

### Google Gmail and Drive

For legacy Flask review before migration, configure a Google OAuth client with this callback:

```text
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://127.0.0.1:8768/api/google/oauth/callback
```

After OAuth succeeds, the UI updates its connection state without a manual page refresh. Pulls run as durable jobs and report persisted source, document, word, character, elapsed-time, and ETA progress. Imported records retain their original URI and read audit. Raw refresh credentials are encrypted in the ignored local `tokens/` vault; the ledger stores connection metadata and a token fingerprint, not the raw token.

The production Electron connector requests only Gmail read, Drive read, and
account-email identity access. Disconnect revokes the durable Google grant
before deleting the owner-scoped encrypted credential; a provider failure keeps
the credential available for a safe retry.

The Flask password-login path stores users and hashed bearer sessions in the ignored SQLite auth database. It does not seed sample accounts. Password reset tokens are stored only as SHA-256 digests, expire after 15 minutes, are single-use, invalidate existing sessions, and are delivered only through configured SMTP or an application-injected delivery hook.

## Review and Safety Model

- Extracted events and legal observations are suggestions, not confirmed facts.
- Every retained AI observation must cite source text; uncited model output is discarded.
- Evidence-gap scores measure record completeness, not case strength or the likelihood of a legal outcome. Missing records and silence can only reduce completeness and never establish motive, destruction, concealment, or liability.
- Generated records requests, preservation requests, missing-record clarifications, and resolution letters are factual review drafts. They contain no invented authorities or automatic findings of misconduct and must be reviewed before use.
- Case ownership is enforced on authenticated case, document, approval, audit, and matching routes.
- Approving a draft does not send it.
- Desktop outreach send is off by default through `outreach.send.enabled` and is overridden by the global emergency stop.
- A failed or missing email provider does not produce a false `Sent` state.
- Bundle approval is tied to the exact persisted case snapshot. Later evidence, analysis, outreach, draft, or case changes invalidate that approval.
- Bundle manifests include SHA-256 digests and omit credential-shaped fields and machine-local paths from structured exports.
- GDPR exports omit password, reset-token, OAuth-token, API-key, secret, authorization, and cookie fields across every owner table. Optional privacy preferences persist per account and are included in export and erasure.
- Audit retention uses a bounded 30-3650 day configuration, catches up after startup, and runs daily without deleting owner business data.

See [Operator Runbook](docs/OPERATOR_RUNBOOK.md), [Security](docs/SECURITY.md), [Privacy](docs/PRIVACY.md), and [Threat Model](docs/THREAT_MODEL.md) before operating with real case data.

## Verification

The current production-readiness candidate was verified locally on 2026-08-14.
GitHub Actions repeats the Node and browser checks on the supported Node 22 toolchain:

- `npm run gate`: all blocking gates passed.
- Server, Electron main-process, and shipped renderer TypeScript checks passed; no shipped runtime module disables type checking; ESLint passed.
- Traceability reports 117 rows, 117 cited, 0 broken references, and no
  implemented phase without a concrete repository artifact.
- Runtime no-excuses scan reported 0 suspect findings; account safety reported 0 high-severity findings.
- Vitest exercised 72 files in the blocking gate; all 415 tests passed.
  Passing coverage includes controlled NOvA parsing/filter, unknown-metric
  scoring, review-gated media/organization discovery, tenant isolation,
  case-draft persistence, provider/model cache invalidation, concurrent
  preference writes, legal-draft safety, gap-analysis safety, mutation
  truthfulness, graceful shutdown, HAI boundaries, and target-database readiness.
- Full Python discovery reported 222 passing tests, including 13 coordinated
  Flask recovery tests. Warning-focused optimization and UCID tests also passed
  with deprecations promoted to errors.
- The Vite 8 renderer, Electron 43 main process, and standalone server builds completed successfully. Electron loaded the rebuilt SQLite binding at ABI 148.
- The scanner integration test verified scoped-token isolation, owner checks, supported MIME enforcement, exact stored bytes, and SHA-256 readback.

The packaged desktop ignores `.env` files in its launch directory and normally
asks Windows for an available loopback port. Setting
`OAUTH_REDIRECT_BASE_URL` to an explicit `localhost` or `127.0.0.1` port pins the
desktop server to that registered OAuth callback port instead.
- `npm audit` reports 0 known vulnerabilities after the current lockfile also
  moved `nanoid` to 3.3.18 and transitive `js-yaml` to 4.3.1 in response to the
  2026-08-08 advisory feed.
- Production preflight and production-mode operator-readiness diagnostics reported no blockers.
  The isolated backup/delete/restore/reopen drill and target-database integrity,
  foreign-key, relationship-guard, invariant, reconciliation, duplicate, and
  demo-marker checks passed.
- Playwright smoke tests passed at desktop and 390x844 with clean consoles,
  responsive Outreach controls and no horizontal overflow. Live bounded public
  discovery produced pending organization candidates; approval immediately
  created an 80/100 case match and shortlist status updated without a reload.
  Case intake also preserved an immediately closed draft, restored it after a
  full reload, created the case without a page refresh, and cleared the draft
  only after success.
  Existing command-center, Google-status, closable-dialog, and password-control
  checks also remain covered.
- The consolidated Evidence route was exercised at desktop and 390x844. It
  exposed case-scoped CSV and ZIP exports, downloaded a real CSV, disabled the
  unavailable PDF format, and kept batch scoring unavailable with a truthful
  collection prompt when the selected case contained no evidence.
- The Playwright/axe job passed all four browser flows: the blocking audit for
  every supported route, persisted language selection, responsive Settings
  migration controls, and source-linked document reconstruction. In-app browser
  QA also passed signup, dashboard and case navigation, New Case dialog opening,
  a 390x844 responsive check, and clean console checks.
- The built production API passed liveness/readiness, rejected anonymous case
  access, rejected an unauthenticated HAI request, emitted security headers, and
  shut down cleanly. The configured ngrok gateway health endpoint was live at
  verification time and the public HAI endpoint failed closed with HTTP 401.
- Live Google consent/read/revocation and approved outbound delivery remain
  explicit external acceptance gates; local success does not mark them complete.
- Packaged Electron scanner QA passed signup, shared-session authorization, empty-state rendering, disabled unsafe scan state, Settings navigation, and clean renderer console checks.
- A packaged launch from a directory containing hostile development `.env` values still reported production mode, database readiness, and a random `127.0.0.1` port.
- An isolated Node 22 API-only container rejected anonymous owner bootstrap,
  created exactly one token-authorized administrator, and rejected every later
  signup against the same database.
- Every protected-main commit must pass the Node, Python, renderer-accessibility,
  and Windows packaging workflows. Use the latest successful
  [GitHub Actions runs](https://github.com/Robert-Velhorst/000-LARO/actions)
  for commit-specific evidence instead of relying on a hash from an older build.
- The Windows workflow publishes `LARO-Desktop-Windows` with the portable
  executable and its `.sha256` sidecar. It also verifies the production gate,
  Electron native-module ABI, single-instance profile lock, restart persistence
  of the desktop secret, and artifact checksum before upload.
- Windows reports `NotSigned` for the current unsigned distribution, as intended.
  The unsigned 1.3.0 installer was generated locally, hashed, and its unpacked
  executable remained healthy during an isolated-profile launch smoke test.
  A verified isolated-profile launch applies the packaged migrations, installs 240
  database relationship guards, serves the renderer on an automatically selected
  loopback port, and preserves the existing profile across restart.

Run the same checks locally:

```powershell
npm run gate
npm run test:a11y:browser
npm run readiness
npm run db:readiness
python -m unittest -v test_authentication test_document_intelligence test_google_oauth test_lawyer_matching test_legal_ledger test_outreach_targets
```

For a broader Flask regression run:

```powershell
python -m unittest discover -v -p "test_*.py"
```

The npm gate is fail-fast and blocks on server, Electron main-process, and
renderer TypeScript checks, lint, traceability, safety scans, isolated Electron
and Flask recovery drills, and Vitest.

## Docker and Packaging

The Docker image compiles and runs the standalone Express/tRPC API server on Node 22. It does not contain the Electron UI or Flask Case Command Center.

```powershell
docker compose up --build
```

Use the plain Compose command only for a local provider-free server. After the
ngrok launcher has verified a public deployment, it persists a non-secret
runtime contract in `.env`; subsequent restarts must use
`scripts/start-ngrok-api.ps1` so DPAPI-protected Google and SMTP credentials are
loaded. A plain Compose restart then fails closed instead of silently disabling
an accepted provider or changing the public callback path.

SQLite and local evidence persist in the `laro-data` volume. Health endpoints are available at `/api/live`, `/api/ready`, and `/api/health`.
Run `npm run readiness:runtime` inside the API container to verify the lean
production runtime, database, evidence volume, version, and HAI authentication
boundary without installing development dependencies.

For the supported Windows API deployment through an existing ngrok gateway,
keep the container on host loopback and route a dedicated path to LARO's private
Agent Endpoint:

```powershell
.\scripts\start-ngrok-api.ps1 `
  -ComposeProjectName laro `
  -GatewayUrl https://example.ngrok-free.dev `
  -PathPrefix /laro

# Later starts reuse the validated tunnel and saved, ignored local settings.
.\scripts\start-ngrok-api.ps1 -SkipBuild

# Stops only the verified LARO tunnel process and API container.
.\scripts\stop-ngrok-api.ps1
```

This publishes the API below `https://example.ngrok-free.dev/laro`; it does not
publish the Electron interface. Register
`https://example.ngrok-free.dev/laro/api/oauth/gmail/callback` on the Google web
OAuth client. See [Deployment](docs/DEPLOYMENT.md) for the exact traffic-policy,
secret-handling, and verification requirements.

### HAI connected source

LARO exposes a dedicated read-only HAI feed at
`/api/integrations/hai/feed`. It is not a general API token: the credential is
owner-bound, limited to `hai:read`, stored only as a SHA-256 digest, expires in
at most 365 days, and can be revoked immediately from **Settings > HAI**. The
raw credential is shown only once.

The feed is incremental and bounded (50 records by default, 100 maximum). It
contains case status, urgency, legal areas, case summary, and completed legal
analysis summaries with selected structured findings. Client contact details,
source-document bytes, source quotations, OAuth credentials, and outbound-mail
credentials are excluded. HAI must use its dedicated `laro` connected-source
adapter with `HAI_LARO_BASE_URL` and `HAI_LARO_CONNECTOR_TOKEN`; credentials are
never placed in the source URL or HAI database.

The live bridge was accepted on 2026-08-09: HAI reported the adapter
operational, retained an audited incremental sync, and imported zero records
because the deployed LARO owner database contained zero cases. Revoking a
temporary credential immediately changed its health response from 200 to 401;
the retained credential remains only in HAI's ignored protected environment.

When the shared gateway cannot be changed yet, start a separate direct tunnel
without altering the existing application or its traffic policy:

```powershell
.\scripts\start-ngrok-api.ps1 `
  -ComposeProjectName laro `
  -DirectPublicTunnel
```

The launcher obtains the assigned HTTPS origin, restarts the container with
matching origin and OAuth settings, verifies the public health response, and
persists direct mode for later `-SkipBuild` starts. An account-assigned direct
URL can change after a tunnel restart; update the Google OAuth redirect URI to
`https://<assigned-domain>/api/oauth/gmail/callback` before accepting Google
connectivity. The assigned domain must also be available; accounts whose only
dev domain already hosts another endpoint still require a gateway path rule or
an additional assigned domain. Use the gateway mode above for a stable
production URL.

Keep `LARO_COMPOSE_PROJECT_NAME` stable across checkout-folder moves. The
launcher passes it explicitly to Docker Compose so restarts reuse the intended
`laro-data` volume instead of silently creating an empty volume under a new
folder-derived project name.

On Windows, configure live Google and SMTP secrets through DPAPI-protected,
non-echoing prompts instead of placing them in `.env`:

```powershell
.\scripts\configure-live-providers.ps1 -Google -Smtp
.\scripts\configure-live-providers.ps1 -Status
.\scripts\start-ngrok-api.ps1 -SkipBuild
```

The protected store is shared by the standalone desktop and ngrok launcher at
`%APPDATA%\LARO Desktop\provider-config.json`. LARO decrypts it only in memory
for the current Windows user. The configuration command migrates the earlier
worktree-local `.laro-provider-config.json` automatically, so portable Windows
builds do not depend on the repository directory. Desktop Google consent uses
the stable loopback callback
`http://127.0.0.1:8768/api/oauth/gmail/callback`; register that exact URI in the
Google OAuth client alongside the ngrok callback.

Database backup/restore and live-provider acceptance commands use compiled
runtime entry points when `dist/server` exists and fall back to local `tsx`
sources only in a development checkout. The same documented commands therefore
work inside the pruned production Docker image as well as from source.

Windows desktop packaging uses:

```powershell
npm run dist:win
```

LARO's supported local workflows are unmetered. There is no checkout, paid tier,
usage quota, or upgrade gate; persisted usage data is operational count telemetry
only.

The desktop interface supports a persisted Dutch/English preference. Change it
before sign-in or from the account menu; the legal safety notice, navigation,
authentication, and scanner workflow update immediately and keep the selection
after restart.

The package includes only the two matcher datasets from `assets/`; the legacy
development service, Python cache files, and local configuration are excluded.
See [Backup and Restore](docs/BACKUP_RESTORE.md) for recovery-ready sets. The
Electron commands bind SQLite state to its token-encryption key and managed
evidence bytes. The Flask commands coordinate its legal ledger, auth sessions,
encrypted OAuth vault, and uploaded evidence:

```powershell
npm run flask:backup -- C:\Backups\laro-flask-20260720
npm run flask:validate -- C:\Backups\laro-flask-20260720
npm run flask:restore -- C:\Backups\laro-flask-20260720 --confirm-stopped
npm run flask:recovery:drill
```

Stop Flask and its workers before maintenance. External `SECRET_KEY` and
`LARO_TOKEN_ENCRYPTION_KEY` values are compatibility-bound but never copied into
the set; retain them in independent secret escrow. Both runtimes now have
blocking destructive recovery drills. The owner-bound migration archives the
Flask ledger into Electron without migrating Flask sessions or OAuth vault
credentials; Electron is the production authority after migration.

CI runs Node and Python gates for pushes and pull requests to `main`. The release
workflows target Node 22. Current Windows builds are unsigned artifacts; no Store
certification or paid signing provider is active. Tagged releases may also remain
unsigned when `WINDOWS_SIGNING_PROVIDER` is unset or set to `unsigned`, but the
external acceptance record must still be approved and Windows may show an
unknown-publisher warning. Optional Store and direct-signing routes remain available.

## Repository Map

| Path | Purpose |
| --- | --- |
| `src-main/` | Electron lifecycle, native integrations, scanner, and secure local secret bootstrap |
| `src/renderer/` | React desktop interface |
| `server/` | Express/tRPC API, Drizzle data layer, providers, matching, workflow, safety, and operations |
| `server/caseReconstruction.ts` | Deterministic document-route, explicit-link, and review-only inferred-link construction |
| `shared/` | Shared contracts and constants |
| `drizzle/` | Desktop/server SQLite migrations |
| `frontend/` | Flask command-center, evidence, timeline, Papertrail, and outreach pages |
| `app.py` | Flask routes and runtime orchestration |
| `legal_ledger.py` | Persistent legal ledger and source-linked case graph |
| `document_intelligence.py` | Deterministic extraction and review suggestions |
| `local_semantic_analysis.py` | Optional loopback local-model analysis |
| `lawyer_matching.py` | Flask legal-profile lawyer ranking |
| `outreach_target_matching.py` | Media and organization target ranking |
| `tests/` | TypeScript unit, integration, safety, accessibility, and smoke suites |
| `test_*.py` | Flask and legal-ledger unit/integration suites |
| `scripts/` | Setup, diagnostics, verification, traceability, safety, backup, and readiness tools |
| `docs/` | Architecture, operations, security, privacy, provider, and audit documentation |

## Known Limitations

- Existing Flask workspaces require the documented offline, owner-bound migration. There is no live bidirectional synchronization, and Flask must remain stopped after migration.
- Legacy prototype files remain in `frontend/` and `docs/` for traceability. Only the entry points documented above are supported runtime surfaces; historical snapshots must not be treated as current behavior.
- Several provider integrations are optional or partial and remain unavailable until valid credentials and user OAuth consent are present. Trello OAuth is intentionally disabled until server-side token storage is implemented.
- Outreach target discovery is a review aid, not a complete or continuously verified directory of every lawyer, journalist, program, lobby, or advocacy organization.
- Dashed document-map links are review suggestions based on shared analyzed
  parties, legal issues, terms, route, and chronology. They are not findings of
  legal or factual causation; unanalysed documents remain visible and flagged.
- Real external sending is intentionally disabled by default and should remain disabled until the target environment, provider, approval UI, emergency stop, and audit trail have been reviewed.
- The current lockfile audits cleanly; run `npm run audit:deps` again for every release because registry advisories change over time.
- Dashboard routes are loaded on demand. The production entry chunk is about 276 KB before gzip (85 KB gzip); the largest route chunk is about 444 KB before gzip.
- The internal portable Windows artifact is not Authenticode-signed and must not be distributed as a trusted public installer. No Store or paid-certificate route is currently active; Windows may display an unknown-publisher warning for internal builds.
- Historical phase and verification documents in `docs/` are dated snapshots. Prefer current code, tests, this README, and a fresh `npm run gate` when status statements differ.

## Further Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [User Guide](docs/USER_GUIDE.md)
- [Operator Runbook](docs/OPERATOR_RUNBOOK.md)
- [Provider Reality Review](docs/PROVIDERS.md)
- [Legacy Dashboard Port Audit](docs/LEGACY_DASHBOARD_PORT_AUDIT.md)
- [Lawyer Automation Dashboards Port Audit](docs/LAWYER_AUTOMATION_DASHBOARDS_PORT_AUDIT.md)
- [Flask To Desktop Migration](docs/FLASK_TO_DESKTOP_MIGRATION.md)
- [Feature Flags](docs/FEATURE_FLAGS.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Backup and Restore](docs/BACKUP_RESTORE.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Technical Debt](docs/TECH_DEBT.md)
- [Current Technical Audit](docs/TECHNICAL_AUDIT.md)
- [Internationalization](docs/I18N.md)
- [Changelog](CHANGELOG.md)

## License

See [LICENSE](LICENSE).
