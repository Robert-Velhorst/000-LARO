import { defineConfig } from 'vitest/config';

/**
 * Standalone Vitest config.
 *
 * The explicit suite list keeps backend and critical-path tests independent of
 * the Electron/React renderer plugins. Vitest test files outside these suite
 * directories are prohibited; a recursive release regression check enforces
 * that invariant so excluded files cannot look like coverage.
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Database-backed suites use isolated temporary SQLite files. Browser
    // accessibility coverage has its own Playwright configuration.
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
    // Bound worker concurrency so Windows and lower-resource CI hosts do not
    // overwhelm disk and memory while temporary SQLite databases initialize.
    maxWorkers: 2,
    minWorkers: 1,
  },
});
