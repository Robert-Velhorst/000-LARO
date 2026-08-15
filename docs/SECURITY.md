# Security

Date: 2026-07-20

## Implemented controls

- The desktop atomically creates and validates durable per-install `JWT_SECRET`
  and `COOKIE_SECRET` values before opening SQLite or importing the server. It
  refuses to replace corrupt existing keys or continue with temporary keys.
  Standalone production startup refuses insecure placeholder secrets.
- Session cookies are HTTP-only, CSRF origins and credentialed CORS are restricted, and session revocation is checked. Scanner JWTs expire after 15 minutes and are authorized only for evidence upload.
- Case-scoped operations use authenticated ownership checks. Lawyer creation is admin-only; lawyer reads, local messages, transactional email tests, and agent controls require authentication.
- OAuth authorization URLs are created by protected tRPC procedures. OAuth flows use encrypted, time-limited state plus PKCE; the callback no longer accepts a caller-supplied user ID. The enabled Google evidence connector requests read-only Gmail/Drive scopes and account email only; delegated mail sending and label writes are excluded.
- OAuth tokens use authenticated AES-256-GCM storage. Callback pages escape provider data and use a nonce-bound script under a route-specific CSP.
- Desktop provider authorization runs in a dedicated sandboxed,
  context-isolated, Node-disabled child window. Top-level navigation is limited
  to the approved provider hosts and LARO's loopback callback, allowing the
  callback Close control to close a LARO-owned window.
- Microsoft evidence collection remains unavailable until a complete collector
  passes owner-scoping and live-account acceptance; configured credentials do
  not make that unfinished surface appear connected.
- Desktop Google disconnect revokes the durable refresh grant before deleting
  owner-scoped encrypted credentials and shared Gmail/Drive connection records.
  Provider or network failure retains the local credential for a safe retry.
- Trello OAuth is disabled until server-side encrypted token persistence exists. No token is reflected into HTML or posted to an arbitrary origin.
- Electron keeps Node integration disabled, enables context isolation and renderer sandboxing, and permits external navigation only to HTTPS, `mailto:`, or loopback HTTP URLs.
- Production startup fails if the database cannot initialize. The API binds to loopback by default; Docker explicitly opts into `0.0.0.0`.
- Provider-backed AI fails closed without `FORGE_API_KEY`. Transactional email never reports delivery when no provider is configured and does not log reset codes in production.
- Evidence storage rejects empty/traversal-only keys, confines local paths, preserves content hashes, and can use the AWS default credential chain instead of blank credentials.
- Destructive evidence operations use an atomic SQLite outbox: metadata deletion and cleanup scheduling commit together, active shared references prevent premature object removal, failed local/S3 deletion remains durably queued and degrades worker health, and evidence, case, and account responses expose pending cleanup instead of reporting complete erasure.
- The Flask runtime has no seeded users. It persists Werkzeug password hashes and SHA-256 digests of bearer/reset tokens in an ignored SQLite auth database; reset tokens are short-lived, single-use, and never returned by the API.
- Flask investor access requires an operator-provisioned password. The dashboard does not fabricate investor metrics when no verified metrics source exists.
- Email account list responses exclude encrypted access and refresh tokens. Sync jobs, global document search, search suggestions, and unified inbox writes are caller-scoped.
- Auto-collection settings, logs, keyword matches, local folders, synchronous
  pulls, and persisted pull jobs all enforce case access before reading or
  mutating data; job-status reads are additionally scoped to the creating user.
- Packaged desktop folders come from the native picker. Standalone servers
  resolve symlinks and reject paths outside the path-delimited
  `LOCAL_SCAN_ROOTS` allowlist; local collection is disabled when it is unset.
- Google status requires authentication, OAuth state is attached to the authenticated Flask session, callback JavaScript uses Jinja's JSON serializer, and return URLs are restricted to local absolute paths.
- Flask recovery binds the ledger, auth database, encrypted OAuth vault, and
  upload inventory. External Flask and vault secrets are verified through salted
  compatibility tags and are never written into the recovery manifest.

## Operational requirements

- Keep standalone secrets and OAuth credentials outside Git and outside desktop artifacts.
- Keep `outreach.send.enabled` off until provider, approval, emergency-stop, ownership, and audit checks are verified in the target environment.
- Run `npm run gate`, `npm run readiness`, `npm audit --omit=dev`, and the Python suite before release.
- Create and validate a complete backup set before migration. Store its database,
  manifest, optional desktop-secret sidecar, and local evidence directory
  together on access-controlled or encrypted media; restore only while writes
  are stopped. S3-backed deployments require independent bucket recovery.
- Create and validate the separate Flask recovery set before Flask maintenance.
  Keep its four members together, retain external `SECRET_KEY` and
  `LARO_TOKEN_ENCRYPTION_KEY` values in independent secret escrow, and restore
  only after stopping Flask and its background workers.
- Default Electron and Flask backup directories are ignored by Git. Keep backup
  sets on access-controlled or encrypted media and never force-add them.
- Configure `LARO_PASSWORD_RESET_URL_TEMPLATE` and SMTP before enabling password reset for non-local users.
- Renderer TypeScript and lint are blocking release gates.

## Rotation

Desktop secrets live in `userData/laro-secrets.json` and derive both session
signatures and OAuth-token encryption. `npm run db:backup` bundles this file with
the database when it is present beside `DATABASE_URL`, then records hashes and a
non-reversible compatibility tag in the backup-set manifest.
Deleting it while LARO is stopped intentionally rotates the local keys on next
launch, invalidates existing sessions, and makes previously encrypted provider
tokens unusable until the accounts are reconnected.

The Flask token vault follows the same recovery principle. A locally generated
Fernet key is bundled inside the protected token-vault snapshot. An environment-
managed `LARO_TOKEN_ENCRYPTION_KEY` remains external and is compatibility-bound.
The Flask `SECRET_KEY` always remains external; `--allow-session-reset` is an
explicit acceptance that existing browser cookie sessions will be invalidated.
