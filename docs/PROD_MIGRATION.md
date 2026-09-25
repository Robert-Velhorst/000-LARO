# Prototype → Production Migration (Phase 103)

Date: 2026-07-06 · Branch `Phase-Imp`

LARO ships as a local-first Electron app. "Production" means a real installed
deployment for real cases (not the dev/demo environment).

## Preflight (automated: `npm run preflight`)
`scripts/prod-preflight.mjs` blocks go-live unless:
- `JWT_SECRET` and `COOKIE_SECRET` are set and strong (not the shipped placeholders) —
  enforced at runtime too by the config fail-safe (Phase 006).
- Demo mode is OFF (`system.appInfo.demoMode=false`).
- Migrations are present in `drizzle/`.
- No real `.env` is tracked in git (only `.env.example`).
- The current `package.json` version has a `CHANGELOG.md` entry (warn).

## Migration steps
1. Use Node 22.12+ and run `npm ci --ignore-scripts`.
2. Run `npm run rebuild:node` for server validation or `npm run rebuild:electron` immediately before desktop packaging.
3. Provide production credentials via the **environment**, never a bundled file
   (account safety — Phase 100).
4. Back up the database. Checked-in migrations in `drizzle/` apply automatically when the database opens.
5. `NODE_ENV=production npm run preflight` — must pass with no blockers.
6. `npm run gate` and `npm audit --audit-level=moderate` — both must pass.
7. Remove demo/seed data; verify `admin.invariants` is clean.
8. Keep the emergency stop engaged and `outreach.send.enabled` off until the real provider, approval, idempotency, ownership, and audit path is verified.

## Data migration
Prototype SQLite data can be carried over as-is (same schema). Use
`server/backup.ts` to snapshot before migrating, and `admin.reconcileReport` to
detect drift before and after migration. Startup verifies a recovery backup and
installs the declared native foreign keys transactionally; it does not erase
existing orphaned rows. If migration reports relationship orphans, restore or
retain the untouched source database, review the report, and run
`admin.repairOrphans` on the prior release only after the backup has been
validated and the deletion counts have been approved.
