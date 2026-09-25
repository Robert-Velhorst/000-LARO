# Domain Model

Current as of 2026-09-20.

| Entity | Persistence | Ownership | Purpose |
| --- | --- | --- | --- |
| User | `users` | self | Identity, role, session and preferences |
| Case | `cases` | `userId` | Legal matter, classification, urgency and status |
| Evidence | `evidence` / managed storage | `userId` and `caseId` | Source material and provenance |
| Lawyer | `lawyers` | global reference | Directory and matching attributes |
| Outreach | `outreach_status` | through `caseId` | Draft, approval, delivery and response state |
| Timeline | `timeline` and evidence analysis | through case ownership | Source-linked chronology |
| Notification | `notifications` | `userId`; referenced case/evidence context is revalidated | Typed user events with registered internal destinations and atomic deduplication |
| Audit log | `audit_logs` | `userId` or operator scope | Traceable actions |

```text
User 1 -> N Case 1 -> N Evidence
                 1 -> N Outreach N -> 1 Lawyer
                 1 -> N Timeline event
User 1 -> N Notification
User 1 -> N Audit log
```

## Invariants

- Protected procedures derive identity from the verified session, never an
  input user ID.
- Case children cannot be read or changed without case ownership.
- Evidence writes preserve managed storage and a SHA-256 digest.
- Desktop scans require native folder approval and explicit file review.
- A case/lawyer outreach pair is idempotent.
- Outreach cannot skip approval; approval cannot imply delivery.
- Delivery cannot occur while the feature flag or emergency stop blocks it.
- Provider failure cannot produce `Sent`.
- Interested and declined responses follow declared state transitions.
- A notification is created and deduplicated by one durable row; unavailable or
  cross-owner destination context is never returned as an action.

## Critical path

```text
account -> case -> evidence -> analysis/classification -> matching
        -> draft preparation -> human approval -> gated provider send
        -> response -> analytics/outcome -> evidence export
```

Referential drift remains detectable through reconciliation while additional SQL
foreign keys are introduced through reviewed migrations.
