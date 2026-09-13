# Windows readiness and acceptance

The maintained application is Electron/React/Express with SQLite and persistent
evidence storage. The legacy Flask application is a migration source, not a
second synchronized workspace.

The configured Windows target is a portable x64 executable. Packaging must use
an Electron-compatible Windows SQLite binding. A successful TypeScript build or
Linux desktop test does not prove that a Windows binary starts correctly.

Before distributing a Windows test build:

1. Run the quality gate and build the renderer, main process and backend.
2. Rebuild SQLite for the selected Electron runtime and verify a real database
   operation under that runtime.
3. Package the executable and test startup, profile isolation, second-instance
   behavior and restart without replacing the profile's encryption secrets.
4. Verify rendered sign-in, cases, evidence uploads/downloads and authorization.
5. Record the artifact checksum and whether it is signed. An unsigned test
   executable is not a trusted-publisher or Store release.

Use a separate test profile for initial evaluation. Do not replace an existing
installation's database or signing/encryption keys. Existing-data acceptance
requires a validated backup and a controlled migration of a copy first.

For a connected desktop, the browser and desktop use the same server account;
the independent local profile is not automatically synchronized to that server.
See [Hetzner deployment and migration](HETZNER_DEPLOYMENT.md).

Private historical device/source observations are not included here. Current
commit-specific build evidence takes precedence over historical test counts.
Google, model quality, owner-device operation and production cutover remain
separate acceptance checks.
