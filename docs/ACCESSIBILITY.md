# Accessibility Review

Date: 2026-08-14

## Implemented controls

- Shared navigation, account, notification, assistant, filter, privacy, note,
  and comparison controls expose programmatic names.
- The Help FAQ uses native buttons with `aria-expanded` and `aria-controls`.
- Authentication fields provide name, email, current-password, new-password,
  and one-time-code autocomplete metadata.
- Radix UI primitives provide keyboard and focus behavior for dialogs, popovers,
  dropdowns, tabs, and selects.
- The authenticated dashboard mounts a localized skip link that moves focus to
  the main region. Closed mobile navigation is removed from the focus order;
  opening it moves focus inside, traps Tab/Shift+Tab, supports Escape, and
  restores focus to the opener.
- The renderer disables nonessential animation and transition duration when the
  operating system requests reduced motion.
- `server/accessibility.ts` provides contrast checks, keyboard activation,
  screen-reader announcements, focus trapping, and accessible-label helpers.

## Automated coverage

- `tests/a11y/accessibility.test.ts` covers contrast thresholds and identifier
  generation.
- `tests/frontend/productionUiAccessibility.test.ts` prevents regressions in
  responsive layout, control names, assistant sizing, notification semantics,
  truthful Help content, local shell assets, and authentication metadata.
- `tests/browser/rendererAccessibility.spec.ts` runs axe-core against every
  supported static route at 1440x900 and 390x844. It also blocks unnamed visible
  controls, missing primary headings, horizontal overflow, page errors, failed
  requests, and console errors. Its interaction audit verifies desktop shell
  focus order, skip-link behavior, mobile navigation focus containment and
  restoration, account and notification overlay geometry, keyboard FAQ state,
  and reduced-motion duration. GitHub Actions runs this as the
  `renderer-accessibility` job.
- Vitest runs only maintained suite directories. A recursive release regression
  check rejects test files outside those directories so excluded or broken
  tests cannot be represented as passing coverage.

## Renderer and package audit

The automated renderer audit exercises the Chromium surface used by Electron at
1440x900 and 390x844, while the Windows workflow separately verifies packaging,
the native database binding, and the packaged profile lock. The newest
exact-main executable has not been launched in this task because native launch
requires owner confirmation; that acceptance item remains explicit in the
roadmap. Fifteen mounted routes were checked at both sizes, including the
consolidated Evidence workspace.

- Every route rendered meaningful content and an `h1`.
- No visible button lacked an accessible name.
- No visible input, textarea, or select lacked a programmatic label.
- No image lacked alternative text.
- The Help accordion expanded through its button contract.
- The mobile assistant exposed named open, minimize, close, input, and send
  controls while remaining inside the viewport.
- The notification popover remained inside the mobile viewport and its trigger
  reported unread state through its accessible name.
- Keyboard focus never entered the closed mobile sidebar. The opened sidebar
  retained focus until Escape and then returned focus to the mobile trigger.
- Account and notification overlays remained inside their viewport and returned
  focus to their trigger when dismissed.
- The localized skip link became visible on focus and transferred focus to the
  main content region.
- Reduced-motion emulation limited transition and animation duration to at most
  one millisecond for the exercised interaction state.
- No page error, console error, or console warning occurred during the sweep.
- No serious or critical WCAG 2.0/2.1 A/AA axe-core violation remained. The
  audit found and fixed the global primary-button contrast token and required
  accessible names for every shared progress indicator.

Radix's generated `aria-hidden` compatibility selects are intentionally excluded
from the visible-field check.

## Remaining scope

- The route audit is not a complete WCAG conformance assessment.
- A human screen-reader session, route-specific keyboard review of complex case
  and evidence editors, and platform-normalized pixel baselines remain
  recommended before a public WCAG conformance claim. LARO does not claim
  formal conformance.
