# Critical Path

Current as of 2026-08-14. This document describes the shipped Electron/tRPC
runtime. Provider-backed steps remain conditional on target credentials.

## Canonical Flow

```text
account -> case intake -> evidence -> analysis/classification -> matching
        -> outreach drafts -> human approval -> provider send
        -> response recording -> outcome/analytics -> evidence package
```

## Current Status

| Step | Status | Authoritative evidence |
| --- | --- | --- |
| Account and session | Implemented | `server/routers/index.ts`; `tests/e2e/workflow.e2e.test.ts`; authentication and isolation suites |
| Case intake | Implemented | `server/routers/cases.ts`; acceptance AC1 |
| Evidence ingestion and provenance | Implemented | `server/routers/evidenceFiles.ts`; local/S3 storage with SHA-256; case-authorized persisted keyword-pull jobs with live word/item/ETA progress; file-safety and hardening suites |
| Legal classification | Implemented | `server/classification.ts`; acceptance AC2 |
| Lawyer matching | Implemented | `server/novaDirectory.ts`; official NOvA read-only lookup with source provenance; `server/matching.ts`; controlled adapter tests and live manual probe |
| Outreach preparation | Implemented | `workflow.initiateOutreach` advances the case and prepares idempotent review drafts in one action |
| Human review | Implemented | Pending drafts require explicit approve/reject; approval does not send |
| Provider send | Implemented, gated | Emergency stop, feature flag, ownership, Approved state, configured provider, and idempotency are all required |
| Response recording | Implemented | `workflow.recordResponse` enforces ownership and legal state transitions; no automatic third-party action |
| Outcome and analytics | Implemented | Interested responses move the case to Matched; outreach analytics use owned persisted rows |
| Export package | Implemented | ZIP package and provenance manifest are exercised by backend tests |

The case Timeline workspace progressively exposes source-linked legal events,
source documents, and operational activity. Legal events can be viewed
vertically or horizontally and retain a compact control that opens the owned
source document.

## Safety Invariants

- Starting outreach prepares drafts but contacts nobody.
- Approval marks a draft ready but contacts nobody.
- Sending is disabled by default through `outreach.send.enabled`.
- A provider failure never produces a Sent state.
- Inbound outcomes cannot be recorded against another user's case.
- Recording a decline does not automatically contact another lawyer.
- NOvA receives only selected directory filters, never case prose or the stored client address; unknown lawyer metrics earn no score.

## External Acceptance

Repository tests use injected delivery and Google boundaries and cannot by
themselves prove a target account. The selected production scope completed its
separate owner-controlled acceptance on 2026-08-14: Google consent, Gmail/Drive
root reads, persisted Gmail evidence/source verification, and revocation passed;
a representative Drive-file import remains pending. Outbound SMTP delivered
once, retained its audit record, and blocked duplicate dispatch. Future
credentials or deployment targets must repeat those checks rather than
inheriting this approval.

Run the complete repository proof with:

```powershell
npm run gate
npm run readiness:production
python -m unittest discover -v -p "test_*.py"
```
