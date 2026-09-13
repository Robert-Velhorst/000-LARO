# Autonomous Dossier Discovery: Required End State

LARO's product roadmap requires it to **discover and build dossiers itself**,
not merely present suggestions that require manually selecting a case
for every document. This remains the product requirement. The explicit-reference
inbox implementation is an initial working path, not a replacement for this scope.

## Required Workflow

1. Inventory the authorized Gmail accounts/selections, Google Drive folders and
   local folders without requiring a pre-existing dossier. Persist per-source
   continuation and per-object outcomes; resume after interruption.
2. Preserve original bytes, provider account/object identity, revisions,
   timestamps and provenance before extraction. Never use import timestamps as
   historical event dates. Preserve items that fail extraction.
3. Read document contents, including supported attachments and scanned material.
   Apply the selected provider and sharing policy. Clearly distinguish local
   deterministic extraction from configured language-model analysis.
4. Discover related situations through the contents: participants, institutions,
   correspondence, case references, subject matter and chronology. A filename,
   one shared person or a legal topic alone is insufficient to merge situations.
   Documents without a shared reference must not be excluded from discovery.
5. Create provisional dossiers and add subsequent relevant documents
   automatically where source-backed evidence supports the association. Allow
   overlapping relationships without inventing causal links. Surface competing
   assignments and contradictions as exceptions, not silent forced matches.
6. Build a source-linked account of who said or did what and when. Explicitly
   separate documented events, party assertions, proposed/future actions and
   unverified interpretations. Existing horizontal, vertical, Gantt, story and
   metro views must consume the same authoritative reconstruction.
7. Derive open action proposals with supporting passages, relevant actor,
   explicit due-date evidence if present, and uncertainty. A mentioned period
   is not automatically a legally verified deadline. Link later execution
   evidence to the action without silently treating a proposal as completed.
8. Keep decisions explainable, auditable and correctable. AI-assisted user
   instructions must be recorded. Offer stricter review as a setting, not as
   an unavoidable confirmation after every import. Automatic organization must
   never authorize outbound messages or other consequential external actions.

## Acceptance Boundary

- Tests must cover unrelated matters involving the same person, repeated generic
  references, multiple cases in one document, documents without reference numbers,
  quoted older correspondence, negation, promised future events, uncertain dates,
  revisions, duplicate source objects, interrupted imports and inaccessible files.
- A controlled pilot must verify actual Gmail, Drive and local source content on
  the intended Windows installation, including source opening, restart and recovery.
- Synthetic fixtures, repository readiness scripts and historical provider
  acceptance records are not proof of current live acceptance.
- No full autonomous-production-readiness claim until this complete path passes.

## Current Working Increment

The desktop inbox accepts uploaded documents and browser-selected folders,
retains originals, applies the existing analysis policy, creates provisional
cases from a unique explicit source reference or a configured language model's
validated, quoted decision, adds matching follow-up documents, and records the
decision and its supporting passages. It reuses the canonical evidence/analysis
tables and source reconstruction. Ambiguous matches remain in the inbox.

The staged semantic route compares the complete document with every supplied
owned case summary, then selects canonical source/context passage IDs for the
proposed filing. Complete comparison coverage is mandatory and preserved in the
decision. Multiple situations, uncertain relations or competing matches stop
automatic filing. Both stages share one deadline and each outgoing request
rechecks authorization after queueing. Up to 1,000 cases are compared exhaustively
in batches of at most 20 within a 32,000-character request limit. The selection
request receives the selected case and compact comparison counts; the complete
comparison is retained in the decision. An oversized individual source or case
still requires review; no source text is silently truncated. It checks literal citations,
the selected provider/sharing policy, competing-case snapshots and transactional
filing. These mechanical checks do not establish the correctness of a model's
interpretation. Real-model quality and large-corpus discovery remain unaccepted.
The [opt-in local-model evaluation](LOCAL_DOSSIER_MODEL_EVALUATION.md) exercises
synthetic sources. Its action/target score does not validate every supporting
signal label or generalize to private sources and larger inventories. Model
quality is still not accepted for unattended use.
Additional deadline diagnostics now separate expired request budgets from invalid
answers and permit bounded operator budgets for slow local models. These runtime
repairs do not change the semantic-quality acceptance requirement.

Gmail, Drive and native local-folder imports now use a persistent, case-neutral
source queue with resumable inventory, per-object outcomes and stored originals.
Analysis is separately queued after originals are committed, with stored-byte
retry, explicit deferred/review/error outcomes, live Google access checks and
owner-scoped repeat inventories. Broad local imports exclude system, hidden,
credential and common development directories. Short storage keys and corrected
PDF raster/OCR handling have regression coverage. This does not establish
whole-PC intake, current Google access or local semantic-model acceptance.
Existing case-specific collectors remain available. Continuous provider change
sync and folder watching are not yet implemented.

The action workspace derives cited proposals from the latest document analyses.
Accept/dismiss/restore decisions are audited; accepted actions retain their source
snapshot and do not acquire an inferred legal deadline. The action workspace also
stores user-assessed supporting/contradicting execution evidence, with exact
passages, version checks, withdrawal/restoration and a preserved source snapshot.
Those assessments neither establish fulfillment independently nor change the
action's completion state. Automatic semantic discovery of execution evidence
and its integration across timeline views are not yet implemented.

An owner can now correct a filed inbox document's dossier with a reason and a
current assignment token. The evidence identity, original bytes, analysis versions
and source-derived chronology are preserved; corrections are separately audited
and reversible by another correction. Existing case actions and their snapshots
are not moved or overwritten. Case summaries and automatic filing rules are not
rewritten from a single correction. AI-issued corrections, multiple simultaneous
case associations and case merging/splitting remain open.

Unfinished: large-corpus discovery, real-model quality validation, AI-assisted
relationship correction, multiple case associations, explicit assertion states across all views, automatic execution-evidence discovery,
continuous synchronization and current real-data/packaged-Windows acceptance. See
[the Windows readiness audit](WINDOWS_READINESS_AUDIT_2026-09-04.md).
