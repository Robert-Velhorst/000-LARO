# Supply Chain and Dependency Review

Updated: 2026-09-22 | Branch: `milestone3/remediate-roadmap`

## Current result

`npm audit --audit-level=moderate` reports **0 known vulnerabilities** for the committed lockfile.

For implementation commit `dc3884b`, both full and production-only npm audits
report zero vulnerabilities. An isolated Python 3.12.13 install reports all 59
requirements compatible. The refreshed production Docker image reports zero
HIGH/CRITICAL Debian or Node findings under Trivy 0.74.0 and has a hashed
CycloneDX SBOM. Exact image, SBOM, and Windows artifact evidence is recorded in
`FOURTH_ROUND_VERIFICATION.md`.

The 2026-08-08 audit initially found two newly published high-severity
advisories. The lockfile was updated from `nanoid` 3.3.16 to 3.3.18 and from
transitive `js-yaml` 4.3.0 to 4.3.1. Both the complete dependency graph and
`--omit=dev` runtime graph then reported zero known vulnerabilities. No major
version or application API change was required.

The remediation upgraded the supported runtime to Node 22.12+, Electron 43, Vite 8, Vitest 4, electron-builder 26, better-sqlite3 13, Drizzle ORM 0.45, Nodemailer 9, and UUID 11. Unused `xlsx`, Stripe SDK, PDFKit, Tesseract, and their unused type packages were removed. `drizzle-kit` was also removed because its current dependency chain retained the final four advisories; checked-in SQL migrations remain the production migration source.

## Native module lifecycle

`better-sqlite3` 13 uses N-API and ships the supported Windows, macOS, Linux,
and Linux-musl binaries in its npm package. Node and Electron therefore use the
same stable native API, and Linux-hosted Windows packaging no longer risks
copying a host ELF binary into the Windows application.

- `npm run rebuild:node` refreshes the installed native package before server
  and test execution.
- `npm run rebuild:electron` remains a compatible operator command but uses the
  same N-API package instead of compiling an Electron-ABI-specific binary.
- electron-builder's source rebuild is disabled so it preserves the
  lockfile-integrity-checked platform prebuilts; Windows CI verifies the actual
  Electron load and packaged native architecture.

## Release rule

Run `npm ci --ignore-scripts`, `npm run rebuild:node`, and `npm run gate` from a
clean checkout. The gate blocks on both full-lockfile and runtime-only npm audit
findings at moderate severity or above. Audit status is time-sensitive and is
therefore refreshed on every pull request and `main` build.
