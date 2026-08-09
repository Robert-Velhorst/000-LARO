# Supply Chain and Dependency Review

Updated: 2026-08-08 | Branch: `agent/giant-goal-completion`

## Current result

`npm audit --audit-level=moderate` reports **0 known vulnerabilities** for the committed lockfile.

The 2026-08-08 audit initially found two newly published high-severity
advisories. The lockfile was updated from `nanoid` 3.3.16 to 3.3.18 and from
transitive `js-yaml` 4.3.0 to 4.3.1. Both the complete dependency graph and
`--omit=dev` runtime graph then reported zero known vulnerabilities. No major
version or application API change was required.

The remediation upgraded the supported runtime to Node 22.12+, Electron 43, Vite 8, Vitest 4, electron-builder 26, `@electron/rebuild` 4, Drizzle ORM 0.45, Nodemailer 9, and UUID 11. Unused `xlsx`, Stripe SDK, PDFKit, Tesseract, and their unused type packages were removed. `drizzle-kit` was also removed because its current dependency chain retained the final four advisories; checked-in SQL migrations remain the production migration source.

## Native module lifecycle

`better-sqlite3` cannot use one binary for both Node and Electron ABIs. Installation no longer rebuilds it automatically for Electron.

- `npm run rebuild:node` prepares server and test execution.
- `npm run rebuild:electron` prepares desktop execution and packaging.
- CI runs the Node rebuild before gates; release packaging runs the Electron rebuild afterward.

## Release rule

Run `npm ci --ignore-scripts`, `npm run rebuild:node`, and `npm run gate` from a
clean checkout. The gate blocks on both full-lockfile and runtime-only npm audit
findings at moderate severity or above. Audit status is time-sensitive and is
therefore refreshed on every pull request and `main` build.
