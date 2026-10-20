# Deployment & Local Development

Updated: 2026-09-23 · Candidate branch `milestone3/remediate-roadmap`

## Production target

Hetzner is the target for production deployment. Ngrok is retired and no public
tunnel workflow is supported. See the [deployment target directive](../DEPLOYMENT_TARGET.md)
and the [Hetzner deployment guide](HETZNER_DEPLOYMENT.md) before preparing a
production release. Local development remains loopback-only.
The final account/lifecycle release matrix for implementation commit `ec94985`
is recorded in
[`FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md`](FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md).
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

## Docker — standalone server (Phase 032)

The `Dockerfile` builds and runs the standalone Express/tRPC/SQLite server, i.e.
the same backend the desktop app embeds. The ordinary `docker-compose.yml`
configuration is API-only. The shared Hetzner configuration sets
`LARO_SERVE_WEB=true`, so the same image also serves the React browser interface;
it never ships the Electron desktop shell. SQLite and local evidence persist to
the `/data` volume. Follow
[`HETZNER_DEPLOYMENT.md`](HETZNER_DEPLOYMENT.md) for the shared browser/desktop
path.

```bash
docker compose up --build          # http://localhost:3000
# or:
npm run docker:build && npm run docker:run
```

This plain Compose start is for a local provider-free server and remains
loopback-only. Use the Hetzner deployment guide for hosted services; do not
expose a workstation through a public tunnel.
- Healthcheck: the container polls `/api/ready`.
- Runtime readiness: `npm run readiness:runtime` verifies production secrets,
  SQLite integrity and migrations, evidence-volume read/write, API health and
  version, and fail-closed HAI authentication without shipping development tools.
- The final production image is distroless and has no shell or npm. Execute its
  shipped operational scripts with `/nodejs/bin/node`; npm commands remain for
  the source checkout and build stage only.
- The security workflow builds this actual runtime image, emits a CycloneDX
  SBOM, and rejects every HIGH or CRITICAL Trivy finding. The recorded #201
  reproduction built `laro-server:final-account-ec94985` as image
  `sha256:9049b144a83899b841ee731e997e996337d98436d0f39ede7f714d6b7022f99f`
  with zero findings at that threshold. This is a local image, not a registry or
  server deployment; each pushed commit must repeat the scan because
  vulnerability data and base images change.
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

## Hosted deployment

Use the reviewed Hetzner deployment configuration and the permanent HTTPS
origin recorded for this service. Register OAuth and webhook callbacks against
that exact origin. Do not expose a workstation through a public tunnel.

The Hetzner deployment is not accepted as production until the current revision,
private database and evidence storage, provider configuration, TLS, account
isolation, backups and restore, monitoring, and rollback have passed the gates in
[Production Acceptance](PRODUCTION_ACCEPTANCE.md). See
[Hetzner deployment](HETZNER_DEPLOYMENT.md) and the
[deployment target directive](../DEPLOYMENT_TARGET.md).
## Protected live-provider configuration on Windows

Do not put Google client secrets or SMTP passwords in chat, scripts, or the
project `.env`. Configure them at the operator workstation through hidden
prompts:

```powershell
# Configure either provider separately, or both in one invocation.
.\scripts\configure-live-providers.ps1 -Google -Smtp

# Show configuration booleans only; no secret is decrypted or displayed.
.\scripts\configure-live-providers.ps1 -Status

# Keep the DPAPI-protected configuration local to this Windows account.
# Enter hosted credentials in the approved server-side secret store on Hetzner.
```

The command stores provider secrets in
`%APPDATA%\LARO Desktop\provider-config.json` using Windows DPAPI `CurrentUser`
protection, restricts that file to the current Windows account and `SYSTEM`, and
prints only configured/not-configured status. It migrates an existing ignored
worktree-local `.laro-provider-config.json` into that canonical location. The standalone Electron app decrypts values only in memory. The DPAPI-protected file is local-only and must not be copied to hosted services; enter hosted provider credentials into the approved server-side secret store.
The protected file is bound to the Windows user
profile and is intentionally excluded from backups and source control. Re-enter
and rotate the credentials after moving to another machine or Windows account.
The protected Google record pins the local desktop callback origin to `http://127.0.0.1:8768`; authorize `http://127.0.0.1:8768/api/oauth/gmail/callback` in Google Cloud. For hosted use, configure the permanent Hetzner HTTPS callback explicitly in Google Cloud; the local DPAPI-protected configuration is not portable to the server.

The Docker image includes compiled backup and live-provider acceptance entry
points plus the small runtime dispatcher used by the normal npm commands. This
keeps `npm run db:backup`, `npm run db:validate`, and
`npm run acceptance:providers` operational after development dependencies are
pruned from the image. Hetzner release acceptance runs the lean
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
- The #201 Linux cross-build produced
  `release/1.3.0/LARO Desktop 1.3.0.exe` with SHA-256
  `a51bb2755a978113d145335df03ba7e6ad0fab8b4acf099d042bd3ea0de294e2` and
  passed packaged-native PE/x64 checks for the app, SQLite, and Canvas. This
  structural result does not replace a native Windows launch and scanned-PDF
  OCR acceptance run.
- Branch and manual Windows builds are unsigned internal artifacts. Store
  certification and paid signing are not active deployment requirements. Tagged
  releases can remain unsigned after the external acceptance gates are approved;
  Windows may warn that the publisher is unknown. Any public route must use the
  owner-approved mark from `build/icon.png`.
- The packaged installer no longer bundles `.env` (Phase 030).
