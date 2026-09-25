# Billing Compatibility Archive

Current as of 2026-09-23.

LARO is a local, unmetered product. It has no checkout, paid tier, payment
provider, subscription enforcement, or operational quota gate. Migration
`0033_billing_compatibility_archive.sql` removes those obsolete compatibility
fields from the active SQLite model.

## What is retained

When an installed database contains non-empty historical values, the migration
writes one JSON row per source record to `legacy_billing_archive`:

- user subscription, Stripe customer/subscription, payment-failure, and
  grace-period values;
- historical `billing_periods` rows;
- historical `usage_limits` rows; and
- `usage_tracking` rows that contain monetary or Stripe-reporting state.

The archive records the source table, source ID, owner ID, payload, and archive
timestamp. Operational usage rows with no obsolete billing state remain in the
canonical `usage_tracking` table with quantity and provenance fields only.

## Read-only boundary

The migration installs `BEFORE INSERT`, `BEFORE UPDATE`, and `BEFORE DELETE`
triggers on `legacy_billing_archive`. Any attempted write fails with a
read-only error. No runtime router reads the archive to decide access, limits,
pricing, or payment state. If historical evidence is needed, inspect a verified
backup or the archive through an operator-approved database read; never disable
the triggers or recreate the removed tables.

Clean installs and upgrades converge on the same active schema. The migration
is covered by upgrade, clean-install, archive-content, trigger, foreign-key,
and second-boot idempotence tests.
