# Security scanning policy

Security analysis is blocking for pull requests and protected-branch updates and recurs weekly.

- CodeQL analyzes maintained TypeScript/JavaScript and Python sources.
- Gitleaks scans complete history on the initial baseline and the relevant commits on later events. Findings are redacted; a discovered credential must be rotated even when later removed from Git history.
- Trivy builds and inventories the actual runtime image as CycloneDX and rejects `HIGH` or `CRITICAL` vulnerabilities, including unfixed findings.
- Scheduled failures create or update a visible maintenance issue without copying sensitive logs.

Suppressions require a linked issue, exact rule or vulnerability identifier, technical justification, repository-owner approval, and an expiry date. Broad path, severity, or scanner suppression is prohibited. Action revisions are updated only in a reviewed pull request after release notes and upstream ownership are checked; `npm run verify:workflow-actions` rejects mutable action tags and branches.
