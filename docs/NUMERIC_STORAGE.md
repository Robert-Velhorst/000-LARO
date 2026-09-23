# Canonical Numeric Storage

Current as of 2026-09-23.

Migration `0032_numeric_normalization.sql` and the compatibility runner convert
the active historical numeric fields below from `TEXT` to native SQLite numeric
storage. Every field permits `NULL` for unavailable data. Non-null values carry
a named check requiring the documented SQLite storage class and range.

`safe integer max` means JavaScript's exact integer ceiling,
`9,007,199,254,740,991`.

| Table | Columns | Storage | Unit | Inclusive bounds |
| --- | --- | --- | --- | --- |
| `lawyers` | `totalOutreaches`, `totalResponses`, `totalAcceptances` | `INTEGER` | events | 0 to safe integer max |
| `lawyers` | `averageResponseTimeHours` | `REAL` | hours | 0 to safe integer max |
| `lawyers` | `caseLoad` | `INTEGER` | cases | 0 to safe integer max |
| `lawyers` | `experienceYears` | `INTEGER` | years | 0 to 100 |
| `lawyers` | `capacityPercentage` | `REAL` | percent | 0 to 100 |
| `lawyers` | `directoryDistanceKm` | `REAL` | kilometres | 0 to safe integer max |
| `evidence` | `fileSize` | `INTEGER` | bytes | 0 to safe integer max |
| `evidence_items` | `size` | `INTEGER` | bytes | 0 to safe integer max |
| `evidence_files` | `fileSize` | `INTEGER` | bytes | 0 to safe integer max |
| `outreach_status` | `responseTimeHours` | `REAL` | hours | 0 to safe integer max |
| `outreach_status` | `lawyerCapacityPercentage` | `REAL` | percent | 0 to 100 |
| `usage_tracking` | `quantity` | `INTEGER` | units | 0 to safe integer max |
| `bulk_import_jobs` | `totalRows`, `processedRows`, `failedRows` | `INTEGER` | rows | 0 to safe integer max |
| `auto_collection_settings` | `totalItemsCollected`, `totalEmailsCollected`, `totalFilesCollected` | `INTEGER` | items | 0 to safe integer max |
| `auto_collection_logs` | `emailsFound`, `emailsProcessed`, `filesFound`, `filesDownloaded` | `INTEGER` | items | 0 to safe integer max |
| `auto_collection_logs` | `errorCount` | `INTEGER` | errors | 0 to safe integer max |
| `auto_collection_logs` | `executionTimeSeconds` | `REAL` | seconds | 0 to safe integer max |
| `keyword_matches` | `matchCount` | `INTEGER` | matches | 0 to safe integer max |

## Upgrade contract

Before mutation, startup creates and validates a database backup and scans the
legacy fields. Decimal and exponent notation are accepted only when they parse
to a finite in-range value; integer fields must remain exact safe integers.
Empty legacy strings become `NULL`. Any other value stops the upgrade and the
error reports only the field and invalid-row count.

The table rebuild and casts run in one transaction. Existing rows, declared
columns, indexes, and non-legacy triggers are preserved. Startup commits only
after all 27 declared types match, every converted value passes its policy, and
`PRAGMA foreign_key_check` is clean. A reconciled marker makes later boots
idempotent.

## Runtime contract

Application writes and reads use numbers directly. Response-hour averages use
`REAL` values without integer truncation, and count/size aggregation operates on
numeric columns without text parsing. Data readiness additionally checks the
reviewed cross-field rules, such as responses not exceeding outreaches and
processed rows not exceeding total rows.
