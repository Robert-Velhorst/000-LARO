# Dependency and Package Audit

Current as of 2026-08-01.

The repository has one active Node workspace at the root. The obsolete duplicate
manifest and lockfile formerly stored under `assets/` were removed; `assets/`
now contains only the two validated JSON datasets copied into Desktop builds.

## Shipped source roots

| Root | Purpose |
| --- | --- |
| `server/` | Express/tRPC API, data access, providers, workflow and operations |
| `src/renderer/` | React dashboard and scanner mini-app |
| `src-main/` | Electron lifecycle, native scanner, IPC and uploader |
| `shared/` | Canonical cross-process contracts |
| `drizzle/` | SQLite migration history |
| `scripts/` | Build, diagnostics, safety, recovery and release tools |

Electron packaging includes `dist`, production `node_modules`, `drizzle`,
`package.json`, and only the two matcher datasets explicitly listed in
`build.extraResources`. Development Python/HTML assets, local configuration,
databases, uploads, and token stores are not packaged.

## Required runtime groups

- React, Radix, TanStack Query, tRPC, Wouter, Recharts, Tailwind helpers and
  Lucide power the renderer.
- Express, tRPC, Zod, Drizzle and better-sqlite3 power the local API.
- Google APIs, Microsoft Graph, AWS S3, Nodemailer/SendGrid, Telegram and
  provider adapters are conditional integrations.
- Socket.IO powers authenticated user-scoped notifications.
- Archiver powers provenance-preserving ZIP evidence export.
- bcrypt and jsonwebtoken power account and session controls.

## Document-processing surface

The desktop runtime intentionally retains `pdf-parse`, `mammoth`, `tesseract.js`,
and the Dutch and English Tesseract datasets because shipped document analysis
uses them for PDF, DOCX, and image evidence. Electron packaging unpacks the OCR
worker runtime and language data required by the packaged application. The Flask
document-intelligence runtime has its own Python dependencies in
`requirements.txt`.

## Release checks

- `npm ci --ignore-scripts` must reproduce the lockfile.
- `npm audit --omit=dev` must have no unresolved runtime advisory.
- The TypeScript and renderer builds prove every declared import resolves.
- `npm run verify:electron-native` proves the packaged SQLite ABI.
- Tagged artifacts must be version-matched, acceptance-approved, and accompanied
  by a SHA-256 checksum. Configured signing modes must also be
  Authenticode-valid; owner-selected unsigned builds remain untrusted by Windows.

The 2026-08-01 audit updated only patched transitive lockfile resolutions for
`brace-expansion` and `tar`. Both `npm audit` and `npm audit --omit=dev` then
reported zero known vulnerabilities; the application gate and recovery drills
passed with the resulting lockfile.
