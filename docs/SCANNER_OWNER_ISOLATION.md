# Desktop scanner owner isolation (S1-27 / issue #194)

Updated: 2026-09-23

The auxiliary desktop scanner database is local to each desktop profile and, in
connected mode, each configured server. New scans and file rows record an
immutable account owner and case ID. Scanner IPC resolves the owner from the
current Electron session cookie and checks that the case still belongs to that
owner before returning scan metadata, changing selections, or uploading bytes.
Upload requests retain the original owner's cookie; a subsequent account
switch cannot replace it with the new account's cookie.

The scanner panel and main desktop window invalidate account-bound views when
the session cookie changes. Active scan/upload workers are stopped, old-session
events are suppressed, and local folder preferences are keyed by account. The
former unowned browser-storage folder preference is discarded rather than
assigned to the next account. A 30-day path-retention sweep runs on desktop
startup and daily, with deletion counts in the Electron log.

On the first launch with an old, ownerless `laro-agent.db`, the migration keeps
a redacted quarantine marker for each old scan and deletes its unassignable
file-history rows. It does **not** delete the source files on disk. Back up the
desktop profile before updating if the old scan-history metadata must be kept
for operator review; it cannot safely be resumed under an arbitrary account.

GDPR export and erasure include the auxiliary scanner database. The integrated
desktop server registers a sidecar provider; a connected desktop includes the
local history through owner-checked IPC because the hosted API cannot read that
computer's database. Account-scoped default folder preferences are included in
the UI archive and erased with the account. The server database and desktop
sidecar are separate stores, so erasure is deliberately not claimed to be one
atomic transaction. Backups retain their own configured retention period.

Verification lives in `tests/backend/scannerOwnerAuth.test.ts`,
`scannerOwnerIsolation.test.ts`, `scannerPrivacy.test.ts`, the existing scanner
upload/review and GDPR integration tests, and the account-switch browser tests
in `tests/browser/rendererAccessibility.spec.ts`. Local passing tests do not
prove acceptance on a client's installed desktop or Hetzner deployment. The
integrated exact-commit evidence for implementation commit `ec94985`, including
account switching, retention, export, erasure, packaging, and the maintained
caller audit, is recorded in
[`FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md`](FINAL_ACCOUNT_LIFECYCLE_VERIFICATION.md).
