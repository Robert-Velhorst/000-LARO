# LARO: Legal Aid Reach Out

![LARO logo](public/laro-logo.png)

LARO is a local-first legal case workspace for turning scattered documents into
an organized, source-linked case record. It helps a case owner collect evidence,
read and compare documents, reconstruct what happened over time, identify
potential support, prepare outreach, and export an auditable case package.

LARO is designed around one rule: **a conclusion should lead back to the source
that supports it**. Extracted events, summaries, legal observations, and inferred
document relationships remain reviewable suggestions. Raw source documents are
not hidden or discarded.

> [!IMPORTANT]
> LARO is an assistance and preparation tool. It is not a lawyer, does not give
> definitive legal advice, and does not determine the legal truth or likely
> outcome of a case. Generated work must be reviewed by a qualified person.

## Contents

Already have a local account but only see a login screen in the preview? The
development preview has a separate database, not your existing dossiers. See
[Local workspace access](docs/LOCAL_WORKSPACE_ACCESS.md) for the backed-up,
loopback-only entry path using your existing account and encryption keys.

- [LARO at a glance](#laro-at-a-glance)
- [Core principles](#core-principles)
- [How a case moves through LARO](#how-a-case-moves-through-laro)
- [Capabilities](#capabilities)
- [User interface](#user-interface)
- [Product website preview](#product-website-preview)
- [Architecture](#architecture)
- [Installation and quick start](#installation-and-quick-start)
- [Configuration](#configuration)
- [Google and outbound email](#google-and-outbound-email)
- [Measured analysis throughput and quality limits](docs/ANALYSIS_THROUGHPUT_AUDIT.md)
- [API-only and ngrok deployment](#api-only-and-ngrok-deployment)
- [Browser and connected desktop deployment](docs/HETZNER_DEPLOYMENT.md)
- [Security, privacy, and recovery](#security-privacy-and-recovery)
- [Developer guide](#developer-guide)
- [Testing and production readiness](#testing-and-production-readiness)
- [Legacy Flask migration](#legacy-flask-migration)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)
- [Documentation index](#documentation-index)

## LARO at a Glance

### Who It Is For

| Reader | What LARO provides |
| --- | --- |
| A person with a legal matter | One place to organize the case, evidence, chronology, possible lawyers, support organizations, media contacts, and reviewed outreach |
| A legal professional or case worker | Source-linked document analysis, evidence comparisons, case reconstruction, missing-record review, deadlines, obligations, and exportable case material |
| An operator | Provider configuration, health checks, audit history, emergency controls, backups, retention, and controlled deployment |
| A software developer | A React/Electron desktop app, Express/tRPC API, SQLite/Drizzle data layer, deterministic intelligence, provider adapters, tests, and release gates |

### What It Does

- Stores owned cases and their evidence in a structured workspace.
- Imports evidence from uploads, selected local folders, Gmail, and Google Drive
  when those providers are configured.
- Extracts text and builds source-grounded summaries, events, parties, dates,
  amounts, claims, obligations, legal issues, risks, and source spans.
- Answers case questions from completed analyses while preserving references.
- Builds chronological, horizontal, vertical, Gantt, story, and metro-style
  Papertrail views with direct access to source documents.
- Searches and ranks lawyers through the official Dutch NOvA public directory.
- Maintains reviewable directories for media and support organizations.
- Prepares outreach and tracks responses without silently contacting anyone.
- Exports evidence and provenance in reviewable packages.

### What It Does Not Do

- It does not replace a lawyer or establish facts, liability, motive, evidence
  destruction, or a legal outcome.
- It does not treat AI output as confirmed evidence.
- It does not automatically approve or send an external message.
- It does not claim that target discovery is exhaustive.
- It does not provide a trusted, publicly signed Windows installer. The current
  distribution target is an unsigned internal portable build.
- It does not make every configured connector operational. Microsoft collection
  and Trello OAuth remain unavailable until their complete flows are accepted.

## Product Website Preview

The Dutch product page is available at `/product.html` on the same installation
as the application (`/`). It explains the audience, workflow, current limitations,
privacy choices, availability and support route. Public prices are not approved;
there is no checkout or claim that unattended dossier discovery is accepted.
The page is marked `noindex` while it remains a development preview.

For an isolated **developer** preview, after installing dependencies with the
supported Node 22 runtime:

```powershell
npm.cmd run build:server
node scripts/preview-local.mjs
```

Open `http://127.0.0.1:5183/product.html`; the tool is at
`http://127.0.0.1:5183/`. The launcher requires free ports 5183 and 3022. It uses
`.cache/product-preview/preview.sqlite`, separate source storage and no inherited
Google or AI credentials. It refuses dotenv files at the compiled server's
configuration locations. Stop it with Ctrl+C in its terminal. Existing preview
records persist; random development session secrets change on every start, so
sign in again after a restart. Use a separate browser profile when running other
LARO instances on the same hostname: cookies are not isolated by port.

The product page checks the real API every 15 seconds while visible and refreshes
on return to the tab. Reachability does not certify connected sources or analysis
quality. This launcher is not a production service, installer or deployment.
Do not add real legal records to this synthetic-test environment.

Current software acceptance boundaries are recorded in
[Product delivery](docs/PRODUCT_DELIVERY_STATUS.md). Business planning and private
operational records are outside this public build branch. No price, revenue,
private-source accuracy or production-acceptance claim follows from this preview.

## Core Principles

1. **Source before summary.** Evidence retains its origin, content hash, and a
   retrievable managed copy. Findings point to extracted source spans.
2. **Raw evidence remains part of the record.** Analysis adds a review layer; it
   does not replace or exclude the underlying document.
3. **Local-first by default.** Core case work and deterministic analysis do not
   require a paid AI provider. Selecting an optional cloud provider does not send
   documents; full-source processing requires a separate reviewed consent.
4. **Human review before consequence.** Suggestions, timeline corrections,
   shortlists, messages, and exports remain reviewable.
5. **No implicit external action.** Sending requires ownership, exact-message
   approval, an enabled flag, a released emergency stop, a configured provider,
   and an unused dispatch guard.
6. **Unknown stays unknown.** Missing lawyer capacity, availability, performance,
   or provider state receives no invented value.
7. **Fail closed.** Missing credentials, invalid citations, stale approvals,
   unsupported formats, storage failures, and uncertain delivery do not produce
   false success states.
8. **One production data authority.** Electron/Express is authoritative after a
   legacy Flask workspace has been migrated. Bidirectional editing is unsupported.

## How a Case Moves Through LARO

1. **Start with documents or a case.** The Evidence screen opens a neutral
   document inbox. Upload documents or select a folder without creating a case
   first. Alternatively, describe a case in ordinary language using case intake.
2. **Discover and build dossiers.** With automatic analysis and organization
   enabled, LARO reads uploaded documents and can create a provisional dossier
   from a unique explicit case reference or through a configured language model
   that identifies a concrete situation from cited source passages. Related
   follow-up documents can join that dossier with their original and analysis.
   All automatic decisions are recorded. See the exact boundaries below.
3. **Resolve exceptions and connect sources.** Ambiguous or unidentified
   documents remain in the inbox with explanations, source passages, suggestions
   and searchable case selection. **Document sources > Add source** starts a
   case-neutral Gmail or Drive import from an owned connected Google account.
   In the Windows desktop, **Local folder** uses the native folder picker.
   Existing case-specific collectors remain available. Do not assume a whole
   mailbox has been successfully sorted just because an import was started.
4. **Analyze documents.** Supported evidence is extracted locally and turned
   into versioned, source-linked suggestions. Existing stored documents do not
   need to be uploaded again.
5. **Understand the history.** Use the timeline, story, Gantt chart, or metro map
   to inspect who said or did what, when, and in which document.
6. **Identify gaps and track actions.** Review missing records and document
   findings. The case overview stores open and completed actions, with optional
   due dates, reopening, and an audit trail. **Suggested actions** derives
   proposals from cited document obligations automatically. Accept, dismiss,
   or restore a proposal; inspect its exact supporting passages and original
   document through the source button. Acceptance creates an open action,
   not a legally verified obligation or automatically calculated deadline.
   Completeness is not case strength.
7. **Find support.** Search lawyers with official filters and match reviewed
   media or organization targets against the case.
8. **Prepare outreach.** Review the exact recipient, subject, body, disclaimer,
   and content hash before approval.
9. **Send deliberately.** Approval still does not send. A separate send action
   uses the immutable approved message and guarded provider path.
10. **Track and export.** Record responses, inspect analytics, export the case,
    or exercise account and case erasure controls.

## Capabilities

### Case Management

- Owned cases with status, urgency, legal areas, parties, identifiers, claims,
  positions, deadlines, obligations, risks, notes, and audit history.
- Draft autosave and restore during case intake.
- Search, filtering, saved searches, notifications, and activity history.
- Case-scoped checks on documents, analysis, timelines, matching, outreach,
  exports, and destructive actions.
- Case and account data exports.

### Evidence Collection and Provenance

| Source | Current behavior |
| --- | --- |
| Direct upload | Validates type/size, stores real bytes locally or in S3, computes SHA-256, and rolls back if record creation fails |
| Desktop folder | Uses the native folder picker, requires a case, presents files for review, and uploads only selected files |
| Standalone folder | Accepts only paths under operator-configured `LOCAL_SCAN_ROOTS` |
| Gmail | Uses read-only Google OAuth, imports messages/attachments, retains Gmail identity, and supports bounded filtered pulls |
| Google Drive | Uses read-only OAuth, supports explicit account/folder selection, and exports Google-native documents to PDF before analysis |
| Document inbox | Maintained desktop/API: case-neutral uploads and durable Gmail/Drive/native-folder imports, source analysis, reference-based or configured-model dossier discovery, incremental filing, explained exceptions and original downloads |

#### Autonomous Inbox Boundaries

The required end state is autonomous content-based dossier discovery, not a
mandatory manual filing queue. The complete requirement and acceptance boundary
are recorded in [Autonomous Dossier Discovery](docs/AUTONOMOUS_DOSSIER_REQUIREMENTS.md).

- Open **Evidence > Document inbox**. Multiple files and browser-selected folders
  are processed sequentially with per-file failures, original preservation, progress
  and a stop-after-current-document control. Each supported file is limited to 7 MB.
- **Settings > Workflow** controls automatic import analysis, automatic
  dossier discovery, the analysis provider and provider-bound full-source consent.
  New and legacy accounts have no external sharing permission by default. Changing
  the provider or automatic-import setting revokes consent; local deterministic
  analysis does not imply a configured local language model.
- Automatic organization currently recognizes explicit source labels such as
  `zaaknummer`, `dossiernummer`, `kenmerk` and `case reference`, followed by an
  identifier containing letters and numbers (at least six characters). Purely
  numeric references and unrecognized formats cannot use this exact-reference path. Filenames are
  not evidence of a case relationship.
- A single source reference matching exactly one owned case is filed there;
  a new reference can create a **provisional**, unclassified dossier. With a
  language model selected, unmatched references also use content discovery before
  creating a new dossier. Multiple
  source references or matching cases remain unresolved. A shared reference
  is a grouping signal, not proof of a legal relationship or correctness.
- Without a shared reference, a configured language model can propose creation
  or assignment based on the document and the owner's current case summaries.
  Discovery first compares every supplied dossier independently. Missing,
  duplicate or foreign dossier IDs, uncertainty, competing matches and multiple
  independent situations prevent automatic filing. A subsequent call selects exact
  passage IDs supporting the proposed result; LARO resolves their original text.
  Automatic acceptance requires a high-confidence response with at least two
  distinct literal source quotes, including a concrete situation and a participant
  or continuity signal. Assignment also requires distinct quotes from the chosen
  case context. The latter is a summary, not independent proof of events.
  The comparison is preserved with the decision; supporting passages remain
  available in document details. Existing saved quote-based decisions remain readable.
- Selected-provider failures, unsupported quotations, incomplete extraction,
  OCR confidence below 80, ambiguous responses and changed settings/context leave
  the original in the inbox. No fallback to another provider occurs. Cloud
  discovery requires active consent for that exact provider and automatic-import
  state; local Ollama must actually be configured.
  The deterministic `local` option is not a language model.
- Discovery admits at most 1,000 owned cases, compared in groups of at most 20
  within a 32,000-character request limit. Every group sees the complete source;
  no top-match shortlist silently excludes competing dossiers. A source or single
  dossier context that cannot fit still requires review. The full comparison is
  saved; passage selection receives the selected context and comparison counts,
  not a repeated archive of all comparison explanations. Same-owner organization
  is serialized in this process; changes
  during a model call are rechecked before the transaction commits. Source,
  inventory and analysis authorization are also checked immediately before each
  provider dispatch, including after waiting in the shared request queue.
- Discovery defaults to one shared 90-second budget for both model stages. Operators can set
  `LARO_DOSSIER_DISCOVERY_TIMEOUT_SECONDS` to whole seconds from 15 through 600
  for slower models. The same limit applies through the model transport;
  elapsed limits are reported separately from invalid answers. More time does
  not increase the context/token budget or establish matching accuracy.
  Comparison output allowance scales with each group's size, from 2,500 tokens to
  5,632 for 20 dossiers; passage selection retains 2,500 tokens. All groups and
  selection share the same deadline; adding dossiers does not reset the budget.
  Provider context/output capacity and large-inventory quality still need acceptance.
- Literal-quote validation is not proof that the model's interpretation or
  grouping is correct. Provider responses are controlled in automated tests;
  the separate opt-in [local model evaluation](docs/LOCAL_DOSSIER_MODEL_EVALUATION.md)
  exercises real inference on synthetic sources. Accuracy on real documents
  with a real model remains an acceptance requirement.
  A small diagnostic score does not validate every evidence label or real-source
  accuracy. Unattended semantic discovery is not accepted; private installation
  observations are not included in this public build branch.
  Content-term suggestions are review-only, not calibrated probabilities.
- Retrying the same trusted source domain/path/content hash returns the original inbox item. Changed
  bytes are separate records. Filing evidence and its analysis is transactional
  and audited. An already assigned record cannot silently move to another case.
- **Document details > Correct dossier** explicitly moves a filed inbox document
  to another owned dossier. It requires a reason and the current assignment
  version; a stale screen cannot overwrite a later correction. The original,
  evidence identity, analysis versions and source-derived chronology are retained.
  **Correction history** records the old/new dossiers, reason and time. Returning
  to the original dossier is another recorded correction, not erasure of history.
- Existing actions, their source snapshots and manually recorded case-specific
  timeline interpretations stay in the original dossier. An action's source link
  is unavailable while that document belongs elsewhere and becomes available if
  it returns. New action proposals are case-scoped; they cannot overwrite a saved
  decision from the previous dossier. Original case summaries and filing rules
  are not rewritten by this per-document correction.
- Inbox originals survive deletion of the derived case. They remain owned data,
  are included in managed-storage accounting, and are subject to account erasure.
  Download verifies the stored SHA-256. Reanalysis uses current provider settings.
  New inbox storage keys use short document identities rather than original
  filenames, avoiding Windows filename-component limits. Original names remain
  in metadata and downloads; existing stored paths are not rewritten.
  Scanned PDF viewport dimensions are conservatively rounded for pixel limits;
  short embedded headers/page numbers no longer suppress recognized OCR text.
  OCR confidence below 80 prevents automatic reference-based filing as well as
  semantic discovery. An owner can still explicitly resolve an assignment.
- Browser file/folder uploads remain page-driven: closing the screen stops
  subsequent files; originals already uploaded remain available. The separate
  **Document sources** workflow is a durable background queue and does not
  depend on keeping that screen open.
- Automatic folder watching, continuous Google change synchronization,
  large-corpus clustering, AI-assisted dossier correction, multi-dossier associations and automatic
  execution-evidence discovery remain follow-on work, not completed capabilities.

#### Source-Backed Action Proposals

The case overview derives proposals from the latest owned document analyses,
with ten documents per page and progressively revealed results. This reuses
existing cited findings; it does not make an additional model request. Missing
citations or unreadable analyses produce warnings rather than unsupported actions.

Acceptance, dismissal and restoration are recorded. Acceptance is idempotent and
stores the original source identity, SHA-256, quoted passages and uncertainties.
The **Action source** disclosure retains that snapshot if later analysis changes;
if the canonical evidence is deleted, the document link becomes unavailable.
Mentioned people are not automatically responsible parties, and mentioned dates
or relative periods are not verified legal deadlines. Accepted actions start
without a due date unless a user explicitly supplies one. Completing an action
records a user decision; it does not prove execution from later documents.

**Execution evidence** on each action records supporting or contradicting
passages from analyzed documents in the same dossier. Select the document,
passages, relationship and assessment. Source inventories, passages and saved
links are paginated. A changed analysis invalidates an older selection before
saving. The link stores the exact quotations and source/analysis fingerprints;
later reanalysis cannot silently rewrite the assessment.

Links can be withdrawn and restored with an audit trail. Retrying a save cannot
duplicate the same assessment or revive a withdrawn one. If the document is
removed, its recorded passages remain but its source button is unavailable.
These are explicitly **user assessments**, not independently verified facts.
Adding supporting evidence does not complete an action, and adding contradictory
evidence does not silently reopen it. Automatic detection of later execution
evidence and its integration across all timeline views remain unfinished.

#### Durable Document Sources

Choose the source, not a dossier. Source imports save originals to the neutral
inbox and apply the current automatic-analysis and dossier-discovery preferences.
Disabling automatic analysis keeps imported originals available for later processing.

- **Gmail:** select an owned connected account. The default includes all messages
  except spam/trash; optional query and spam/trash controls narrow or expand that
  scope. Every returned result page is queued durably. Original RFC822 messages
  and supported attachments are retained separately with account/message/part
  identity and observed history ID. Draft labels remain part of provenance; a
  draft is not proof that a message was sent. History changes during a download
  cause an explicit failure instead of associating bytes with stale metadata.
- **Drive:** select the connected account and optionally a folder ID. No folder
  means files accessible through the account's user corpus. A selected folder is
  traversed recursively. Pagination is persisted; an incomplete provider search
  is a visible error. Supported native Google documents are exported as PDF;
  the exported bytes and original Google MIME type are retained, not an editable
  native-file backup. Before/after version checks reject changed downloads.
- **Local folders:** available through the trusted Windows desktop folder picker
  when its API runs locally. Files are discovered without a filename keyword
  filter. Descendant symlinks/junctions are not followed. Folder/file changes
  during enumeration or reading fail visibly. A normal browser cannot submit an
  arbitrary server filesystem path; browser-selected uploads remain available.
  Broad imports exclude hidden directories, AppData, Windows/program directories,
  common dependency/cache directories, the Codex workspace directory and common
  credential filenames. Excluded entries have visible outcomes; their descendants
  are not traversed. Inaccessible individual entries do not discard the whole page.
  These exclusions are not a guarantee that every remaining document is legal or
  non-sensitive; relevance still depends on its contents.
- **Progress and recovery:** source jobs, page/folder cursors, per-document work,
  errors and leases are persisted in SQLite. Startup and a 15-second scheduler
  resume unfinished running jobs; live leases are not stolen. Pause finishes the
  current unit. Saving an original commits a separate durable analysis work item.
  Analysis failures retry the stored bytes without redownloading the provider
  object. Disabled automatic analysis is deferred, not claimed as completed.
  The interface distinguishes discovered, saved, analyzed, filed, deferred and
  attention-needed outcomes. **Retry unfinished processing** retries failures and
  unresolved decisions; **Check source for new or changed files** repeats a granted
  inventory with content-hash deduplication and separate changed versions.
  Repeated cursors are reported as incomplete, not silently exhausted inventory.
  Expired provider cursors or changed directory snapshots may require a new
  source import. This is an on-demand inventory, not a frozen whole-account
  snapshot or continuous synchronization service.
- **Checked exclusions:** source intake records the rule, check time and observed
  facts before a safety exclusion is marked as skipped. Unknown formats, empty
  files and files above the size limit need review; these are not findings of
  legal irrelevance. Format checks use filename or provider metadata, not a
  content verdict. **Review exclusions** shows the recorded facts and a per-item
  recheck action. Older skips without a check remain explicitly unverified.
  Rechecking uses the same access and size protections. It does not unpause a
  paused source, delete originals, or silently approve an exclusion. Resuming a
  pause preserves existing review decisions; retrying a completed job is separate.
- **Failure explanations:** each source shows its three latest failures without
  expanding its details, with file name, stage, time, cause, recovery guidance
  and whether import was confirmed. **View all failures** filters the complete
  paginated list. Known file, parser, resource and provider errors retain a safe
  cause category; sensitive raw exceptions are not exposed. Older failures whose
  cause was not recorded are not retrospectively diagnosed or labelled repaired.
- **Fast local preselection:** queued local files are skimmed in bounded batches
  of up to 128 with eight readers. Text samples cover at most 24 KiB per file,
  from the start, middle and end. Legal text signals get priority; uncertain
  documents and opaque PDFs/images remain candidates for extraction/OCR.
  Software directory context plus a conventional asset name or sampled code
  syntax can defer an item for review, never establish irrelevance. **Analyze
  anyway** explicitly includes a deferred item, with an audit entry. Existing
  safety boundaries and import limits still apply. Changed versions are checked
  again. Inventory and import take precedence over heavy analysis in the shared
  queue; an analysis already in flight is not interrupted. Google sources retain
  their normal provider workflow; remote byte throughput is not guaranteed.
  See [Fast Screening and Measurements](docs/FAST_SOURCE_SCREENING.md) for limits
  and reproducible benchmarks. The UI separates represented file sizes from
  bytes actually sampled. This is not a full-content relevance classifier.
- **Connection check:** **Check Google access** makes an authenticated profile
  request to the selected service and verifies account identity. A stored
  `connected` label alone is not current access proof. No document is downloaded
  by this check. See Google's [Gmail profile API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
  and [Drive about API](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get).
- **Bounded operator import:** `npx tsx scripts/import-local-source.ts` prints help
  without starting anything. An explicit run requires an existing database,
  storage directory, owner ID and granted root or resumable job. It accepts step/
  elapsed-time limits, import/analysis phase selection and targeted work IDs.
  Back up first. This path refuses cloud analysis and external evidence storage;
  limits apply between work items. It does not create a user or connect Google.
- **Limits:** supported analysis formats and the 7 MB per-document limit still
  apply. Unsupported/oversized local files and attachments are reported as skipped;
  oversized responses or incomplete downloads fail visibly. Directory inventory
  pages inspect at most 250,000 names and queue at most 100 per page. Discovered,
  imported, skipped, failed and pending counts are separate. No whole-source ETA
  or final percentage is claimed while discovery remains incomplete.
- **Privacy:** existing encrypted OAuth tokens are reused; source jobs contain no
  copied tokens. Owner authorization is enforced for starting/viewing/controlling
  jobs. Job/work records participate in account export and erasure. Nothing in
  this workflow sends outreach messages. An import marked completed means its
  inventory work finished, not that every analysis or dossier decision is correct.

Controlled HTTP tests exercise the Google routes without accessing a private
mailbox. Real-account consent/scope acceptance, local-model quality, large-corpus
behavior and a packaged Windows folder-picker run remain release gates.

Keyword pulls are persisted jobs rather than page-bound tasks. Their state can
survive navigation or reload and includes source phase, reviewed items,
extracted words and characters, elapsed time, percentage, ETA, result, and
failure detail.

Gmail keyword searches follow result pages, deduplicate message IDs, and are
bounded to 1,000 messages and 100 search pages per account per pull. A remaining
page, repeated cursor, or failed page is reported as partial collection, not
successfully exhausted mail. Narrow the date range or keywords to collect the
remainder. Local keyword scans match **filenames**, not document contents; they
report partial scans at the 500-file / six-level limits. LARO's managed storage
is excluded from those scans. Repeated pulls compare source path and content
hash, preserving changed file versions without replacing previously stored bytes.

Managed local files open through owner-checked, short-lived signed URLs. The
server verifies the stored hash and does not expose a filesystem path. S3-backed
evidence uses provider-signed URLs.

Document reconstruction does not use import or filesystem modification times as
historical dates. Undated documents remain undated. Shared Gmail threads and
subject-only attachment matches are suggestions, not proven replies or causation;
provider identity matching respects the recorded account.

The current Windows-use assessment and remaining workflow gates are recorded in
[Windows readiness audit](docs/WINDOWS_READINESS_AUDIT_2026-09-04.md).

Supported desktop analysis inputs:

- TXT, CSV, HTML, and EML
- PDF and DOCX
- JPEG, PNG, GIF, WebP, and BMP through Dutch/English OCR

PDF extraction reads embedded text first. Pages with too little readable text
are rendered and passed through Dutch/English OCR, then merged back into the
page-ordered result. OCR quality still depends on scan quality and layout.

### Document Intelligence

The maintained desktop runtime performs deterministic extraction first. It can
retain summaries, document types, parties, contacts, dates, amounts, legal
references, claims, positions, obligations, deadlines, risks, legal issues,
chronology, events, contradictions, and literal source spans.

Optional provider enrichment is accepted only when every retained observation
cites an extracted source segment belonging to that document. Unknown or
uncited findings are discarded. Cache entries bind to the source hash, analysis
version, provider, and model, so a changed input triggers fresh analysis.

The case question interface searches completed analyses. A valid answer keeps
document IDs and source controls. If an optional model is unavailable or returns
invalid citations, LARO falls back to deterministic matches rather than
inventing an answer.

### Timelines, Gantt, and Papertrail

LARO offers several views over the same evidence:

- a neutral chronological story grouped into date-ordered phases;
- source-linked legal events in horizontal or vertical orientation;
- a Gantt-style view for dated work, deadlines, and activity;
- source-document chronology and operational case activity;
- an accessible chronological list;
- a metro-style reconstruction inspired by Paper-trail Visualizer.

In the metro map, documents are stations and event categories are route lines.
Solid directional links come from provider metadata or literal document
references. Dashed links are bounded similarity suggestions based on shared
parties, issues, terms, route, and chronology. They include a basis and
confidence and are not proof of influence or causation.

Users can filter routes, change orientation, zoom, trace a station backward or
forward, focus on an analyzed participant or topic, inspect source-derived
actions, and open the document. Natural-language corrections are audited
overlays; source evidence remains immutable.

Documents > Timeline opens with individual chronological events, showing the
date, actor when available, event text, source access and a **Correct** action.
Search and incremental display keep long timelines manageable. The document
map, vertical map, document list and Gantt remain separate selectable views;
relationship summaries and interpretation notes are collapsed initially.
Document-map positions use the earliest recorded event, which may be a
background date rather than the issue date of a letter. Event dates remain
separate in the default event view; extracted text is not automatically verified fact.

The event editor accepts an exact date, actor, title, description and mandatory
reason without needing a language model. Corrections are owner-scoped overlays:
the stored source and original analysis are not rewritten. History exposes
before/after values, timestamp and reason. Invalid calendar dates, colliding
events and stale editing snapshots are rejected. Natural-language editing
remains under the advanced assistant section and requires a configured provider.
Regression checks: `tests/backend/manualTimelineCorrection.test.ts` and
`node tests/browser/workspaceAccess.mjs --timeline` (after building the server
and renderer; disposable data only).

### Lawyer Matching

- Queries the official NOvA public lawyer finder from the case workspace.
- Supports official legal area, city/postcode, radius, specialization
  association, and financed-legal-aid filters.
- Sends filter terms, not the case narrative or stored client address.
- Retains official profile/source provenance.
- Ranks with case-derived legal fields and only available data.
- Does not invent capacity, availability, performance, or quality.

Matching is decision support, not an endorsement or availability guarantee.

### Media and Organization Matching

The Outreach workspace includes owner-scoped directories for media programs,
newsrooms, journalists, advocacy groups, support organizations, associations,
and relevant lobbies.

Candidates can be entered manually or found through bounded public searches.
Discovery sends canonical legal-area queries, never private case prose. New
candidates start pending, are deduplicated, and require review before case
matching. Automatic mode may build a shortlist; it never sends a message.

This is a curated review aid, not a comprehensive or continuously verified
database of every possible target on the internet.

### Outreach and Analytics

```text
PendingApproval -> Approved -> Dispatching -> Sent
        |             |             |
        +-> Rejected  +-> Rejected   +-> Approved after confirmed non-delivery
```

- Drafts can be reviewed individually or as a batch.
- Historical `automatic` mode means draft preparation only. Human approval is
  still required.
- Approval hashes outreach ID, case ID, recipient, subject, complete body, and
  disclaimer. Stale or modified content requires a new review.
- Dispatch claims a message atomically before provider contact, preventing
  duplicate sends and send/reject races.
- Provider exceptions remain uncertain instead of being silently retried. An
  operator verifies provider activity and records delivered or not delivered.
- `outreach.send.enabled` is off by default. The emergency stop overrides it.
- Analytics use owned records for prepared, approved, sent, responses, interest,
  declines, follow-ups, progress, and response rates.

### Export, Privacy, and Erasure

- Case-scoped CSV evidence index.
- ZIP package with available source bytes, provenance, analyses, and manifest.
- Case/account data export without credential-shaped fields.
- Case/account erasure with managed-storage deletion tracking and retry.
- Shared-object retention while another record still references it.
- Bounded audit and backup retention.

PDF evidence-package export is not implemented and remains labelled unavailable.

## User Interface

The interface uses progressive disclosure: ordinary tasks appear first, while
advanced analysis and operational controls remain available without crowding
the primary workflow.

| Area | Purpose |
| --- | --- |
| Home | Owned case overview, activity, and next actions |
| Cases | Create, filter, open, update, export, or erase a case |
| Case command center | Evidence, analysis, timelines, gaps, progress, outreach, communications, and exports |
| Evidence | Upload, collect, search, filter, score, compare, validate, and export |
| Analysis | Analyze pending documents, inspect findings, and ask grounded questions |
| Timeline | Legal events, documents, activity, story, Gantt, and Papertrail reconstruction |
| Lawyers | Directory, official filters, comparison, and profiles |
| Outreach | Overview analytics plus Lawyers, Media, and Organizations |
| Messages and Email | Persisted communications and configured account workflows |
| Settings | Account, language, workflow, analysis provider, integrations, and HAI |
| Privacy | Data export, privacy preferences, and account erasure |
| Admin | Health, invariants, flags, retention, emergency stop, and uncertain dispatches |
| Help | Guidance, error catalog, and legal boundary |

The shipped dashboard supports Dutch and English for authentication, navigation,
legal safety messaging, and the scanner. Source and user text retain their
original language.

## Architecture

```text
Electron main process
  -> creates/loads installation secrets
  -> opens and migrates SQLite
  -> starts Express/tRPC on loopback
  -> loads the React renderer
  -> provides narrow native IPC

React renderer -> /api/trpc with an HTTP-only session

Express/tRPC server
  -> enforces authentication, roles, ownership, limits, and state machines
  -> reads/writes SQLite through Drizzle
  -> stores evidence locally or in S3
  -> owns provider credentials and external calls
```

| Layer | Technology | Source |
| --- | --- | --- |
| Desktop shell | Electron 43 | `src-main/` |
| Interface | React 18, Vite 8, Tailwind, Radix UI, TanStack Query | `src/renderer/` |
| API | Express, tRPC, Zod | `server/` |
| Persistence | SQLite, better-sqlite3, Drizzle | `server/schema.ts`, `drizzle/` |
| Evidence storage | Confined local storage or AWS S3 | server storage modules |
| Extraction | pdf-parse, Mammoth, Cheerio, Tesseract.js, local parsers | analysis modules |
| Legacy source | Flask, SQLAlchemy, local encrypted vault | `app.py`, `legal_ledger.py`, `frontend/` |

### Deployment Modes

| Mode | Includes | Intended use |
| --- | --- | --- |
| Electron desktop | UI, API, database, native picker, local provider config | Primary local workspace |
| API-only Docker | Express/tRPC, SQLite/evidence volumes, operations | Controlled remote/API integration |
| Legacy Flask | Old command center and ledger | Offline review and one-way migration |

Docker does not include Electron or Flask. The API-only ngrok deployment does
not publish the Electron interface.

For a persistent server shared by the browser and desktop, use the
[Hetzner deployment guide](docs/HETZNER_DEPLOYMENT.md). `LARO_SERVE_WEB=true`
serves the built React interface while retaining standalone owner enrollment.
Launch the desktop with `--server-url=https://your-laro-domain` to use that
server's account and data. The original local workspace remains selectable
with `--local`.

### Data and Ownership

- `laro-server.sqlite` is the maintained application database.
- `laro-agent.db` stores scanner progress/review state.
- Evidence lives under Electron user data, in Docker volumes, or in S3.
- Owner rows carry `userId`; case children pass `assertCaseOwnership`.
- Lawyers are global reference data; private matches/outreach are owner-scoped.
- Media and organization directories are owner-scoped.
- Persisted OAuth tokens stay server-side, encrypted, and absent from API
  responses. Trello and Telegram tokens are not persisted and are accepted only
  in bounded POST bodies for explicit provider operations.
- SQLite uses WAL, foreign-key enforcement, migrations, a busy timeout, and
  additional relationship guards for historical tables.

## Installation and Quick Start

### Requirements

- Windows 10/11 for the primary desktop and packaging workflow.
- Node.js `>=22.12 <23` and npm.
- Python 3.11+ only for legacy Flask review, migration, and Python tests.
- C++ build tools only if npm cannot obtain a native SQLite binary.
- Optional Docker Desktop and provider credentials.

### Desktop Development

```powershell
npm ci
npm run setup
npm run doctor
npm run dev
```

`npm run setup` creates `.env` from `.env.example` only when absent. It never
overwrites existing configuration.

```powershell
npm run dev:server      # Express/tRPC only
npm run dev:renderer    # Vite renderer only
npm run build           # all production builds
npm run dist:win        # unsigned Windows portable package
```

Packaged desktop generates durable per-install secrets under Electron user data.
A standalone server requires strong `JWT_SECRET` and `COOKIE_SECRET` values.

### First Account

- Packaged desktop signup creates a local owner through the UI.
- API-only deployment requires a one-time 32-256 character
  `STANDALONE_SIGNUP_TOKEN`; the first account becomes administrator.
- Standalone enrollment closes after the first owner exists.

Current Windows artifacts are unsigned and intended for internal distribution
after checksum verification. Windows may show an unknown-publisher warning.

## Configuration

Copy `.env.example` to `.env` and set only what the runtime needs. Never commit
secrets, databases, token vaults, or evidence.

| Area | Important variables |
| --- | --- |
| Runtime | `NODE_ENV`, `HOST`, `PORT`, `SERVER_ONLY`, `API_BODY_LIMIT` |
| Auth | `JWT_SECRET`, `COOKIE_SECRET`, `STANDALONE_SIGNUP_TOKEN`, `ALLOWED_ORIGINS` |
| Public path | `PUBLIC_PATH_PREFIX`, `LARO_PUBLIC_BASE_URL`, `LARO_PUBLIC_ORIGIN`, `LARO_PUBLIC_PATH_PREFIX` |
| Data | `DATABASE_URL`, `LOCAL_STORAGE_DIR`, `LOCAL_SCAN_ROOTS`, `AWS_S3_*` |
| Backups | `LARO_BACKUP_HOST_DIRECTORY`, destination kind, retention, and maximum age |
| Audit | `AUDIT_RETENTION_DAYS` (30-3650) |
| Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE_URL`, legacy `GOOGLE_REDIRECT_URI` |
| Email | `SENDGRID_API_KEY`, `EMAIL_FROM`, or `SMTP_*` |
| Desktop AI | Provider keys and matching `LARO_*_MODEL` values |
| Legacy Flask | `LARO_FLASK_PORT`, `LARO_HOST`, `SECRET_KEY`, ledger/upload/auth/token variables |
| Legacy Ollama | `LARO_ANALYSIS_PROVIDER`, loopback base URL, model, timeout, and batch size |

### Analysis Providers

Local deterministic analysis is the default and needs no API key. The owner can
select one configured provider in **Settings > Workflow**. Selecting or configuring
an external provider does not authorize document transmission. The owner must review
the named provider, full-document scope, and current automatic-import implication,
then grant consent explicitly. Consent records the actor and timestamp, can be
revoked immediately, and is invalidated by provider or automatic-import changes.

| Provider | Credential | Model override |
| --- | --- | --- |
| Forge | `FORGE_API_KEY`, optional `FORGE_API_URL` | `LARO_FORGE_MODEL` |
| OpenAI | `OPENAI_API_KEY` | `LARO_OPENAI_MODEL` |
| Anthropic | `ANTHROPIC_API_KEY` | `LARO_ANTHROPIC_MODEL` |
| Google Gemini | `GOOGLE_GEMINI_API_KEY` | `LARO_GOOGLE_MODEL` |
| DeepSeek | `DEEPSEEK_API_KEY` | `LARO_DEEPSEEK_MODEL` |
| Groq | `GROQ_API_KEY` | `LARO_GROQ_MODEL` |
| Together | `TOGETHER_API_KEY` | `LARO_TOGETHER_MODEL` |

Credentials make a provider available; they do not prove live acceptance.

### Connector Status

| Connector | State |
| --- | --- |
| Gmail and Drive | Implemented with read-only Google OAuth |
| NOvA lawyer finder | Implemented through the official public directory |
| SMTP and SendGrid | Implemented; sending disabled by default |
| AWS S3 | Optional managed evidence storage |
| HAI | Owner-bound, revocable, read-only feed |
| KvK public records | Supported official open-data contract |
| Telegram | Bounded bot/API and desktop-export import paths are available when configured; bot history is limited by Telegram and target verification is still required |
| Microsoft/OneDrive/Outlook | Reserved configuration; collection unavailable |
| Trello OAuth | Unavailable until durable token lifecycle is complete |
| Google Calendar/Contacts | Not implemented as LARO evidence connectors |

## Google and Outbound Email

The Google connector requests Gmail read, Drive read, and account-email identity.
It does not request send, delete, calendar, or contacts access.

Desktop loopback callback:

```text
http://127.0.0.1:8768/api/oauth/gmail/callback
```

Gateway callback:

```text
https://<gateway-domain>/<prefix>/api/oauth/gmail/callback
```

After consent, status updates without page reload. Disconnect revokes the Google
grant before deleting local encrypted credentials. If revocation fails, the
credential remains for retry and no false success is recorded.

### Multiple Google Accounts

In **Documents > Connections > Google accounts**, choose **Add Google account**
for each additional email address. Each account has its own encrypted credentials;
reconnecting an existing address updates only that connection. Google consent
still has to be completed for each account. The account list refreshes automatically.
"Connection saved" reports a stored grant, not proof that a current provider call
will succeed; expired or revoked grants may require reconnection.

For each case, **Auto-Collection Settings > Sources** selects the Gmail accounts
to search and the Drive folders to search under each Google account. **Browse
Google Drive** lets you switch accounts; adding folders from a second account
retains the first selection. **Select all of My Drive** explicitly selects that
account's My Drive tree, not every shared drive in a Workspace organization.
Removing the final selected folder disables Drive collection for that selection;
an empty new-format selection never silently expands to all files.

Drive selections are stored as `metadata.googleDriveSources`, with an account ID
and folder IDs per entry. Existing single-account settings remain readable.
Legacy folders without an account identity must be assigned explicitly before
saving. Ownership is checked before collection, and imported evidence records
the account used. A failed Drive account is reported without suppressing later
selected accounts. Disconnect confirmation names the account and covers both
its Gmail and Drive grant; other accounts and collected evidence remain intact.

Regression checks use disposable databases and controlled Google responses.
They do not establish live consent, mailbox access, or Drive access for any
particular user's account.

The local workspace launcher keeps provider configuration off by default. An
operator can set `"googleConnections": true` in the private `workspace.json` to
load the existing Windows-protected Google configuration only. SMTP and other
provider settings are not passed to the server. If the registered callback uses
a different local port, a loopback-only listener forwards only the Google callback
path to this workspace; it does not expose a second API or change Google Cloud
registration. Startup refuses an occupied callback port instead of replacing the
other process. The callback listener closes when its LARO server exits.

### Protected Windows Configuration

Use DPAPI-backed, non-echoing prompts instead of `.env` for live Google/SMTP
secrets:

```powershell
.\scripts\configure-live-providers.ps1 -Google -Smtp
.\scripts\configure-live-providers.ps1 -Status
```

The command stores `provider-config.json` in the resolved LARO/Electron user-data
location and reports the path. Secrets are encrypted for the current Windows
user and decrypted only in memory. It migrates an older worktree-local config.

For Gmail SMTP, use a 16-character app password, not the account password.

Explicit live acceptance commands:

```powershell
npm run acceptance:outbound-live
npm run acceptance:google-evidence-live
npm run acceptance:google-drive-evidence-live
```

These use real external accounts and are consequential. Run them only with the
intended owner account and recipient. Automated tests do not replace them.

## API-only and ngrok Deployment

### Local Docker

```powershell
docker compose up --build
```

The image runs Express/tRPC on Node 22. SQLite and local evidence persist in the
named `laro-data` volume. Keep `LARO_COMPOSE_PROJECT_NAME` stable across checkout
moves.

```text
/api/live    process liveness
/api/ready   database readiness
/api/health  minimal public application/database summary
```

Backup posture, worker history, request/error/latency metrics, and integration
configuration are available only to operator/admin sessions through
`/api/operator/diagnostics` or the matching tRPC diagnostics.

### Existing ngrok Gateway

```powershell
.\scripts\start-ngrok-api.ps1 `
  -ComposeProjectName laro `
  -GatewayUrl https://example.ngrok-free.dev `
  -PathPrefix /laro

.\scripts\start-ngrok-api.ps1 -SkipBuild
.\scripts\stop-ngrok-api.ps1
```

This publishes the API below `/laro`, not the Electron UI. The launcher validates
the route, loads protected providers, and persists non-secret deployment markers.
A plain Compose restart fails closed after an accepted provider contract rather
than silently losing providers or changing the callback.

Direct tunnel fallback:

```powershell
.\scripts\start-ngrok-api.ps1 -ComposeProjectName laro -DirectPublicTunnel
```

Assigned free domains can change. A stable gateway path is recommended.

### HAI Read-only Source

`/api/integrations/hai/feed` serves the dedicated HAI adapter. Its token is
owner-bound, `hai:read` only, stored as a digest, shown once, revocable, and
limited to 365 days. Issuing a token requires a reviewed grant with explicit
owned cases, exported field categories, and separate choices for future cases
and analyses. Existing unselected cases stay excluded even when future-case
access is enabled. Scope edits advance a grant revision and invalidate old feed
cursors; revocation blocks both the grant and credential. The bounded feed
excludes contacts, source bytes/quotes, and provider secrets. Migration 0026
revokes legacy active tokens that have no reviewed grant.

## Security, Privacy, and Recovery

### Security Boundaries

- bcrypt passwords; signed HTTP-only sessions; revocation, origin/CSRF, role,
  rate, and ownership controls.
- Per-install desktop secrets; no packaged `.env`.
- Scanner uploads keep session and scanner authority in the Electron main
  process; reusable API credentials are not exposed to renderer JavaScript.
- Server-owned encrypted provider credentials.
- External document processing is denied without active owner consent bound to the
  selected provider and current automatic-import setting. Grant and revocation are
  mandatory audit events committed atomically with the preference record.
- Provider connection and local disconnection records commit atomically with
  their required audit evidence. Invalid account identities or empty access
  tokens are rejected before storage, and provider network calls have bounded
  timeouts so connection, evidence collection, and sending cannot wait forever.
- Owner-checked short-lived evidence links.
- Bounded uploads, parsing, exports, searches, and provider calls. Direct HTTP
  provider responses are rejected from an oversized declared length or while
  streaming, before JSON, XML, HTML, error text, or evidence bytes are parsed.
- Electron context isolation, sandbox, restricted navigation, denied browser
  permissions, narrow IPC, and single-instance profile lock.
- Demo mode and sample account seeding disabled in production.

### Review Boundaries

- Model observations stay unconfirmed until reviewed.
- Gap scores measure completeness, not legal strength.
- Generated requests/letters are drafts without invented authority.
- Bundle approval binds to an exact case snapshot and becomes stale after change.
- Outreach approval binds to the exact recipient and content shown.
- Case and outreach status changes use owner-bound compare-and-set writes; a
  stale request fails instead of overwriting a newer decision. Recording an
  interested response updates the outreach and case together or rolls both back.
- Required audit evidence is committed in the same database transaction as the
  case lifecycle, outreach initiation, draft approval/rejection, dispatch
  claims, response classification, and Gmail reply linking. A failed audit
  write rolls back the legal state change; batch approvals are all-or-nothing.
- Missing/failed providers never create a false `Sent` state.

### Privacy and Erasure

- Private data and source access are owner/case scoped.
- Exports omit password, token, key, secret, authorization, and cookie fields.
- Evidence, case, and account erasure coordinate metadata and storage cleanup.
- Pending provider cleanup is reported and retried.
- Audit retention is bounded and does not delete owner business records.
- No third-party product analytics or payment/upgrade enforcement is present.

### Backup and Restore

Electron recovery sets bind the database, `laro-secrets.json`, and managed
evidence bytes to a hashed manifest. Local evidence is copied into the set. S3
version-3 sets also bundle every referenced object under a portable filename,
retain its original key and content type, and verify the restored remote bytes
before accepting recovery:

```powershell
npm run db:backup
npm run db:validate -- <backup-path>
npm run db:restore -- <backup-path>
npm run recovery:drill
```

The default `.laro-backups` is a same-device copy, not off-device protection.
Use a truthful synced/network destination and configure count/age limits.
Legacy S3 inventory-only sets remain inspectable but are blocked from normal
restore because they do not contain the evidence bytes.

## Developer Guide

### Repository Map

| Path | Responsibility |
| --- | --- |
| `src-main/` | Electron lifecycle, secure startup, native picker, scanner, provider config |
| `src/renderer/` | React app, routes, case workspace, visualizations, review controls |
| `server/` | API, authorization, data, providers, analysis, matching, workflow, health |
| `shared/` | Shared constants and contracts |
| `drizzle/` | Maintained SQLite migrations |
| `assets/`, `public/` | Matching datasets and approved branding/static assets |
| `tests/`, `test_*.py` | Maintained and legacy test suites |
| `scripts/` | Setup, build, deployment, backup, readiness, acceptance, release |
| `docs/` | Product, architecture, operations, security, privacy, and audits |
| `app.py`, `legal_ledger.py`, `frontend/` | Legacy Flask migration source |

### Common Commands

```powershell
npm run doctor
npm run typecheck
npm run typecheck:renderer
npm run lint
npm test
npm run test:a11y:browser
npm run build
npm run check:renderer-bundle
npm run gate
npm run readiness
npm run readiness:production
npm run db:readiness
npm run preflight
npm run audit:deps
```

Native SQLite mismatch recovery:

```powershell
npm run rebuild:node
npm run rebuild:electron
npm run verify:electron-native
```

### Development Invariants

- Private data is scoped at the server, never trusted to the renderer.
- Credentials never enter renderer state or API responses.
- Evidence retains source identity, bytes, and hash provenance.
- Model findings require valid source spans.
- Unsupported or uncertain behavior is explicit.
- Approval and delivery remain separate.
- Live tests use owner-controlled targets and explicit gates.
- Migrations are recoverable and use validated backups.
- Updates are proposed through a pull request to `main`.

A provider is complete only with server-owned credentials/revocation, least
privilege, authorization, bounded calls, truthful errors, provenance/audits,
deterministic tests, explicit live acceptance, and documentation.

## Testing and Production Readiness

`npm run gate` blocks on native rebuild, all TypeScript checks, ESLint, bundle
budgets, dependency audits, release-record validity, traceability, safety scans,
Electron and Flask recovery drills, and Vitest.

On 2026-08-22, the fresh gate passed **101 test files and 625 tests**, with 0
dependency vulnerabilities, 117/117 traceability rows cited, 0 suspect runtime
placeholders, and 0 high-severity account-safety findings. This is a dated local
verification snapshot; use the latest
[GitHub Actions run](https://github.com/Robert-Velhorst/000-LARO/actions) for the
current commit.

```powershell
python -m unittest discover -v -p "test_*.py"
```

### Evidence Levels

| Evidence | What it proves |
| --- | --- |
| Unit/integration | Deterministic behavior under controlled fixtures |
| Production build | Type and bundle correctness |
| Packaged Electron | Native ABI, migrations, startup, secrets, profile lock, packaged UI |
| Docker readiness | Production dependencies, volumes, health, auth boundaries |
| Browser accessibility | Routes, responsive overflow, labels, errors, selected interactions |
| Provider-live | Target account, scopes, import/delivery, provenance, revocation, audit |

No narrow category proves a broader one. Credentials and mocked tests do not
prove live Google import or delivery.

```powershell
npm run release:prepare
npm run acceptance:providers
npm run release:check
npm run dist:win
```

Public trusted Windows distribution requires a separately accepted Store or
Authenticode identity. Internal tagged releases may remain unsigned.

## Legacy Flask Migration

The Flask command center remains because older LARO/Papertrail workspaces hold
valuable source-linked ledger data. It is not the maintained product.

```powershell
python -m pip install -r requirements.txt
Copy-Item .env.example .env
.\run_local.ps1
```

Open `http://127.0.0.1:8768/case_command_center.html`. Its convenience bootstrap
is loopback-only and limited to `LARO_LOCAL_ACCOUNT_EMAIL`.

Migration is one-way and owner-bound: stop both runtimes, validate backups, map
one Flask owner to one existing desktop account, verify hashes/bytes, archive
legacy sources without passwords/sessions/tokens/send state, verify Desktop,
then keep Flask stopped. See
[Flask to Desktop Migration](docs/FLASK_TO_DESKTOP_MIGRATION.md).

```powershell
npm run flask:backup -- <backup-path>
npm run flask:validate -- <backup-path>
npm run flask:restore -- <backup-path> --confirm-stopped
npm run flask:recovery:drill
```

External Flask keys stay in independent operator escrow.

## Known Limitations

- LARO cannot establish legal truth or replace professional review.
- Scanned PDF pages use an OCR fallback; poor scans, handwriting, or complex
  layouts can still need manual review or higher-quality source material.
- Public target discovery is bounded, not exhaustive.
- Dashed map links are suggestions, not factual causation.
- Optional AI quality varies, but citations remain mandatory.
- Microsoft, Google Calendar/Contacts, and Trello OAuth are not operational
  evidence connectors.
- Sending is disabled by default.
- Flask remains a separate recovery responsibility until migration.
- Historical tables still use extra relationship guards pending native-FK work.
- SQLite/local storage target one desktop/API owner process, not active-active
  multi-node service.
- Windows portable builds are unsigned and intended for internal use.
- Formal WCAG conformance is not claimed, though automated accessibility,
  keyboard, responsive, and console checks are blocking.
- Historical docs are dated snapshots. Current code, README, fresh gate, and
  commit-specific CI are authoritative.

## Troubleshooting

### Google Consent Keeps Loading

1. Confirm LARO is running and you are signed into the intended LARO account.
2. Match the Google redirect URI exactly, including prefix and port.
3. Ensure the callback reaches the same instance that created OAuth state.
4. Check `/api/ready` and logs for callback, state, or session errors.
5. Retry from LARO rather than a stale Google consent tab.

Never place authorization codes, refresh tokens, or browser sessions in logs.

### Native SQLite Mismatch

Run the Node or Electron rebuild command above, then retry.

### Sending Is Disabled

Check ownership, Approved state, unchanged approval hash, feature flag, emergency
stop, provider configuration, and dispatch state. `Dispatching` after a provider
exception requires operator verification, not a blind retry.

### ngrok Routes the Wrong Service

Use the verified launcher, stable Compose identity, expected path, and exact
public callback. The stop script verifies a process before stopping it.

### Evidence Cannot Be Analyzed

Check format/size, managed bytes and hash, and the OCR result for scanned pages.
Poor image quality may require a better scan. Supported text should retain
deterministic analysis after an optional provider failure.

See [Troubleshooting](docs/TROUBLESHOOTING.md) and in-app Help.

## Documentation Index

### Product and Architecture

- [Product Definition](docs/PRODUCT_DEFINITION.md)
- [User Guide](docs/USER_GUIDE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Frontend Architecture](docs/FRONTEND_ARCHITECTURE.md)
- [Data Model](docs/DATA_MODEL.md)
- [Domain Model](docs/DOMAIN_MODEL.md)
- [State Machines](docs/STATE_MACHINES.md)

### Operations

- [Fresh Clone](docs/FRESH_CLONE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Operator Runbook](docs/OPERATOR_RUNBOOK.md)
- [Operator Readiness](docs/OPERATOR_READINESS.md)
- [Backup and Restore](docs/BACKUP_RESTORE.md)
- [Release Process](docs/RELEASE_PROCESS.md)
- [Feature Flags](docs/FEATURE_FLAGS.md)
- [Providers](docs/PROVIDERS.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

### Security and Privacy

- [Security](docs/SECURITY.md)
- [Threat Model](docs/THREAT_MODEL.md)
- [Privacy](docs/PRIVACY.md)
- [Privacy Impact Assessment](docs/PRIVACY_IMPACT_ASSESSMENT.md)
- [Compliance](docs/COMPLIANCE.md)
- [Data Retention](docs/DATA_RETENTION.md)
- [Supply Chain](docs/SUPPLY_CHAIN.md)

### Engineering and Evidence

- [Migrations](docs/MIGRATIONS.md)
- [Accessibility](docs/ACCESSIBILITY.md)
- [Performance](docs/PERFORMANCE.md)
- [Technical Audit](docs/TECHNICAL_AUDIT.md)
- [Technical Debt](docs/TECH_DEBT.md)
- [Traceability](docs/TRACEABILITY.md)
- [Final Verification Report](docs/FINAL_VERIFICATION_REPORT.md)
- [Acceptance Tests](docs/ACCEPTANCE_TESTS.md)
- [Manual Verification](docs/MANUAL_VERIFICATION.md)
- [Definition of Done](docs/DEFINITION_OF_DONE.md)
- [Changelog](CHANGELOG.md)

### Migration and Port Audits

- [Flask to Desktop Migration](docs/FLASK_TO_DESKTOP_MIGRATION.md)
- [Paper-trail Timeline Generator Audit](docs/PAPER_TRAIL_TIMELINE_GENERATOR_AUDIT.md)
- [Legacy Dashboard Port Audit](docs/LEGACY_DASHBOARD_PORT_AUDIT.md)
- [Lawyer Automation Dashboards Port Audit](docs/LAWYER_AUTOMATION_DASHBOARDS_PORT_AUDIT.md)

## License

See [LICENSE](LICENSE).
