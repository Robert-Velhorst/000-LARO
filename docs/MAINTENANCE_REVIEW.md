# Maintenance & Refactoring Review (Phase 114)

Date: 2026-07-06 · Branch `Phase-Imp`

A standing review of code health and the refactoring backlog. Complements the
tech-debt register (docs/TECH_DEBT.md) with maintainability observations.

## Refactors already done (this program)
- **Single retry primitive:** the job runner now delegates to `server/retry.ts`
  (`retryWithBackoff`) instead of a bespoke inline loop (Phase 110) — one tested
  implementation, `isRetryable` gating added.
- **Explicit operational controls:** the emergency stop has its audited
  `server/systemState.ts` contract, while the only maintained rollout flag is
  defined and consumer-checked in `server/featureFlags.ts`.
- **Honest confidence:** hardcoded confidence constants replaced by
  `scoreToConfidence` derived from real scores (Phase 107).

## Maintainability observations / backlog
| Area | Observation | Suggested refactor |
|---|---|---|
| `shared/` vs `src/shared/` | duplicated trees (D8) | merge into one |
| Retired monetary compatibility fields (D13) | isolated from the active model | inspect the read-only `legacy_billing_archive` only for migration/audit work; never reintroduce payment policy |
| Router file `index.ts` | large; many inline routers | split inline routers into files |
| Renderer types (D2) | ~425 tsc errors | incremental typing, then gate |
| Dead deps (D6) | pdfkit/archiver/tesseract/stripe unused | remove or implement |

## Review cadence
Run alongside the monthly maintenance plan (docs/MAINTENANCE_PLAN.md). Each cycle:
pick one backlog item, refactor behind the green gate, update this doc.
