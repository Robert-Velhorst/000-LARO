# Maintenance evidence record

The repository owner is accountable for weekly and monthly automation. The release operator is accountable for release and quarterly checks. A delegate may execute a check, but the accountable owner reviews and signs the result.

## Automated evidence

- The `Scheduled maintenance` workflow runs the complete repository gate weekly.
- The monthly run also executes database readiness against disposable test data.
- The `Security analysis` workflow runs source, secret, container-vulnerability, and SBOM checks weekly.
- A failed scheduled run opens or updates one visible GitHub issue containing only the run link and timestamp. Logs and secrets are never copied into the issue.

## Credentialed and production checklist

Copy this table for each manual release or quarterly drill. Store no credentials, provider payloads, evidence content, or production database rows in GitHub.

| Field | Required record |
| --- | --- |
| Date and operator | UTC date and GitHub username or approved operator name |
| Scope | Release, credential rotation, emergency stop, token revocation, backup restore, or provider acceptance |
| Target | Environment name only; never a credential or private case identifier |
| Result | Pass, fail, or blocked |
| Evidence | Redacted run URL, artifact checksum, or private evidence-record identifier |
| Follow-up | GitHub issue number and owner when not passed |

A missed or failed check blocks the affected release. The repository owner opens or updates a tracked issue, assigns an owner and due date, and records the passing rerun before closing it.
