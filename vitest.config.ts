import { defineConfig } from 'vitest/config';

/**
 * Standalone Vitest config.
 *
 * Before this file existed, `vitest` fell back to loading `vite.config.ts`
 * (which pulls in the Electron/React renderer plugins) and could not start in a
 * headless checkout. This config is deliberately minimal and framework-free so
 * the backend/critical-path tests run without the renderer toolchain.
 *
 * Scope: currently limited to the Phase 003 smoke suite. The legacy `tests/*.test.ts`
 * files have broken import paths and tautological assertions (documented in
 * docs/phase-audit.md and docs/CRITICAL_PATH.md); they are repaired and folded
 * into `include` in Phases 040–041 (Backend / Frontend test suites).
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Phase 040: the backend suite runs real DB integration tests against a temp
    // SQLite file. The legacy tests/*.test.ts suite (broken imports) is repaired
    // separately (Phase 041).
    include: [
      'tests/smoke/**/*.test.ts',
      'tests/backend/**/*.test.ts',
      'tests/e2e/**/*.test.ts',
      'tests/security/**/*.test.ts',
      'tests/frontend/**/*.test.ts',
      'tests/a11y/**/*.test.ts',
      'tests/acceptance/**/*.test.ts',
      'tests/sim/**/*.test.ts',
    ],
    testTimeout: 30_000,
    // Migration-backed setup can cross one minute on constrained Windows hosts;
    // keep a finite ceiling without weakening the per-test timeout below.
    hookTimeout: 300_000,
    // Database-backed suites perform migrations in setup hooks. Bound worker
    // concurrency so Windows and lower-resource CI hosts do not overwhelm disk
    // and memory while temporary SQLite databases initialize.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
