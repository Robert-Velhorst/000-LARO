# Google Drive ingestion contract

Updated: 2026-09-20

LARO has one maintained Google Drive ingestion path. The source selector calls
`autoCollection.listDriveFolders` only to navigate an explicitly selected
owner account. It does not preview provider files or import them directly.
Saving or running Auto-Collection routes selected account/folder IDs through
`pullEvidenceByKeywords`.

## Canonical identity and revisions

Every imported Drive object is an `evidence` row. Its metadata records:

- the selected `driveAccountId` and provider `driveFileId`;
- a canonical `sourceIdentity` composed from provider, account, and file;
- `sourceRevision`, preferring Drive version, then MD5, then modified time;
- a monotonic `revisionNumber` and `previousVersionIds`;
- managed `storageKey`, source MIME details, and SHA-256 content provenance.

The collector loads existing Drive evidence once per selected account. A listed
revision already present in that source identity is an unchanged duplicate and
is not downloaded. A changed revision is stored as new canonical evidence and
links its prior evidence IDs. Different Google accounts never share a source
identity even when Drive file IDs happen to match.

## Outcomes and failure

Provider discovery and downloads use the shared evidence-ingestion item, byte,
concurrency, analysis, and storage-headroom limits. A bounded skip reports a
`partial` outcome; cancellation reports `cancelled`; provider or storage errors
are included in the collection result. The direct tRPC response reports success
only for a completed result with no errors.

Download or persistence failure creates no new evidence revision and leaves all
prior canonical evidence intact. The retired `googleDrive` router,
preview/direct-import controls, legacy coordinator, and live writes to the
parallel `google_drive_files` table are not part of the supported contract.

## Verification

`tests/e2e/googleDriveCanonical.e2e.test.ts` exercises the real tRPC, SQLite,
managed-storage, and controlled Drive boundaries for initial creation,
unchanged revision, changed revision, provider-media failure, and bounded
partial ingestion. Production-readiness source checks prevent the duplicate
router or direct-import UI from being restored accidentally.
