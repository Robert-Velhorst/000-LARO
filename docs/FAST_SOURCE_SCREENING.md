# Fast Source Screening

Local source processing now has a cheap preselection stage before importing
originals or invoking OCR/model analysis. It is deliberately conservative:
unknown relevance remains eligible for analysis, not rejected.

## Decisions

- Priority: a legal/document signal in an actual sampled text fragment.
- Normal: inconclusive samples, unknown encodings or content requiring PDF,
  office-document extraction or OCR. Absence of a keyword never means irrelevant.
- Low: software-directory context combined with an application asset filename
  or sampled source-code syntax. These items are deferred, not silently skipped.
  A sampled legal signal overrides software classification. Image contents are
  not examined in this stage, even when an asset-name heuristic defers the image.
- Unavailable: the skim could not inspect the item. Existing access, format and
  failure handling must still process it; it is not classified as irrelevant.

No source is deleted, moved or modified. No model or external service is called
by local screening. Raw fragments are not persisted. Stored screening contains
the rule version, source version, time, byte counts, tier and reason codes.
Text reads are bounded to three 8 KiB windows per file. These can overlap for
small files; bytes sampled measures I/O, not unique-content coverage.

## Recovery and Control

Screening uses the existing persisted queue and leases, with up to eight readers
per 128-item batch. A pause allows the current batch to finish; it does not start
another batch. Abandoned leases remain recoverable. Recheck/import verifies file
identity and version rather than trusting an obsolete sample. Protected folders,
symlinks and granted-root boundaries are not bypassed. **Analyze anyway** is an
explicit per-item inclusion; format, size and access limits still apply.

The shared queue prioritizes inventory, candidate import, then heavy analysis.
This improves initial coverage but can delay deep analysis during very large
inventories. Google data is not given a new local skim or downloaded speculatively.
Previously imported documents are not reclassified by this stage.

## Measurements

Measured locally on 12 September 2026 with Node 22.23.2. The corpus was generated
immediately before each run, so the operating-system cache may be warm. These are
synthetic text/source-code tests, not a cold-disk or representative legal-corpus
acceptance test. Timing includes folder enumeration and the same bounded batch
scanner used by the queue. It excludes fixture generation, database commits,
copying originals, OCR, full extraction, model analysis and network transfer.

| Corpus | Aggregate file bytes | Bytes actually sampled | Elapsed |
| --- | ---: | ---: | ---: |
| 300 files, 4 MiB each | 1,258,291,200 | 7,372,800 | 0.272 seconds |
| 10,000 files, 128 KiB each | 1,310,720,000 | 245,760,000 | 11.251 seconds |

Both exceed 1 GB of represented files within 60 seconds for this skim phase.
Neither result means all represented bytes were read or legally understood.
All planted legal signals at file tails were prioritized (30 and 1,000
respectively), including those in source-code files. This synthetic assertion is
not a measured recall rate on real cases. Important evidence can occur outside
the sampled windows; therefore incomplete sampling cannot justify rejection.

Reproduce after building the server:

```powershell
node scripts/benchmark-source-screening.mjs
node scripts/benchmark-source-screening.mjs --many-files
```

The script creates its own temporary corpus under `.cache/screen-benchmark`,
records JSON measurements there and removes only that generated corpus after
validating its resolved path. It never selects user documents or a live database.
The 60-second target is reported from actual elapsed time, not assumed.
