# Contributing to LARO

LARO changes follow one evidence-backed lifecycle:

1. Start from a roadmap issue using the `Problem`, `Fix`, and `Acceptance Criteria` structure.
2. Create a focused branch from current `main`; use the stable issue identifier in the branch or pull-request description.
3. Reuse, extend, or replace the canonical implementation. Do not add a parallel coordinator without documenting why separation is necessary.
4. Open a reviewed pull request that links the issue, reports every acceptance criterion, and records exact validation results.
5. Merge only after required review and blocking checks pass.
6. Perform and record any packaged-runtime or external-provider acceptance separately before claiming release completion.

## Required validation

Use Node.js 22 as declared in `package.json`.

```text
npm ci
npm run gate
```

Run focused tests while developing, then run the complete gate before review. Renderer accessibility changes also require `npm run test:a11y:browser`; deployment changes require the shared-container workflow; release changes require the relevant packaged-runtime verification.

The canonical engineering rules live in:

- `docs/PROCESS_RULES.md`
- `docs/DEFINITION_OF_DONE.md`
- `docs/MAINTENANCE_PLAN.md`
- `docs/OPERATOR_RUNBOOK.md`

Do not create a second roadmap or weaken a failing gate. Keep secrets, private evidence, production databases, and provider tokens out of commits and issue text.
