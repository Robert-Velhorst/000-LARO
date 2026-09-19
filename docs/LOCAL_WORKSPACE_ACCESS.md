# Local Workspace Access

The development preview is not the owner's dossier workspace. Accounts, documents
and Google connections are not copied into it. Do not tell an existing user to
register a second account there to recover access to their real records.

## Open An Existing Local Workspace

Use Node 22 and build the renderer and server. Build the renderer with
`VITE_LARO_IGNORE_DOTENV=true` and without `VITE_API_URL`, so it uses its own origin.
Keep the following configuration outside Git, next to the private database:

```json
{
  "database": "owner.sqlite",
  "storage": "sources",
  "environment": "../installation/.env",
  "port": 5184
}
```

Paths are relative to the configuration file. `environment` must contain the
original `JWT_SECRET` and `COOKIE_SECRET` compatible with that database's encrypted
records. Do not generate replacement keys for an existing database.

```powershell
node scripts/start-local-workspace.mjs --config C:\Private\LARO\workspace.json
```

This access-recovery launcher:

- Requires an existing database, account, source directory and strong keys.
- Creates a consistent SQLite checkpoint before server startup/migrations.
- Binds only to 127.0.0.1 and fails if the selected port is occupied.
- Serves the built application and API on the same origin.
- Keeps sessions stable across restarts and uses a database-specific cookie name
  so another localhost preview cannot overwrite the session.
- Preserves the normal password login. No account is created or reset.
- Disables scheduled processing, retention and deletion jobs; protected operator diagnostics report them
  as disabled. User-initiated operations are still subject to normal permissions.
- Does not load provider credentials, reconnect Google, start a tunnel or expose
  the workspace externally. Stored provider records remain untouched.

The original environment file must be retained securely along with recovery
backups. Each start creates a separate checkpoint; apply an explicit backup
retention policy before using this diagnostic launcher indefinitely.

This is a controlled local access path, not proof of provider readiness, a
Windows installer deployment or completion of automatic dossier processing.

### Windows Start Button

Opening a saved browser URL does not start a stopped local server. For an
existing configured workspace, use the Windows wrapper:

```powershell
powershell.exe -NoProfile -File scripts\Start-LaroWorkspace.ps1 -Config C:\Private\LARO\workspace.json -NodePath C:\Tools\node.exe -ShowErrors
```

It starts the server hidden, waits up to 150 seconds for database readiness,
and then opens the browser. Repeated clicks are serialized and an already running
matching workspace is reused. A port owned by another application is not stopped
or replaced. `-NoBrowser` performs the same startup/readiness check without opening
a browser. Logs are `workspace.stdout.log` and `workspace.stderr.log` beside the
configuration. A desktop shortcut can target this command with absolute paths.

This is an on-demand launcher, not an installed Windows service or automatic
Windows-login startup. Use it again after Windows restarts or the server stops.
The loaded renderer retries a failed session check every ten seconds while visible;
it does not itself have permission to start a Windows process. Existing browser
tabs need one reload after installing this renderer update.

## Optional Local Test Access

The local operator may explicitly set `"testAccess": true` in the private workspace
configuration and restart that workspace. Normal deployments leave this absent or
false. Then run `scripts/Open-LaroTest.ps1` with the same `-Config` and `-NodePath`
arguments as the Windows launcher, or point a desktop shortcut to it.

The operator script requires filesystem access to the existing installation key
and exactly one existing account. It opens a five-minute, single-use link in the
default Windows browser. Choose **Continue without password** to open a one-hour
session for that existing account. These are real documents, not sandbox copies;
normal user-initiated edits remain real writes. Background processing stays off.

Redemption requires explicit local test configuration, a loopback-bound local
runtime, a direct loopback request, the exact local Host/Origin and a signed
purpose-specific ticket. Hosted and forwarded requests are rejected. Consumed
tickets and the `auth.local_test_access` audit entry are persisted atomically, so
reuse is rejected even after a restart. Tickets contain no usable session claim,
are transferred in the URL fragment, and are removed from the address bar after
successful redemption. Until then, refreshing retains the test button; expiry
and single-use enforcement still apply. No password, role or provider permission
is changed. The plain workspace URL does not contain the test button. The Windows
shortcut opens the default browser, not an already open Codex browser tab.

The normal URL still requires a login. To stop testing, log out; to disable new
test access, set `testAccess` to false and restart the local workspace. Never share
test links or commit private workspace configuration. This is not a public
passwordless-login or account-recovery mechanism.

## Isolated Preview

`scripts/preview-local.mjs` requires the main and server builds. It uses its own
database and durable `laro-secrets.json` under `.cache/product-preview`, a separate
session cookie and a visible test-workspace notice. Previously issued temporary
preview sessions require one new login. The preview is not an owner-data entry
point. Never copy private records into it to make a UI test pass.

Existing installations retain the default `laro_session` cookie unless the
operator explicitly sets `LARO_SESSION_COOKIE_NAME`. Local desktop scanners now
use the matching override too. Connected desktops use the shared deployment's
standard `laro_session` cookie instead of their local workspace's cookie name.
