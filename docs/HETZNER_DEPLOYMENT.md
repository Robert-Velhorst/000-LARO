# Browser and desktop on one Hetzner server

Updated: 2026-09-23

Implementation commit `ec94985` passed the local final account/lifecycle
container, browser, recovery, fresh-database, vulnerability-scan, and Windows
packaging matrix recorded in
[`FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md`](FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md).
It has not been pushed, published, installed on Hetzner, migrated with the
owner's real workspace, or accepted from a real browser and connected Windows
desktop; follow the target checks below before calling the deployment complete.

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
First inventory existing services, containers, listening ports, and the current
reverse proxy. Point the intended domain's DNS records at the server and add
LARO to that proxy. The API binds only to `127.0.0.1:3187`; set `LARO_BIND_PORT`
to another free port if needed. The database has no public port. Existing
applications keep their ports, storage, and proxy routes.

Check out the reviewed integration commit, then run:

The setup below is for a **fresh** installation. For an existing workspace,
first follow the migration section below; generating replacement keys can make
its saved provider tokens unreadable.

```sh
node scripts/setup-hetzner.mjs https://laro.example.com
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml config --quiet
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml up -d --build
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml ps
```

Replace the example address with the real domain. Setup creates fresh private
secrets in `.env.hetzner` and refuses to overwrite an existing file. Keep a
protected copy of it: the signing key protects stored provider tokens and the
independent `LARO_RECOVERY_KEY` decrypts backup envelopes. Escrow that recovery
credential separately from every exported backup and never paste it into chat.
Configure the existing proxy to serve the LARO domain over HTTPS and forward
HTTP and WebSocket traffic to `127.0.0.1:3187`. A proxy running inside Docker
needs a suitable private network/upstream address instead of its own loopback.
Add only the LARO route, validate the proxy configuration, and reload it without
replacing the other applications' configuration.

Only on a server with no existing TLS proxy and free ports 80/443, enable the
included Caddy service:

```sh
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml --profile standalone-tls up -d
```

Caddy obtains and renews the HTTPS certificate. On a shared server, leave this
profile disabled and use the existing proxy's certificate management.

For a small shared server, run the **Shared browser and desktop deployment**
workflow manually against the reviewed branch. It builds the container on the
CI runner, checks the rendered application inside that container, and exports
the verified image as the `LARO-Shared-Image` artifact. This avoids compiling
TypeScript or installing development dependencies on the live server.
Download and transfer that artifact, verify its checksum, and load it:

```sh
sha256sum --check laro-shared-image.tar.gz.sha256
docker load --input laro-shared-image.tar.gz
```

Set `LARO_IMAGE_TAG` in `.env.hetzner` to the exact commit SHA shown by that
workflow run, then use `up -d --no-build` in place of `up -d --build`. Loading an
image does not itself start the application or replace another container.

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

The handoff's case-neutral Document inbox also accepts a user-selected folder
in either client. This copies selected files to the shared server. Background
local-folder source jobs belong to the local desktop workspace and cannot scan
a Windows path from Hetzner. In connected mode their native picker is disabled;
the inbox Folder control and reviewed case-scanner uploads remain available.
The shared deployment fixes its session cookie name to `laro_session`; separate
local workspaces may retain their own cookie names.

## Providers and existing data

Add required provider credentials to `.env.hetzner` and recreate the application
container after a configuration change. Google must authorize the permanent
callback `https://laro.example.com/api/oauth/gmail/callback`. Verify provider
connections with the owner before declaring them operational. Local analysis
does not need a paid model provider. Outreach keeps its existing approval and
send controls.

### Migrate an existing workspace

The September 2026 milestone requires existing data, not an empty replacement.
The developer handoff contains source code only and is not a workspace backup.

1. Identify the actual active desktop workspace and stop changes to it for the
   final transfer. Preserve an untouched source copy. Create and validate a full
   recovery set with `BACKUP_RESTORE.md`: database, complete managed evidence and
   inbox originals, and matching signing/encryption keys. Retain private provider
   configuration separately. Transfer these through an access-controlled channel,
   never chat, Git, CI artifacts, or a public download.
2. Inspect the manifest and storage mode before choosing restore targets. Restore
   a copy into isolated storage with the same keys, not the final live volumes.
   S3-backed sets have bucket/region compatibility checks; do not silently change
   their storage mode. Run migrations against the copy, compare table counts and
   representative original-file hashes, and verify provider-token decryption
   without initiating sends or external collection.
3. Set `LARO_BACKGROUND_JOBS=false` for the first restored server start. Review
   and pause imported source jobs before enabling workers. Desktop paths and old
   local-folder collection settings are not server paths. Keep their history and
   original bytes, but reselect/upload local files from the connected desktop.
   Review Google grants, callback addresses, schedules, and backup destinations
   with the owner before any automatic collection resumes.
4. Provision the LARO-only volumes and private environment using the **original**
   key material. Validate the restored deployment, then switch only LARO's proxy
   route. Sign in with the existing account rather than creating another owner.
   Check representative cases, inbox documents, evidence downloads, and the same
   records in the desktop client. Take and restore a new off-server recovery set.
5. Preserve the pre-transfer backup, previous runtime, and source workspace until
   owner acceptance. Returning the desktop to `--local` opens its independent
   local data; it does not synchronize later changes back from the shared server.

Local operator test tickets are forced off in the shared Compose configuration.
Provider grants may need reconnecting on the server. A synthetic recovery drill
does not prove that the owner's unavailable backup has migrated successfully.

## Persistence, recovery, and upgrades

Compose fixes the project name to `laro-hetzner`. Named volumes persist the case
database/evidence, application backups, and Caddy certificates. Use the same
project name after moving the checkout. Never use `down --volumes` on the live
installation.

```sh
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml exec -T laro /nodejs/bin/node scripts/run-built-operation.mjs data-readiness
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml exec -T laro /nodejs/bin/node scripts/run-built-operation.mjs backup
docker compose --env-file .env.hetzner -f docker-compose.hetzner.yml cp laro:/backups ./exported-backups
```

The production image is distroless and deliberately contains no shell or npm.
Run compiled maintenance operations through `/nodejs/bin/node` as shown above.

Keep a protected off-server copy of the encrypted payloads and manifests, and a
separate protected escrow copy of `LARO_RECOVERY_KEY`. A backup and its only key
on the same server cannot recover from losing that server. Follow
`BACKUP_RESTORE.md` and test restoration in an isolated deployment. Before each
upgrade, record the deployed commit/image, take a backup, and preserve the
previous image. If a migration prevents rollback, restore the matching backup
with its previous image in a recovery environment before switching traffic.

## Acceptance on the real server

Verify `/api/live`, `/api/ready`, HTTPS and certificate validity, deep-route
reloads, and browser console/network errors. Create a case, upload a harmless
document, analyze and export it, then view the same records in the connected
desktop. Check logout and unauthorized access. Restart only the LARO application
and confirm the same account, records, files, and HTTPS service return. Check
Docker boot enablement and the container restart policy. A full shared-server
reboot requires an owner-approved maintenance window for the other applications.
Verify a backup restore and any enabled external providers. Local test results
do not substitute for these Hetzner and desktop-device checks.
