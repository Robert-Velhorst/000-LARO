# Lawyer Automation Dashboards Port Audit

Date: 2026-07-26

Source: `Noodzakelijk-Online/lawyer-automation-dashboards` at `9e87b36`

Follow-up source: restored `000 - Laro V8.zip` snapshot (533 archive entries)

## Conclusion

The source repository is relevant as an earlier prototype and code ancestor, but
it is not a production-ready replacement for current LARO. Current LARO already
contains and has hardened most of its useful product surface. Code must be
selected by behavior and revalidated against LARO's current ownership, provider,
evidence, and no-fake-success boundaries; wholesale merging is unsafe.

## Measured Overlap

A path-and-SHA comparison of the two checked-out component trees found:

| Measure | Result |
| --- | ---: |
| Source component files | 139 |
| Current LARO component files | 124 |
| Shared relative paths | 95 |
| Byte-identical shared files | 31 |
| Source-only component paths | 44 |

The source-only set is mostly generic UI primitives or unfinished prototypes.
Examples include billing/quota UI, an annotation canvas whose save callback only
logs, personalization screens seeded with example lawyers and templates, and a
sync scheduler whose provider paths are explicitly incomplete.

## Excluded From Port

The following source patterns conflict with current production requirements and
must not be copied:

- unauthenticated fallback to `demo-user-123`;
- random analytics and hardcoded example records;
- provider endpoints that return empty or placeholder success states;
- OAuth/provider token writes marked as unencrypted;
- local-file deletion without an ownership check or managed-storage deletion;
- automatic outreach behavior without LARO's approval, emergency-stop,
  ownership, provider, audit, and idempotency gates;
- pricing, quotas, and upgrade prompts that contradict local unmetered operation;
- the tracked `.env.production` file. No values were copied or printed. Its
  secret-bearing variable set should be reviewed and any real credentials
  rotated in the source repository's own security workflow.

## Ported Capability

The useful source concept was server-side lawyer search and pagination. Current
LARO previously fetched at most 100 rows and filtered that partial set in the
browser. The source implementation could not be copied directly because it
filtered legal areas after pagination while reporting the unfiltered total.

The hardened LARO implementation now:

- validates page size, query length, legal area, experience, availability, and
  official-profile filters at the authenticated tRPC boundary;
- applies every filter before counting and pagination;
- handles JSON and legacy text legal-area values;
- treats SQL wildcard characters in user text literally;
- excludes malformed experience values from numeric ranges;
- returns total rows, total pages, and official NOvA record counts;
- orders official records first and then uses stable name/ID ordering;
- exposes paged results, truthful counts, loading/error states, and an
  `Official NOvA only` control in the mounted directory.

The restored V8 snapshot also exposed one useful concept that current LARO had
not completed: case question answering. Its prototype implementation used only
case metadata and could automatically email a lawyer above a model-confidence
threshold. That behavior was not copied.

The hardened case assistant now:

- retrieves only completed analyses for a case the authenticated user may
  access;
- ranks summaries, cited findings, dated events, and source excerpts against
  the question, with a broad-case-overview mode;
- sends a bounded source context to the optional model provider and requires
  one or more valid supplied document IDs in the response;
- rejects missing or invented source IDs and falls back to deterministic
  evidence matches instead of presenting an ungrounded answer;
- returns clickable source controls and records successful source dispatch;
- never sends email, changes a case, or performs outreach.

The restored snapshot was a flattened amalgamation of prototypes rather than a
coherent newer checkout. Its tracked secret-bearing environment file, demo
identity, random analytics, mock provider success states, unencrypted token
writes, and approval-free automated outreach remain excluded.

Real-database regression coverage proves non-overlapping pages, accurate totals,
combined filters, literal wildcard handling, malformed experience handling, and
authentication enforcement.

## Remaining Source Review Rule

Future source-only files are candidates only when a current product requirement
exists and the implementation can pass LARO's definition of done. File presence
or prototype documentation is not evidence that a feature is safe or complete.
