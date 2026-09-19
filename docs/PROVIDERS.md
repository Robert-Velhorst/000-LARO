# External Provider Status

Date: 2026-09-19

| Provider | Purpose | Required configuration | Current status |
|---|---|---|---|
| Google Gmail and Drive | Read-only evidence intake | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, consent | Available; encrypted PKCE OAuth and account-backed live status |
| Microsoft Outlook and OneDrive | Mail/file evidence | not applicable until collection is complete | Unavailable; OAuth primitives exist, but no release-capable evidence collector is mounted |
| Forge-compatible LLM | Provider-backed legal analysis | `FORGE_API_URL`, `FORGE_API_KEY` | Available when configured; otherwise fails closed |
| Local Ollama | Flask deep document reading | loopback `LARO_OLLAMA_*` | Optional; citation-gated local analysis |
| SMTP or SendGrid | Transactional email and approved sending | complete authenticated `SMTP_*`, or `SENDGRID_API_KEY` plus sender | Available when configured; no console success in production |
| AWS S3 | Evidence object storage | bucket and workload/IAM credentials | Optional; real local-disk fallback |
| Telegram | Message evidence | `TELEGRAM_BOT_TOKEN` | Available when configured |
| Trello | Board evidence | API credentials plus secure token persistence | Disabled; secure token persistence is not implemented |
| Slack | Message evidence | not applicable | Unavailable |
| Rechtspraak | Recently published court-decision discovery | public RSS search | Available; structured XML parsing, bounded requests, ECLI metadata, and direct source links |

Google requests only Gmail read, Drive read, and account-email identity scopes.
It does not request Gmail send or label-write access. Outlook OAuth does not
request `Mail.Send`, and the product keeps Microsoft connection unavailable
until a real owner-scoped collector and target-account acceptance exist.

Provider configuration is not connection success. The UI shows Google as
connected only after persisted account state confirms OAuth completion. Gmail
and Drive are capabilities of one account grant, with one disconnect review
that names the account, shared credential, both capabilities, affected scheduled
collection, and owner-scoped source-record disposition. A versioned impact
revision rejects stale confirmation before provider contact. If Google is
unreachable or returns a non-terminal failure, LARO retains the complete local
credential, collection, and source state so the owner can retry without a
partial success.

## OAuth credential lifecycle

`server/providerConnections.ts` is the single owner-scoped lifecycle used by
the callback, renderer, Gmail collection, Drive collection, live acceptance,
disconnect, and account erasure. The renderer has one API surface,
`providerConnections`, with availability, list, begin, disconnect impact, and
confirmed disconnect.
Access and refresh tokens are never returned by that router. The former
`emailAccounts` mutations and the Gmail/Drive enhanced connect/disconnect
aliases were removed; collection jobs cannot manually refresh a grant.

- Callback state is one-time, PKCE-protected, and bound to the initiating
  browser session before code exchange. The provider identity is normalized and
  the encrypted access grant, optional rotated refresh grant, normalized expiry,
  connection state, and mandatory audit event are committed together.
- Expiry values are normalized to 60 seconds through 24 hours (one hour when a
  provider omits or corrupts the value). All collectors request an owner-scoped
  access token from the lifecycle service. Refreshes for the same account are
  single-flighted in-process, and an optimistic stored-grant check prevents a
  stale refresh from overwriting a newer grant.
- A successful refresh atomically stores the new access token, a rotated refresh
  token when supplied, the normalized expiry, and a credential-refresh audit.
  If that local transaction or audit fails after the remote provider responded,
  the result is `refresh_uncertain`; the caller must reconnect rather than assume
  the rotated grant was saved.
- `invalid_grant`, a missing refresh grant, or unreadable stored credentials
  atomically clears the unusable local tokens and moves the connection to
  `reconnect_required`. HTTP 408/429/5xx and transport failures are retryable and
  leave the encrypted connected state unchanged. OAuth-client/configuration
  rejections also leave the stored grant unchanged for operator repair.
- User-initiated disconnect revokes the durable Google refresh grant first. A
  transient revocation failure retains local state for retry; HTTP 400 means the
  grant is already invalid and is a successful terminal result. Local credential
  deletion, affected schedule-reference cleanup, final-account source cleanup,
  and the mandatory audit are one transaction. Other account selections and
  collected documents remain. Shared Gmail/Drive source state is removed only
  after the owner's final Google account is disconnected.
- GDPR erasure uses the same provider revocation adapter before deleting the
  only local grant copy. Remote failure is summarized in the durable erasure
  receipt but cannot block local erasure; the owner may still need to revoke the
  application in the provider account when that summary reports a failure.

Rechtspraak lookup uses the official HTTPS RSS search for published decisions.
Returned entries are discovery leads, not a complete litigation-history register.
LARO keeps the decision date, ECLI, summary, court, and source link together and
does not treat an empty query or a lexical relevance score as a legal conclusion.

For the Windows ngrok API deployment, `scripts/configure-live-providers.ps1`
stores Google and authenticated SMTP secrets with DPAPI `CurrentUser`
protection in an ignored local file. `scripts/start-ngrok-api.ps1` injects those
values into Docker at startup without copying them into `.env`. Configuration
presence is only a prerequisite: it does not satisfy the live acceptance checks
in `release-acceptance.json`.
