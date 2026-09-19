# Security scanning policy

Last reviewed: 2026-09-19

`.github/workflows/security.yml` runs for pull requests into `main`, updates to `main`, a weekly schedule, and manual verification. Scanner failures return a non-zero result. Repository owners must also require the workflow's checks in a GitHub repository ruleset before those results can prevent a merge; local workflow validation alone does not prove that hosted enforcement is enabled.

## Maintained scanners

- CodeQL Action `v4.38.0` runs the `security-extended` queries against maintained JavaScript/TypeScript and Python sources.
- Gitleaks Action `v3.0.0` with Gitleaks `8.24.3` scans event commits with complete Git history available. Pull-request and push events scan their relevant commit range; scheduled and manual runs scan history. A second `gitleaks dir` pass scans the checked-out merge result. Both paths redact findings, return exit code 2 on a finding, and disable comments, summaries, and finding artifacts so credentials are not copied into GitHub output surfaces.
- Trivy Action `v0.36.0` with Trivy `v0.74.0` builds the actual digest-pinned Debian 13 distroless runtime image with a refreshed build base, writes an all-package CycloneDX inventory, and rejects any `HIGH` or `CRITICAL` vulnerability, including unfixed findings. The final image omits npm, a shell, compilers, and the OS package manager.
- Scheduled failures open or update one visible maintenance issue through the S0-05 `upsert-automation-failure.mjs` path. The issue links to the workflow run without copying scanner findings.

External actions are pinned to immutable commit revisions. `npm run verify:workflow-actions` rejects mutable action tags or branches, while `npm run verify:security-workflow` prevents the scanner triggers, permissions, thresholds, baseline, or failure-record contract from silently weakening.

## Secret baseline

The current tree contains no approved Gitleaks exceptions. Three exact fingerprints cover detector-like synthetic test fixtures in immutable history:

| Exact fingerprint | Classification | Approval and review |
| --- | --- | --- |
| `2e206548242e740cd9d3065691df9ce0b5fd1907:tests/security/productionReadiness.test.ts:generic-api-key:228` | Synthetic compatibility-test input, never a provider credential | Repository-owner merge review; re-review by 2027-09-19 or remove after a history rewrite |
| `c5712fd7c320797ace8ea8d1fffb228ef3723cc7:tests/smoke/configGuard.smoke.test.ts:generic-api-key:48` | Synthetic configuration-test input, never a provider credential | Repository-owner merge review; re-review by 2027-09-19 or remove after a history rewrite |
| `c5712fd7c320797ace8ea8d1fffb228ef3723cc7:tests/smoke/configGuard.smoke.test.ts:generic-api-key:49` | Synthetic configuration-test input, never a provider credential | Repository-owner merge review; re-review by 2027-09-19 or remove after a history rewrite |

No path, rule, or generic allowlist is approved. A real credential finding must be rotated and removed; it must never be added to `.gitleaksignore`. Any future exception requires an exact fingerprint, linked issue, technical justification, repository-owner approval, and explicit review date.

## Container findings

No container-vulnerability suppressions are approved. The blocking threshold is every fixed or unfixed `HIGH` or `CRITICAL` finding in the built image. A future exception requires the CVE identifier, affected package and image digest, compensating controls, linked issue, owner approval, and expiry date. The CycloneDX SBOM is uploaded even when vulnerability enforcement fails so reviewers can inspect the exact inventory used by the job.
