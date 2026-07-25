# Paper Trail Timeline Generator Audit

Date: 2026-07-22

Sources:

- `Noodzakelijk-Online/024-Paper-trail-visualizer`, `main`, commit `d6e3237`.
- `Noodzakelijk-Online/024-Paper-trail-visualizer`,
  `feat/document-timeline-generator`, commit `2508587`.

The branch has no common Git ancestor with the predecessor repository's main
branch. It is a separate Python/Flask prototype, not an incremental change to
the React metro-map implementation.

## Ported concepts

| Prototype concept | LARO implementation |
| --- | --- |
| Filter a timeline around one subject | Focus the case reconstruction on a source-derived analyzed participant |
| Group documents by discovered topics | Focus on named, source-linked legal issues instead of opaque LDA topic numbers |
| Extract actions associated with dates | Show the dated, source-linked actions retained for the selected document |
| Explore entity relationships | Combine participant focus with explicit and confidence-labelled document relationships |
| Refresh analysis when evidence changes | Use LARO's persisted imports, analysis state, automatic query invalidation, and controlled refresh |
| Divide a case into story phases | Present neutral, date-ordered phases whose summaries and counts resolve to source document IDs |
| Identify key moments | Rank source documents using dated actions and verified links, without guessing intent or legal outcome |
| Trace causal or influence chains | Expose connected document chains with explicit/inferred link counts and aggregate confidence |
| Subway-style document history | Render dated document stations on legal, communication, financial, employment, and termination routes |
| Inspect inputs and outputs | Inspect incoming and outgoing links, evidence basis, confidence, and the original source document |

## Not ported

- The Flask application uses a hard-coded session secret, process-global mutable
  status, unauthenticated routes, and raw local paths.
- The JSON cache is keyed by path and modification time and has no owner, case,
  content-hash, migration, or concurrency boundary.
- The English-only spaCy model and subject-verb-object heuristic are unsuitable
  for LARO's Dutch/English legal evidence and do not retain source citations.
- LDA labels such as `Topic #2` are not legal findings and provide no reviewable
  source basis.
- The filesystem watcher accepts a configured recursive path and analyzes files
  from a web-server thread. LARO instead confines local-folder collection to
  approved roots and managed evidence storage.
- Generated PyVis/Jinja HTML is a second unaudited presentation runtime and does
  not enforce LARO's owner-scoped source-opening contract.
- The React prototype's browser connectors are placeholders that log actions or
  return sample records. LARO retains its real, owner-scoped Google and local
  evidence collectors instead.
- Heuristic "justice score", "injustice probability", emotional-impact, and
  cover-up labels are not ported. They present legal conclusions without a
  reviewable evidentiary standard. LARO keeps facts, suggestions, confidence,
  and source provenance separate.
- Demo timelines, in-memory import/export state, and duplicate React/Vite UI
  infrastructure are superseded by LARO's persisted case model and renderer.

## Retirement conclusion

LARO does not import, execute, or depend on either predecessor branch. Every
useful production-safe concept is represented by LARO's document intelligence,
case reconstruction contract, and renderer. The predecessor repository is not
required for operation or future migrations and can be retired after this
LARO change is present on `main`.
