# Deployment & Local Development

Updated: 2026-09-22 · Candidate branch `milestone3/remediate-roadmap`

The fourth-round local release matrix for implementation commit `dc3884b` is
recorded in [`FOURTH_ROUND_VERIFICATION.md`](FOURTH_ROUND_VERIFICATION.md).
It proves the repository-controlled build, recovery, fresh-database, browser,
container, vulnerability-scan, and Windows packaging boundaries. It is not a
claim that this commit is pushed, merged, published, deployed, or accepted on a
real Hetzner/Windows target.

## Local dev — one command (Phase 031)

```bash
npm ci --ignore-scripts
npm run rebuild:node
npm run setup      # creates .env from .env.example, prints next steps
npm run dev        # Electron desktop app; dev:main rebuilds the Electron ABI
# or, API only:
npm run dev:server # standalone server on http://localhost:3000
npm run doctor     # environment self-diagnostic (Phase 034)
```

## Docker — server backend (Phase 032)

The `Dockerfile` builds and runs the **API server** (Express + tRPC + SQLite),
i.e. the same backend the desktop app embeds. It does **not** ship the Electron
desktop UI. SQLite and local evidence persist to the `/data` volume.

```bash
docker compose up --build          # http://localhost:3000
# or:
npm run docker:build && npm run docker:run
```

This plain Compose start is for a local provider-free server. Once a public
ngrok deployment has been verified, restart it through
`scripts/start-ngrok-api.ps1`; that launcher decrypts the protected provider
configuration and enforces the persisted public route. Direct Compose starts
then fail closed if required Google or outbound-mail credentials are absent.

- Healthcheck: the container polls `/api/ready`.
- Runtime readiness: `npm run readiness:runtime` verifies production secrets,
  SQLite integrity and migrations, evidence-volume read/write, API health and
  version, and fail-closed HAI authentication without shipping development tools.
- The final production image is distroless and has no shell or npm. Execute its
  shipped operational scripts with `/nodejs/bin/node`; npm commands remain for
  the source checkout and build stage only.
- The security workflow builds this actual runtime image, emits a CycloneDX
  SBOM, and rejects every HIGH or CRITICAL Trivy finding. The recorded #193
  image has zero findings at that threshold; each pushed commit must repeat the
  scan because vulnerability data and base images change.
- Configure via `.env` (see `.env.example`). In production the server refuses to
  start without strong `JWT_SECRET`/`COOKIE_SECRET` (Phase 006).

## Health / readiness / liveness (Phase 035)

| Endpoint | Purpose | Touches DB |
|---|---|---|
| `GET /api/live` | Liveness — process is up | No |
| `GET /api/ready` | Readiness — DB reachable (503 if not) | Yes |
| `GET /api/health` | Summary: status, dbReady, version, timestamp | Yes |

These public responses intentionally contain no backup state, worker names or
history, request/error/latency metrics, configuration warnings, or detailed
failures. `GET /api/operator/diagnostics`, `health.readiness`, and
`admin.diagnostics` expose the same canonical detailed snapshot only to a
session with the `operator` or `admin` role. `admin.tableCounts` remains
administrator-only. tRPC `health.check` is a public basic check (Phase 036).

## Doctor (Phase 034)

`npm run doctor` prints a health report (Node version, secrets, DB driver,
migrations, integration config) and **exits non-zero** on production-critical
problems, so it can gate a deploy.

## Desktop plus API through ngrok

The API can remain on the operator workstation while ngrok provides the public
HTTPS endpoint. The Docker port is bound to `127.0.0.1`, so it is not exposed
directly to the local network. When the account's free dev domain already hosts
another application, LARO uses a private `laro.internal` endpoint and an exact
`/laro/*` gateway rule. Unmatched traffic continues to the existing upstream.

```powershell
# First run builds the image. A configured ngrok account is required.
.\scripts\start-ngrok-api.ps1 `
  -ComposeProjectName laro `
  -GatewayUrl https://example.ngrok-free.dev `
  -PathPrefix /laro
```

The command creates strong standalone `JWT_SECRET` and `COOKIE_SECRET` values
in the ignored local `.env` when they are absent. It never commits or prints
them. Provider credentials remain owner-supplied secrets in that ignored file.
It also persists `LARO_COMPOSE_PROJECT_NAME`; keep that value unchanged when
moving or refreshing the checkout so Docker Compose reuses the intended named
database volume.

Before creating the first account on a new API-only database, set a random
`STANDALONE_SIGNUP_TOKEN` of 32-256 characters in the ignored `.env` and
include it as `bootstrapToken` in the first `auth.signup` mutation. That first
account is created as the administrator. Standalone enrollment then closes and
rejects every later signup, even if the token is still present. Remove the token
from `.env` after bootstrap. Electron desktop signup does not use this token.
Runtime URL/PID metadata is written to ignored `.laro-ngrok.json`. Install
`ngrok/laro-path-policy.yml` on the existing public Agent Endpoint once; the
launcher then verifies `https://<dev-domain>/laro/api/health` on every start.
Opening `https://<dev-domain>/laro` returns a small JSON service-status document;
the API-only deployment intentionally does not serve the desktop renderer.
The validated gateway settings are retained in the ignored `.env`, so later
starts need no arguments. The launcher also reuses a healthy LARO tunnel.

