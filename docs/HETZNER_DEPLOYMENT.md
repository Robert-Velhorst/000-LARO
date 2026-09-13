# Browser and desktop on one Hetzner server

This deployment runs one LARO API process, the React interface, and the existing
SQLite data layer on a persistent server. Browser users and connected desktop
clients use the same server accounts, cases, evidence, and provider connections.
The desktop can also run its original local workspace independently.

The first owner is created with a one-time setup code. The existing standalone
enrollment policy closes registration after that account exists. This is a
controlled installation, not the unfinished PostgreSQL/Redis public signup
programme described in `PUBLIC_PRODUCT_ARCHITECTURE.md`. Do not run multiple
API replicas against this SQLite volume or enable `LARO_RUNTIME_MODE=hosted`.

## Prepare the server

Use an EU Hetzner Linux server with Docker Engine and the Compose plugin. Build
the image on a machine with enough memory for TypeScript (4 GB minimum for the
build, 8 GB recommended), or transfer a previously verified image to the server.
Point the intended domain's DNS records at the server. Open TCP 80 and 443 for
Caddy and restrict SSH to the operator. The API and database have no public port.

Check out the reviewed integration commit, then run:

```sh
node scripts/setup-hetzner.mjs https://laro.example.com
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml config --quiet
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml up -d --build
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml ps
```

Replace the example address with the real domain. Setup creates fresh private
secrets in `.env.hetzner` and refuses to overwrite an existing file. Keep a
protected copy of it: the signing key also protects stored provider tokens.
Caddy obtains and renews the HTTPS certificate, including after server restarts.

Open the HTTPS address, select **Sign up**, and enter the setup code from
`STANDALONE_SIGNUP_TOKEN` in `.env.hetzner`. Sign in with the resulting owner
account from either client. Keep the setup code and passwords out of source
control, screenshots, and logs.

## Connect the desktop

Build the desktop from the same integration commit. Launch it once with the
server address, for example on Windows:

```powershell
& '.\LARO Desktop.exe' --server-url=https://laro.example.com
```

The desktop remembers that server in its user-data directory. It opens the
same interface and uses a separate browser session with the same server account.
It does not launch a second case database in this mode. Close the app before
changing its server. Use `--local` to return to the independent local workspace.

Desktop folder selection and reviewed uploads remain available. Remote uploads
use the signed-in account's ordinary evidence upload authorization; they do not
claim the per-launch local scanner credential. Browser users select files using
the normal upload control. Native filesystem scanning requires the desktop.

## Providers and existing data

Add required provider credentials to `.env.hetzner` and recreate the application
container after a configuration change. Google must authorize the permanent
callback `https://laro.example.com/api/oauth/gmail/callback`. Verify provider
connections with the owner before declaring them operational. Local analysis
does not need a paid model provider. Outreach keeps its existing approval and
send controls.

A new installation starts empty. Do not overwrite it with an existing desktop
database or rotate keys casually. Any migration must first back up the source
database, evidence, and matching encryption keys, then validate a recovery copy.
Provider grants may need reconnecting on the server. Record the owner's data
migration choice before the production cutover.

## Persistence, recovery, and upgrades

Compose fixes the project name to `laro-hetzner`. Named volumes persist the case
database/evidence, application backups, and Caddy certificates. Use the same
project name after moving the checkout. Never use `down --volumes` on the live
installation.

```sh
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml exec -T laro npm run db:readiness
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml exec -T laro npm run db:backup
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml cp laro:/backups ./exported-backups
```

Keep a protected off-server copy of the backups and configuration. A backup on
the same server alone cannot recover from losing that server. Follow
`BACKUP_RESTORE.md` and test restoration in an isolated deployment. Before each
upgrade, record the deployed commit/image, take a backup, and preserve the
previous image. If a migration prevents rollback, restore the matching backup
with its previous image in a recovery environment before switching traffic.

## Acceptance on the real server

Verify `/api/live`, `/api/ready`, HTTPS and certificate validity, deep-route
reloads, and browser console/network errors. Create a case, upload a harmless
document, analyze and export it, then view the same records in the connected
desktop. Check logout and unauthorized access. Restart the application and the
server and confirm the same account, records, files, and HTTPS service return.
Verify a backup restore and any enabled external providers. Local test results
do not substitute for these Hetzner and desktop-device checks.
