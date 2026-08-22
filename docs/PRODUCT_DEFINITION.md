# Product Definition

Current as of 2026-07-21.

## Purpose

LARO is a local-first Dutch legal case workspace. It helps a case owner collect
and understand evidence, build a source-linked chronology, identify suitable
support, prepare controlled outreach, record responses, and export an auditable
case package.

LARO assists with organization and preparation. It is not a lawyer and does not
provide definitive legal advice.

## Supported outcomes

| User | Outcome |
| --- | --- |
| Case owner | Move from intake to organized evidence, classification, matching, reviewed outreach, responses, and an exportable case record without losing provenance |
| Operator | See real owned metrics, inspect audit history, stop external actions, validate backups, and diagnose provider readiness |
| Lawyer or outreach recipient | Receive an approved, relevant message through a configured provider with the case context intended for disclosure |

## Safety contract

- Evidence retains its source, managed storage key, and SHA-256 provenance.
- Imported model observations require literal source support and remain
  reviewable suggestions.
- User-owned records are authorization-scoped; case children require case
  ownership.
- Preparing or approving outreach does not send it.
- Delivery requires an approved draft, owner authorization, a configured real
  provider, an enabled feature flag, a released emergency stop, and an unused
  idempotency state.
- Missing providers and unsupported capabilities fail explicitly.
- Demo mode is disabled in production.

## Capability contract

| Capability | Current state |
| --- | --- |
| Account and session management | Implemented with bcrypt, signed cookies/JWTs, revocation, password reset, CSRF/origin controls, and role gates |
| Case intake and ownership | Implemented with owner-scoped draft restore/autosave, persisted creation, and immediate query refresh |
| Gmail and Google Drive intake | Implemented when OAuth credentials and user consent are present |
| Local evidence upload | Implemented with bounded file types/sizes, local or S3 persistence, SHA-256 provenance, and rollback on record failure |
| Desktop folder scanner | Implemented with current-session authentication, an Electron-main-only per-launch proof, explicit folder consent, review and per-file selection, logout-aware upload cancellation, and real owner-scoped storage |
| Document intelligence | Desktop TXT/CSV/HTML/EML/PDF/DOCX extraction plus Dutch/English image OCR, versioned persisted findings, automatic import analysis, and citation-validated optional deep analysis are implemented; legacy Flask analysis remains reviewable before owner-bound migration; scanned PDFs require image conversion before OCR |
| Evidence timeline | Implemented with story, horizontal, and vertical views plus direct source access |
| Lawyer matching | Implemented against persisted lawyer records and case-derived legal fields |
| Media and organization matching | Implemented as reviewable target matching; discovery is not represented as exhaustive |
| Outreach drafting and approval | Implemented with separate prepare, review, approve, reject, and send states |
| Provider delivery | Implemented but disabled by default and conditional on target provider configuration |
| Response and outreach analytics | Implemented from owned persisted records |
| GDPR access and erasure | Implemented |
| Evidence export | Provenance-preserving ZIP is implemented; unavailable formats remain labelled unavailable |

## Production boundary

The repository can produce an internally deployable unsigned Windows build. The
owner has chosen not to pursue Store certification or a recurring certificate,
so public trusted Windows distribution is not currently an accepted deployment
target. Live target-account acceptance is still required for every enabled
external provider.
