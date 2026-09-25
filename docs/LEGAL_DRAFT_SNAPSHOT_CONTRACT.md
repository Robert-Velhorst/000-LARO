# Reviewed Legal Draft Snapshot Contract

Current as of 2026-09-20.

## Boundary

Generated legal text is not a browser-only file. LARO requires a case owner to
save and explicitly confirm a complete recipient before generation. Every
recipient edit creates an immutable revision with one of two provenance types:

- `owner_entered`: the owner supplied and confirmed the name and address;
- `evidence_derived`: the owner selected an owned case-evidence revision that
  supports the name and address.

There is no generated `Opponent`, `[Address to verify]`, or equivalent recipient
fallback on a downloadable path.

## Snapshot identity

`gapAnalysis.generateDocument` persists a `legal_draft_snapshots` row before it
returns a preview. A snapshot contains:

- a stable owner-scoped ID, document type, and per-type version;
- the exact UTF-8 download bytes, byte count, and SHA-256 hash;
- the case, source, gap-analysis, owner-input, and recipient revisions;
- the coverage-analysis ID and exact evidence/source-analysis references;
- IDs of the communication-gap, expected-document, and pattern rows used;
- labelled owner-provided fields and an immutable recipient snapshot;
- a pending/reviewed state, reviewer, and review time.

The generation fingerprint is idempotent for the same document type, owner
input, recipient revision, case/source input revision, and derived-analysis
revision. A changed recipient, case fact, source/evidence revision, derived
analysis, or owner amount produces another version. Earlier reviewed versions
remain available as explicitly historical snapshots.

## Review and download

A pending snapshot cannot receive a download link. Review requires the exact
content hash shown in the preview and revalidates the current recipient, case,
source, and analysis revisions. A stale confirmation fails and the owner must
generate a new version.

After review, the API issues a short-lived, one-use, session-bound ticket. The
HTTP route reloads the owner-scoped snapshot, verifies byte length and SHA-256,
writes a mandatory audit event, and serves those exact persisted bytes with
private/no-store and attachment headers. The audit event contains only IDs,
type, version, byte count, and hashes; it does not contain recipient text or
document content.

## Privacy and deletion

Recipient and snapshot tables carry both `userId` and `caseId`. They are
included automatically in the owner data export and in the introspection-driven
case/account erasure paths. Tests cover export, erasure, cross-owner denial,
historical re-download, stale review, source-linked provenance, and byte/hash
integrity.

## Evidence

- Backend: `tests/backend/legalDraftSnapshots.test.ts`
- Acceptance: `tests/acceptance/acceptance.test.ts`
- Repository boundary: `tests/security/productionReadiness.test.ts`
- SQLite migration: `drizzle/0029_reviewed_legal_draft_snapshots.sql`
- Hosted schema migration: `deploy/postgres/migrations/0010_reviewed_legal_draft_snapshots.sql`

These automated checks do not constitute legal review of a generated draft.
