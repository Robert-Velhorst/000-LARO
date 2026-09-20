# Evidence ingestion resource contract

LARO applies one resource contract to local-folder collection, Google Drive,
Gmail attachments/messages, browser/manual uploads, the document inbox, and
desktop-scanner uploads.

## Limits

| Resource | Limit |
| --- | ---: |
| File bytes | 7 MiB |
| Selected items per job | 50 |
| Selected bytes per job | 64 MiB |
| Concurrent read/store operations per collection job | 2 |
| Automatic analyses per job | 20 |
| Reserved local-storage headroom after a write | 256 MiB |

Provider discovery limits can be lower. The maintained Google Drive keyword
collector shares the global item and byte budget; it has no separate direct or
folder-import procedure. Additional objects are reported as deferred partial
work rather than silently succeeding.

## Admission and storage

- Local `stat`, Drive metadata, Gmail attachment metadata, browser file size,
  and scanner `Content-Length` are checked before reading or downloading the
  complete object.
- Local and Drive objects stream through a byte-counting, SHA-256 hashing write
  into managed storage. Local writes use a temporary file and atomic rename;
  failed or over-limit streams leave no final object.
- Gmail's attachment API returns base64 JSON rather than a raw byte stream. Its
  declared size is admitted before the provider call, and decoded bytes are
  checked again before storage.
- Browser/inbox batches use an owner/job/item identity. Desktop scanner retries
  are idempotent, while rebinding an item ID to a different byte length fails.
- Unsupported analysis formats remain stored evidence but are not submitted for
  analysis. Supported analysis is capped separately, with excess analysis
  deferred after storage.

## Outcomes and cancellation

Collection results expose `processedItems`, `skippedItems`, `processedBytes`,
`admittedBytes`, analysis count, and non-sensitive source/reason aggregates.
Resource exhaustion produces `partial`; user cancellation produces
`cancelled`. Persisted keyword pulls can be cancelled through
`autoCollection.cancelPullJob`, and cancellation propagates to queued reads and
provider/storage abort signals. Already committed evidence remains available.

The desktop scanner persists skipped counts/bytes and a limit reason with the
scan. Its upload worker remains resumable and sends at most one binary body at a
time, below the global two-operation contract.
