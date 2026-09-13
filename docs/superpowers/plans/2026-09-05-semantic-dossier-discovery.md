# Semantic Dossier Discovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans; verify each complete path.

**Goal:** Discover and grow provisional dossiers from document contents without a shared reference number.
**Architecture:** Reuse the configured LLM gateway and canonical source citations. Make a bounded, owner-scoped discovery packet, validate structured decisions against actual supplied passages, and apply accepted high-confidence decisions transactionally. Preserve uncertainty and never fall back to a paid provider.
**Tech Stack:** Existing Node 22, TypeScript, tRPC, SQLite/Drizzle, React, Vitest.
**Spec:** `docs/AUTONOMOUS_DOSSIER_REQUIREMENTS.md`, especially requirements 3-5 and 8.

## Constraints
- No live private document transmission or provider configuration changes during tests.
- A local deterministic extractor is not a semantic model; unavailable/configuration-disabled providers leave an actionable exception.
- Every automatic semantic decision needs two distinct source-supported signals, including the situation rather than merely a common person or topic.
- All candidate cases belong to the current owner. Context size limits must be explicit, never hidden truncation presented as complete review.
- Preserve all earlier changes; no commits, pushes or merges in this implementation step.

## Tasks
- [x] Add failing API tests in `tests/backend/semanticDossierDiscovery.test.ts` for automatic creation without references, subsequent semantic assignment, unsupported citations, unknown candidate IDs, disabled sharing, provider failure and review mode.
- [x] Implement `server/dossierDiscovery.ts`: provider-policy admission, source packet, structured output and grounding validation; no storage mutation in this module.
- [x] Integrate discovery into `server/documentInbox.ts`: owner serialization, current-state checks, transaction/audit, canonical evidence/analysis linking. Existing explicit-reference behavior remains supported.
- [x] Expose the audited decision basis in inbox details, distinguishing provider reasoning from source quotes.
- [x] Run the new integration suite and existing inbox/privacy suites, type checks, renderer validation and build. Record real-model quality/live-source acceptance as outstanding.
- [x] Update README and requirements status without narrowing the remaining end state.

## Verification

Verified 5 September 2026: complete Vitest run 713 passed / 2 hosted-database
tests skipped (127 files, 1235.05s); all 9 Playwright tests passed; server/renderer
type checks, lint, complete application build and renderer budget passed.
The isolated development preview was restarted and its health/login checked.
Provider outputs were controlled fixtures; no real-model quality or real-source
acceptance is claimed. No commit, publication, installation or merge occurred.

```text
node node_modules/vitest/vitest.mjs run tests/backend/semanticDossierDiscovery.test.ts tests/backend/documentInbox.test.ts tests/backend/workflowPreferences.test.ts --maxWorkers=1
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.renderer.json --noEmit
```