```powershell
# Restart or re-verify the existing deployment.
.\scripts\start-ngrok-api.ps1 -SkipBuild

# Stop only LARO's verified ngrok process and API container.
.\scripts\stop-ngrok-api.ps1
```

The stop command validates both the recorded PID and the `laro-api` command
line before terminating ngrok. It does not operate on Dockerized ngrok agents,
so a separately hosted service on the same gateway remains untouched.

For Google OAuth through the public API, register this redirect URI on the LARO
web OAuth client after the ngrok URL is known:

```text
https://<ngrok-domain>/laro/api/oauth/gmail/callback
```

The assigned free dev domain remains stable. No additional paid domain is
required for this path-routed configuration.

### Direct ngrok fallback

If the existing gateway policy cannot be edited, LARO can use a separate ngrok
HTTPS tunnel without changing or replacing the application already hosted on
the gateway domain:

```powershell
.\scripts\start-ngrok-api.ps1 `
  -ComposeProjectName laro `
  -DirectPublicTunnel
```

The launcher selects the assigned HTTPS origin only after ngrok registers the
tunnel, injects that exact origin into Docker, verifies both local and public
health, and records `mode: direct` in `.laro-ngrok.json`. Direct mode is saved
in the ignored `.env`, so `-SkipBuild` reuses it. To return to gateway mode,
invoke the launcher with `-GatewayUrl`, `-PathPrefix`, and optionally
`-InternalUrl`.

The assigned direct URL may change after the ngrok process stops. Treat it as
an operational fallback, not as a stable production hostname. The account must
have an available assigned domain; if its only dev domain is already online,
ngrok rejects the direct tunnel rather than replacing or pooling with that
endpoint. In that case, install the gateway path rule or assign another domain.
Before Google OAuth acceptance, register the current callback exactly as:

```text
https://<assigned-domain>/api/oauth/gmail/callback
```

Remote Socket.IO clients must use the same prefix, for example
`path: "/laro/socket.io"`. Direct desktop operation continues to use the
default `/socket.io` path because it has no public prefix.

### Protected live-provider configuration on Windows

Do not put Google client secrets or SMTP passwords in chat, scripts, or the
project `.env`. Configure them at the operator workstation through hidden
prompts:

```powershell
# Configure either provider separately, or both in one invocation.
.\scripts\configure-live-providers.ps1 -Google -Smtp

# Show configuration booleans only; no secret is decrypted or displayed.
.\scripts\configure-live-providers.ps1 -Status

# Import the protected settings and restart the API.
.\scripts\start-ngrok-api.ps1 -SkipBuild
```

The command stores provider secrets in
`%APPDATA%\LARO Desktop\provider-config.json` using Windows DPAPI `CurrentUser`
protection, restricts that file to the current Windows account and `SYSTEM`, and
prints only configured/not-configured status. It migrates an existing ignored
worktree-local `.laro-provider-config.json` into that canonical location. Both
the standalone Electron app and ngrok launcher decrypt values only in memory;
the launcher passes them to the container without copying provider secrets into
`.env` or runtime metadata. The protected file is bound to the Windows user
profile and is intentionally excluded from backups and source control. Re-enter
and rotate the credentials after moving to another machine or Windows account.
The protected Google record also pins the desktop callback origin to
`http://127.0.0.1:8768`; authorize
`http://127.0.0.1:8768/api/oauth/gmail/callback` in Google Cloud. The ngrok
launcher intentionally replaces that origin with the public `/laro` callback
inside the API container.

The Docker image includes compiled backup and live-provider acceptance entry
points plus the small runtime dispatcher used by the normal npm commands. This
keeps `npm run db:backup`, `npm run db:validate`, and
`npm run acceptance:providers` operational after development dependencies are
pruned from the image. `scripts/start-ngrok-api.ps1` also runs the lean
`npm run readiness:runtime` contract inside the newly started container before
it accepts the deployment as healthy.

For Gmail SMTP, use `smtp.gmail.com`, port `587`, the sending Gmail address, and
a Google app password. A normal Google account password must not be used. LARO
treats SMTP as operational only when host, user, password, and sender are all
present; diagnostics and the sender use the same readiness rule. Spaces copied
from Google's app-password display are removed before protection, and port 587
requires STARTTLS with TLS 1.2 or newer.

## Notes

- The desktop app is packaged separately with `npm run dist:*` (electron-builder).
- The #193 Linux cross-build passed packaged-native PE/x64 checks for the app,
  SQLite, and Canvas. This structural result does not replace a native Windows
  launch and scanned-PDF OCR acceptance run.
- Branch and manual Windows builds are unsigned internal artifacts. Store
  certification and paid signing are not active deployment requirements. Tagged
  releases can remain unsigned after the external acceptance gates are approved;
  Windows may warn that the publisher is unknown. Any public route must use the
  owner-approved mark from `build/icon.png`.
- The packaged installer no longer bundles `.env` (Phase 030).
