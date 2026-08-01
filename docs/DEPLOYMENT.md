# Deployment & Local Development (Phases 031–035)

Date: 2026-07-06 · Branch `Phase-Imp`

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

- Healthcheck: the container polls `/api/health`.
- Configure via `.env` (see `.env.example`). In production the server refuses to
  start without strong `JWT_SECRET`/`COOKIE_SECRET` (Phase 006).

## Health / readiness / liveness (Phase 035)

| Endpoint | Purpose | Touches DB |
|---|---|---|
| `GET /api/live` | Liveness — process is up | No |
| `GET /api/ready` | Readiness — DB reachable (503 if not) | Yes |
| `GET /api/health` | Summary: status, dbReady, version, timestamp | Yes |

tRPC also exposes `health.check` (public) and `health.readiness` (protected, with
scheduled-job status), and `admin.diagnostics`/`admin.tableCounts` for operators
(Phase 036).

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
Runtime URL/PID metadata is written to ignored `.laro-ngrok.json`. Install
`ngrok/laro-path-policy.yml` on the existing public Agent Endpoint once; the
launcher then verifies `https://<dev-domain>/laro/api/health` on every start.
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

The command stores provider secrets in ignored `.laro-provider-config.json`
using Windows DPAPI `CurrentUser` protection, restricts that file to the current
Windows account and `SYSTEM`, and prints only configured/not-configured status.
The launcher decrypts values in memory and passes them to the container; it does
not copy provider secrets into `.env` or runtime metadata. The protected file is
bound to the Windows user profile and is intentionally excluded from backups and
source control. Re-enter and rotate the credentials after moving to another
machine or Windows account.

For Gmail SMTP, use `smtp.gmail.com`, port `587`, the sending Gmail address, and
a Google app password. A normal Google account password must not be used. LARO
treats SMTP as operational only when host, user, password, and sender are all
present; diagnostics and the sender use the same readiness rule. Spaces copied
from Google's app-password display are removed before protection, and port 587
requires STARTTLS with TLS 1.2 or newer.

## Notes

- The desktop app is packaged separately with `npm run dist:*` (electron-builder).
- Branch and manual Windows builds are unsigned internal artifacts. Store
  certification and paid signing are not active deployment requirements. Tagged
  releases can remain unsigned after the external acceptance gates are approved;
  Windows may warn that the publisher is unknown. Any public route must use the
  owner-approved mark from `build/icon.png`.
- The packaged installer no longer bundles `.env` (Phase 030).
