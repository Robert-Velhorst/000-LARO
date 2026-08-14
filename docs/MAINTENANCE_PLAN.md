# Post-Completion Maintenance Plan

Current as of 2026-07-16.

## Cadence

| Interval | Required work |
| --- | --- |
| Every change | Run `npm run gate`; CI must pass before merge. |
| Weekly | Triage `npm audit`, provider failures, and delivery audit records. |
| Monthly | Run target `npm run db:readiness`, review `docs/TECH_DEBT.md`, and verify backup restore. |
| Every release | Run `npm run readiness:production`, package, launch with isolated user data, probe health, and record checksum. |
| Quarterly | Review dependencies, rotate live-provider credentials, and exercise emergency stop and token revocation. |

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
