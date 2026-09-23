# Local Operation Without Billing (Phase 056)

Current as of 2026-07-16.

LARO's supported product is fully usable without billing. Core case, evidence,
analysis, matching, timeline, review, and export workflows have no payment or
quota gate.

- `billing.status` reports `plan: "local"`, `billingConfigured:false`, and
  `forcedBilling:false`.
- `server/usageTracking.ts` stores operation and quantity counts as local
  operational telemetry. It does not calculate charges, report to a payment
  provider, send quota alerts, or block an action.
- Pricing, checkout, upgrade, grace-period, and usage-quota prototypes are not
  part of the production renderer or server runtime.
- Migration `0033` removes historical subscription, payment, Stripe, usage-limit,
  and monetary columns from the active schema. Non-empty legacy values are
  retained only in the database-enforced read-only `legacy_billing_archive`;
  they are not product policy and are never used to gate an action.

This contract is verified in `tests/backend/phase051_060.test.ts` and
`tests/backend/usageTelemetry.test.ts`.
