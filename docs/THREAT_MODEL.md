# Threat Model

Current as of 2026-07-15. Scope: Electron/React, the integrated Express/tRPC API,
SQLite, managed evidence storage, and configured external providers.

## Assets and boundaries

Assets include case PII, evidence bytes and hashes, OAuth credentials, session
secrets, outreach content, the local databases, and release artifacts.

Trust boundaries:

1. sandboxed renderer to validated Electron IPC;
2. loopback HTTP renderer/scanner to authenticated API;
3. API to Google, Microsoft, S3, LLM, and email providers over TLS;
4. release artifact to the end-user machine; unsigned builds have checksum
   integrity but no publisher identity, while Store or Authenticode builds add
   platform trust.

## STRIDE review

| Category | Main threats | Current controls | Residual |
| --- | --- | --- | --- |
| Spoofing | forged sessions or scanner identity | per-install secrets, bcrypt, signed HTTP-only sessions, revocation, and a per-launch main-process scanner proof restricted to loopback | a fully compromised operating-system account remains trusted |
| Tampering | path traversal, altered evidence, invalid transitions | confined storage, filename/key sanitation, SHA-256 provenance, Zod validation, state machines | hashes detect change but do not provide external timestamping |
| Repudiation | disputed user/provider action | owner-scoped audit history, delivery idempotency, response records | local administrators can access the host database |
| Information disclosure | IDOR, token leakage, untrusted navigation | ownership guards, AES-256-GCM OAuth token storage, CSP/security headers, strict origins, sandboxed windows, protocol-checked external links | endpoint security and disk encryption remain operator responsibilities |
| Denial of service | request floods, huge uploads or scans | rate limits, 10 MB API body cap, 7 MB evidence cap, explicit scan folders, bounded workers | in-memory limits are per process |
| Elevation | renderer or user reaches operator functions | context isolation, narrow IPC, admin role gate, fail-closed production secrets | host compromise is outside the application boundary |

## External-action controls

Preparing and approving outreach do not contact anyone. Sending requires case
ownership, an approved state, a real provider, `outreach.send.enabled`, a
released emergency stop, and an unused idempotency record. Provider failure
leaves the action unsent.

## Release controls

Production checks include dependency audit, account-safety and unfinished-work
scans, recovery drill, package/native-module verification, tagged-version
matching, checksum publication for every tagged release, and mandatory
Authenticode verification whenever a signing provider is selected. Unsigned
delivery retains the unknown-publisher social-engineering risk.
