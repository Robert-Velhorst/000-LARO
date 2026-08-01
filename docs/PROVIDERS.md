# External Provider Status

Date: 2026-08-01

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
connected only after persisted account state confirms OAuth completion. A
disconnect removes the shared Gmail/Drive credential and source connection
records for that owner only after Google confirms revocation. If Google is
unreachable or returns a non-terminal failure, LARO retains the encrypted
credential so the owner can retry instead of silently leaving an active grant.

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
