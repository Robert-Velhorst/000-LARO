# Feature flags and demo configuration

LARO keeps only flags that own a real runtime decision. The typed registry in
`server/featureFlags.ts` records each flag's owner, conservative default,
storage key, canonical reader, maintained consumers, and two-state behavioral
test. `tests/backend/featureFlags.test.ts` verifies every registered consumer
and test path so a definition with no maintained use fails the release suite.

## Maintained flag

| Key | Owner | Default | Runtime reader and consumers | Two-state proof |
|---|---|---:|---|---|
| `outreach.send.enabled` | Outreach delivery | `false` | `isOutreachSendingEnabled()` in the pre-send review, approval response, live-acceptance check, and provider send gate | `tests/backend/realSend.test.ts` proves disabled rejection and enabled delivery behavior |

The effective value is the persisted `system_config` row
`flag:outreach.send.enabled`, or `false` when the row is absent or unreadable.
There is no environment override, so an audited admin change cannot report
success while a hidden environment value keeps the behavior unchanged.

The protected `featureFlags.list` procedure returns only registered flags.
`featureFlags.set` is admin-only, persists only a registered key, and records a
mandatory `feature_flag.changed` audit event. Enabling this flag does not bypass
case ownership, Approved state, emergency stop, provider readiness,
idempotency, or audit requirements.

## Demo mode is configuration, not a flag

`DEMO_MODE` is the sole demo request. `ENV.isDemo` is its canonical runtime
decision and always resolves to `false` when `NODE_ENV=production`.
`system.appInfo`, admin diagnostics, and debug bundles read that same value.
Demo mode is not listed or mutable through the feature-flag API.

The retired `analytics.enabled` and `demo.mode` definitions had no maintained
behavior. Migrations `drizzle/0025_remove_dead_feature_flags.sql` and
`deploy/postgres/migrations/0008_remove_dead_feature_flags.sql` delete their
legacy storage rows.
