# Compliance And Legal-Safety Boundaries

Current as of 2026-07-20.

LARO is a legal evidence and preparation workspace. It must not present generated
content as definitive legal advice, lose source provenance, expose another
user's case data, or contact a third party without explicit review and approval.

## Legal-Advice Boundary

- Every authenticated renderer route displays a compact legal-assistance notice.
- Generated legal documents append the Dutch and English `LEGAL_DISCLAIMER` and
  return the disclaimer in the API response.
- The pre-send review includes the mandatory disclaimer and identifies the
  intended recipient before an irreversible provider action is available.
- Help and onboarding expose the same boundary before users depend on analysis.

LARO does not claim that deterministic extraction, optional model output, or a
lawyer match replaces review by a qualified lawyer.

## Evidence Provenance

- Managed evidence retains source metadata, source URI where available, MIME
  type, storage key, and SHA-256 content hash.
- Deterministic and optional provider findings retain source citations. Provider
  observations without literal source support are rejected.
- Timeline events retain an owning evidence identifier and a direct source-open
  action.
- Export packages include a provenance manifest, redacted evidence metadata,
  versioned analyses, and available managed source files.

## External Actions

- Preparing outreach creates reviewable drafts and contacts nobody.
- Approval marks a draft ready and contacts nobody.
- Delivery requires case ownership, Approved state, an enabled feature flag, a
  released emergency stop, a configured provider, and an unsent idempotency
  state. Provider failure cannot produce a Sent state.
- Media and organization discovery remains review-gated before persistence or
  outreach.

## Personal Data

- Authentication, case ownership, team access, and cross-user isolation are
  enforced in protected server procedures.
- OAuth tokens use AES-256-GCM storage; reset and bearer credentials are stored
  as hashes where the legacy Flask runtime requires them.
- Account export and erasure remove owned relational records and managed storage
  objects; storage deletion failure aborts metadata deletion.
- Account exports omit credential fields across every owner table. The retained
  optional usage-analytics preference is enforced per account at the canonical
  writer and participates in export and erasure; unsupported marketing consent
  is neither collected nor presented.
- Bounded retention configuration fails startup when unsafe. The observable
  sweep catches up after startup, runs daily, purges eligible audit history, and
  never deletes business evidence.

## Operational Acceptance

Repository tests prove the local safety contracts but cannot prove consent,
delivery, callback behavior, or provider retention in a target account. Each
provider intended for release needs credential, consent, representative-data,
failure, and audit evidence in `release-acceptance.json`. Missing providers must
remain disabled and visibly unavailable.

The repository includes a DPIA, threat model, retention policy, and operator
runbook. These controls support an operator review; they are not a declaration
of regulatory certification or jurisdiction-specific legal compliance.
