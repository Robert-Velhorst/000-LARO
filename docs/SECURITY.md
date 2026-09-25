# Security

Date: 2026-09-20

## Implemented controls

- The desktop atomically creates and validates durable per-install `JWT_SECRET`
  and `COOKIE_SECRET` values before opening SQLite or importing the server. It
  refuses to replace corrupt existing keys or continue with temporary keys.
  Standalone production startup refuses insecure placeholder secrets.
- Session cookies are HTTP-only, CSRF origins and credentialed CORS are
  restricted, and session revocation is checked. Desktop scanner uploads use
  the current browser session plus a per-launch, loopback-only proof that stays
  in Electron main; the session is re-resolved for every upload batch so logout
  stops subsequent uploads.
- Case-scoped operations use authenticated ownership checks. Lawyer creation is admin-only; lawyer reads, local messages, transactional email tests, and agent controls require authentication.
- Notification writes validate the owner plus case/evidence/lawyer relationship
  and derive an internal destination from a closed registry. Reads revalidate
  those relationships in batches and suppress action URLs, metadata, and entity
  IDs for forged, cross-owner, or deleted destinations.
- KvK, Rechtspraak, and KOOP public-source research verifies case ownership
  before provider contact. Every attempt must persist a mandatory audit receipt,
  but that history contains only bounded metadata (source, normalized query,
  retrieval time, count, and completeness), not returned provider content.
  Transport/provider failure retains a null count and cannot be represented as
  an empty search, missing insolvency warning, or absence conclusion.
- OAuth authorization URLs are created by protected tRPC procedures. OAuth flows use encrypted, time-limited state plus PKCE; the callback no longer accepts a caller-supplied user ID. The enabled Google evidence connector requests read-only Gmail/Drive scopes and account email only; delegated mail sending and label writes are excluded.
- OAuth tokens use authenticated AES-256-GCM storage. Callback pages escape provider data and use a nonce-bound script under a route-specific CSP.
- Google Drive folder navigation is read-only source selection. There is no
  separately callable preview/direct-import/sync router: the owner-scoped
  auto-collection service is the sole download path and persists account-bound
  source identity, provider revision, managed storage provenance, and SHA-256
  in canonical evidence.
- Desktop provider authorization runs in a dedicated sandboxed,
  context-isolated, Node-disabled child window. Top-level navigation is limited
  to the approved provider hosts and LARO's loopback callback, allowing the
  callback Close control to close a LARO-owned window.
- Microsoft evidence collection remains unavailable until a complete collector
  passes owner-scoping and live-account acceptance; configured credentials do
  not make that unfinished surface appear connected.
- Google disconnect uses an owner-scoped, versioned pre-action review naming the
  shared credential, Gmail and Drive consequences, scheduled collection, and
  local source-record disposition. Stale review stops before provider contact.
  Confirmed disconnect revokes the durable refresh grant before one transaction
  removes the credential, rewrites only affected schedule references, performs
  final-account source cleanup, and stores the mandatory audit. Provider or
  network failure retains the full shared local state for a safe retry.
- Trello and Telegram are unsupported and have no mounted connector, OAuth
  callback, token input, webhook, download, or import procedure. Historical
  owner-scoped rows remain covered by account erasure.
- Electron keeps Node integration disabled, enables context isolation and renderer sandboxing, and permits external navigation only to HTTPS, `mailto:`, or loopback HTTP URLs.
- Production startup fails if the database cannot initialize. The API binds to loopback by default; Docker explicitly opts into `0.0.0.0`.
- Provider-backed AI fails closed without `FORGE_API_KEY`. Transactional email never reports delivery when no provider is configured and does not log reset codes in production.
- Direct HTTP responses from OAuth, Gmail, KVK, KOOP legislation,
  Rechtspraak, public outreach discovery, SendGrid errors, and signed evidence
  acceptance downloads pass through shared byte admission. Oversized declared
  lengths are rejected and cancellable bodies are stopped before reading;
  undeclared or misleading bodies are rejected as soon as their streamed byte
  count crosses the provider-specific ceiling.
- Evidence storage rejects empty/traversal-only keys, confines local paths, preserves content hashes, and can use the AWS default credential chain instead of blank credentials.
- Evidence-coverage runs persist their exact case/input revision and fail closed:
  changed or unverifiable inputs, an active run, and failed recomputation all
  suppress previously derived gaps and downstream document generation.
- Legal-draft recipients are owner-scoped, explicitly reviewed revisions with
  owner-entered or evidence-linked provenance. Generated drafts persist exact
  bytes and SHA-256 alongside case/source/analysis/recipient revisions. Review
  fails when any current revision changed; only reviewed snapshots receive a
  short-lived one-use download ticket. The server rechecks ownership and byte
  integrity and writes a mandatory metadata-only audit before dispatch.
- Destructive evidence operations use an atomic SQLite outbox: metadata deletion and cleanup scheduling commit together, active shared references prevent premature object removal, failed local/S3 deletion remains durably queued and degrades worker health, and evidence, case, and account responses expose pending cleanup instead of reporting complete erasure.
- The Flask runtime has no seeded users. It persists Werkzeug password hashes and SHA-256 digests of bearer/reset tokens in an ignored SQLite auth database; reset tokens are short-lived, single-use, and never returned by the API.
- Flask investor access requires an operator-provisioned password. The dashboard does not fabricate investor metrics when no verified metrics source exists.
- Email account list responses exclude encrypted access and refresh tokens. Sync jobs, global document search, search suggestions, and unified inbox writes are caller-scoped. Local text search normalizes through `literal-search-v1`, escapes LIKE control characters, never builds a regular expression from user text, and returns only stable completeness reason codes rather than raw database errors.
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
- Create and validate a complete version-4 backup before migration. The database,
  application secrets, and evidence are one authenticated ciphertext; keep its
  separate recovery credential outside the backup target and restore only while
  writes are stopped. S3 versioning remains defense in depth.
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
signatures and OAuth-token encryption. `npm run db:backup` puts this file,
the database, and evidence inside an AES-256-GCM recovery envelope. The separate
`userData/laro-recovery.key` is never included and must be escrowed separately.
Deleting it while LARO is stopped intentionally rotates the local keys on next
launch, invalidates existing sessions, and makes previously encrypted provider
tokens unusable until the accounts are reconnected.

Rotate the recovery key independently: retain the old escrowed key until every
set encrypted by it expires, switch to the new key, then create, validate, and
restore-test a replacement set. Losing the only recovery key is intentionally
unrecoverable and must not trigger silent replacement while encrypted sets exist.

The Flask token vault follows the same recovery principle. A locally generated
Fernet key is bundled inside the protected token-vault snapshot. An environment-
managed `LARO_TOKEN_ENCRYPTION_KEY` remains external and is compatibility-bound.
The Flask `SECRET_KEY` always remains external; `--allow-session-reset` is an
explicit acceptance that existing browser cookie sessions will be invalidated.
