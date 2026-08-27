# Public LARO Architecture

**Status:** Approved direction, pending implementation

## Purpose

This document defines the additive architecture required for LARO to operate as
a public self-service legal case workspace. It preserves the current
local-first Electron product and makes a hosted deployment an explicit,
separately verified operating mode. It does not claim legal, privacy, or
accessibility certification.

## Product Contract

Public LARO enables an outside user to create an account, create and manage
only their own legal cases, connect only their own providers, store and review
their own evidence, and export or erase their own data. Source-grounded
analysis and review-gated outreach retain their current safety boundaries.

The public product must not:

- expose an unsigned portable executable as trusted public software;
- depend on an operator workstation, ngrok tunnel, local filesystem, or
  in-memory process state for normal availability;
- send outreach or contact providers without the existing explicit controls;
- invent analysis findings, timelines, provider connection, or delivery;
- silently migrate local legal data to a hosted service; or
- remove the existing local SQLite/Electron runtime during this programme.

## Deployment Modes

| Mode | Data authority | Supported audience | Availability contract |
| --- | --- | --- | --- |
| `local` | Existing SQLite and local/S3 evidence | Single device or controlled operator | Existing Electron and API-only behavior |
| `hosted` | PostgreSQL and private object storage | Public self-service accounts | Horizontally scalable API, worker, database, object storage, and shared rate limits |

The mode is selected at process startup. A running process may not change
modes. `local` remains the default for existing desktop installations.

## Hosted Topology

```text
Public browser / Microsoft Store desktop client
  -> HTTPS reverse proxy with TLS, request limits, and security headers
  -> LARO API replicas
       -> PostgreSQL (transactional application data)
       -> Redis (rate limits, OAuth state/replay prevention, job coordination)
       -> private S3-compatible object storage (evidence and export blobs)
       -> LARO worker replicas (imports, analysis, retention, deletion queue)
       -> approved external providers (Google, email, optional AI)
```

All managed services must be located in an EU region selected by the operator.
This is an operational deployment requirement, not a claim that any vendor
automatically satisfies every legal obligation.

## Data Boundaries

1. PostgreSQL becomes the hosted transactional authority. Every public data
   row has an account owner. Case-scoped data retains the current ownership and
   team-access checks.
2. Evidence bytes live only in a private bucket/prefix. The API issues a
   short-lived, owner-checked download grant after validating the evidence hash.
3. OAuth refresh tokens remain server-side, encrypted with a hosted key that is
   never returned through an API response. Rotation requires a decrypt/rewrite
   job and rollback-tested recovery procedure.
4. Redis holds only bounded, expiring operational state. It is not the source
   of truth for legal evidence or approvals.
5. Backups are encrypted, include PostgreSQL and object inventory evidence,
   have a tested restore runbook, and follow the configured retention policy.

## Identity and Sessions

The existing email/password account and HTTP-only signed session contract stays
valid. Public hosting adds:

- verified-email lifecycle before provider connection or outbound delivery;
- reset-code attempt and request limits shared across API replicas;
- session revocation that is durable across replicas;
- operator bootstrap that is one-time, auditable, and disabled after use;
- account-level audit events for signup, verification, resets, sessions,
  consent, exports, erasure, and provider connections.

Multi-factor authentication is an account security enhancement, not a silent
requirement imposed on existing local users. It will be introduced as an
opt-in public-account setting after the public base is live.

## Provider Contract

Google Gmail/Drive and approved SMTP/SendGrid remain the initially supported
public providers because they have source-linked and delivery acceptance
evidence. Their OAuth callbacks must use the permanent public HTTPS origin,
not ngrok.

Microsoft, Slack, Trello, Calendar, Contacts, and any other integration remain
visible only as unavailable until all of the following are implemented:

1. encrypted durable token storage;
2. owner-scoped, bounded collection;
3. source-linked evidence persistence;
4. disconnect/revocation behavior;
5. provider-specific tests; and
6. live acceptance against an approved non-production test account.

No public UI must imply that an unavailable connector is connected or can
collect evidence.

## Public Desktop Distribution

The public Windows channel is Microsoft Store submission. The application
build produces an APPX with the exact Partner Center identity. Microsoft signs
the published package after Store certification. The existing portable EXE is
retained for internal/developer use and remains labelled unsigned.

Store readiness requires the following external operator inputs:

- a Partner Center product and exact identity name, publisher, and publisher
  display name;
- public privacy policy, support contact, and product listing copy;
- Store age ratings, data disclosure, and certification responses; and
- a successful submission/published-install acceptance check.

## Security and Operations Requirements

- TLS terminates only at the public reverse proxy; plaintext backend traffic
  remains on a private network.
- Production configuration fails closed for missing secrets, public origin,
  encryption key, database URL, Redis URL, object-store configuration, and
  required provider credentials.
- Rate limits, idempotency claims, OAuth replay protection, scheduled work,
  and emergency stop state are shared/durable rather than process-local.
- Structured logs redact credentials, evidence text, authorization headers,
  cookies, and message bodies. Operational metrics use aggregate counts.
- Health, readiness, migration, backup, restore, queue, object-storage, and
  audit-integrity checks are release gates.
- Alerts cover repeated authentication failures, provider failures, queue
  backlog, failed evidence deletion, backup age, database health, and elevated
  error rate.
- Every public release ships an SBOM, dependency audit evidence, versioned
  migration record, and rollback procedure.

## Compatibility and Migration

The local SQLite schema and Electron package remain supported. Hosted migration
is a separate owner-initiated operation that:

1. validates and backs up the source database and managed evidence;
2. copies owner-scoped data in dependency order into PostgreSQL;
3. verifies row counts, content hashes, audit-chain continuity, and object
   inventory before activation;
4. creates no hosted provider connection until the user explicitly reconnects;
5. retains the source untouched until the owner accepts the migration report;
   and
6. can roll back the hosted import without changing the original local data.

## Definition of Public Readiness

Public release is blocked until each item has direct evidence:

1. hosted integration and end-to-end tests pass against PostgreSQL, Redis, and
   private object storage;
2. a second public test account cannot read, export, alter, download, or send
   from the first account's records;
3. provider acceptance passes on the permanent public domain;
4. restore drill reconstructs a representative account and evidence set in an
   isolated environment;
5. penetration/security review validates public endpoints, tenant isolation,
   OAuth callbacks, rate limits, storage grants, and outbound controls;
6. accessibility tests and manual keyboard/mobile checks pass for every public
   route;
7. privacy, retention, support, incident, and acceptable-use documents have
   an identified legal owner and public URLs;
8. Microsoft Store submission package is built from the release commit and a
   published Store installation is accepted; and
9. monitoring, alerting, on-call ownership, rollback, and incident exercises
   are recorded for the target environment.

Until all items are evidenced, LARO is not described as a completed public
self-service product.
