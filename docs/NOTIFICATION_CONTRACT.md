# Notification Contract

Current as of 2026-09-20. The canonical implementation is
`server/notifications.ts`; producers must not insert user-facing notification
rows directly.

## Durable write result

`createNotification()` validates the owner and referenced records, derives the
destination from registered context, and returns one explicit outcome:

- `created`: the notification and optional deduplication key are durable;
- `already-exists`: the same owner/deduplication key is already durable; or
- `failure`: nothing was represented as created. Storage and database failures
  are retryable; invalid input or cross-owner context is not.

The `(userId, dedupKey)` unique index is the deduplication authority. Reminder
jobs do not keep a second completion flag, so a failed insert remains retryable.

## Kinds and destinations

| Kind | Required owned context | Registered destination |
| --- | --- | --- |
| `lawyer_response` | case and a lawyer linked to that case's outreach | `/cases?case=...` |
| `case_status_change` | case | `/cases?case=...` |
| `evidence_uploaded` | evidence belonging to the same owner and case | `/evidence?view=items&case=...&evidence=...` |
| `new_match` | case and a lawyer linked to that case's outreach | `/lawyers/:id` |
| `deadline_reminder` | case | `/cases?case=...` |
| `system_announcement` | no entity context | no action |

Callers cannot supply arbitrary destinations. `shared/notifications.ts` derives
them from typed context and the routes mounted by `DashboardApp`.

## Read boundary

`notifications.list` scopes rows to the authenticated user, batch-validates
current case/evidence/lawyer relationships, and exposes context and metadata
only while those references remain valid. A forged, cross-owner, malformed, or
deleted destination is returned as unavailable with no action URL or entity
identifiers. Legacy rows without a kind remain non-actionable system
announcements.

The renderer uses the stored kind for iconography and presents `View` only for
an available registered destination. Opening an action marks an unread row as
read and performs internal navigation only.

## Verification

- `tests/backend/notificationDurability.test.ts` covers typed records,
  cross-owner and deleted references, concurrent deduplication, and injected
  storage failure followed by reminder retry.
- `tests/browser/rendererAccessibility.spec.ts` covers desktop/mobile typed
  rendering, unavailable destinations, navigation, accessibility, HTTP status,
  console errors, and network failures.
