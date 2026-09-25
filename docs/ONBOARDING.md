# Onboarding contract

LARO has one maintained first-run flow for the desktop application and hosted
browser renderer. `DashboardApp` mounts `OnboardingFlow` after authentication;
both clients use the same protected `onboarding` tRPC router.

## State and ownership

Only presentation state is stored in `system_config`, under
`onboarding:state:<userId>`:

- `status`: `active`, `skipped`, or `complete`
- `currentStepKey`: `case`, `evidence`, or `outreach`

The signed-in user ID always comes from the authenticated server context. The
client cannot select another owner's state. The previous
`onboarding:complete:<userId>` boolean is migrated on first read and removed in
the same local transaction.

Because this presentation state is personal account data stored without a
`userId` column, the GDPR export and erasure services include and delete both
onboarding key shapes explicitly.

The renderer forces a fresh state query whenever the authenticated account
changes. A cached state from one account is therefore never treated as the
state of the next account.

## Real completion milestones

Progress is derived on every state read instead of being trusted from a client
flag:

1. the account owns at least one case;
2. evidence owned by the account is attached to one of its cases;
3. an outreach record exists for one of its cases.

The server rejects `complete` until all three records exist. Resetting the guide
reopens its presentation state but does not erase real workspace data, so
completed milestones remain visible.

## User lifecycle

- **Continue later** closes the dialog for the current browser session while
  retaining the current step. Reloading or signing in again resumes it.
- **Skip setup** persists only for the signed-in account.
- **Setup guide** in the account menu opens an active guide or resets a skipped
  or completed guide to its first step.
- Logout and account changes remount the flow and fetch the new owner's state.

The guide links only to mounted `/cases`, `/evidence`, and `/outreach` routes. It
does not claim a lawyer count, automatic AI matching, keyboard shortcuts, or
automatic sending. It repeats the legal-assistance boundary and states that
outreach requires explicit review and approval.

## Verification

`tests/backend/onboardingLifecycle.test.ts` covers authentication, resume,
skip, reset, completion prerequisites, legacy migration, and two-account data
isolation. The Playwright lifecycle in
`tests/browser/rendererAccessibility.spec.ts` covers first run, reload, real
logout/login, account switching, completion, restart, HTTP success, browser
errors, accessibility, responsive layout, and desktop/mobile screenshots.
