# Post-Completion Maintenance Plan

Current as of 2026-07-16.

## Cadence

| Interval | Required work |
| --- | --- |
| Every change | Run `npm run gate`; CI must pass before merge. |
| Weekly | Repository owner reviews the scheduled full gate, security scans, provider failures, and delivery audit records. |
| Monthly | Repository owner reviews the scheduled disposable-data readiness result, `docs/TECH_DEBT.md`, and recovery evidence. Target production data is checked manually and privately. |
| Every release | Release operator runs `npm run readiness:production`, packages, launches with isolated user data, probes health, and records the checksum. |
| Quarterly | Release operator reviews dependencies, rotates live-provider credentials, and exercises emergency stop and token revocation using the dated private checklist. |

Documentation-only pushes to `main` skip the Windows packaging workflow because
they cannot change the executable. Pull-request and main CI still run, tagged
pushes always package, and an operator can start packaging manually with
`workflow_dispatch`.

## Operational Signals

- `/api/health` and `/api/ready` must report the expected version and production
  runtime.
- `outreach.send.enabled` stays off unless a live provider has passed target
  acceptance and the operator intends to permit delivery.
- Database integrity, invariants, reconciliation, declared foreign keys, and
  demo-marker checks must remain clean.
- A red release gate, failed backup drill, or unresolved high-severity security
  finding blocks release.

## Priority Order

1. Security, privacy, data-loss, and ownership defects.
2. Target-provider failures and ambiguous irreversible actions.
3. Declared foreign-key expansion after installed-data reconciliation.
4. Accessibility, localization, bundle, and historical schema normalization.

Incident and rollback procedures are in `docs/OPERATOR_RUNBOOK.md`; current
engineering debt is in `docs/TECH_DEBT.md`.

The repository-safe cadence is enforced by `.github/workflows/maintenance.yml`
and `.github/workflows/security.yml`. Credentialed or production checks use the
redacted checklist in `docs/MAINTENANCE_EVIDENCE.md`. A missed or failed run
opens or updates a visible issue and blocks the affected release until a passing
rerun is recorded.
