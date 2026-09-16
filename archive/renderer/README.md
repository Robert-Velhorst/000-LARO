# Archived renderer prototypes

These files were not reachable from `src/renderer/main.tsx` when the maintained renderer boundary was established. They are retained only as historical design references.

They are not shipped, supported, typechecked as product code, or evidence that a feature exists. Reintroducing any capability requires a roadmap issue, reconciliation with the current tRPC and component contracts, tests through the mounted product path, and a reviewed move back into `src/renderer/`.

The obsolete `GmailFilteredSync` prototype was deleted instead of archived because it accepted a provider token in renderer props and called procedures that no longer exist.
