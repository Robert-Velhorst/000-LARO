# Managed evidence acceptance downloads

Google mail and Drive acceptance retain their explicit owner/account consent,
stored-content provenance, byte limits, deadline, content-hash comparison and
source-open audit. The HTTP retrieval now also binds its destination to the
selected owner's current managed storage object.

The destination is resolved through the existing storage SDK or signed local
download route. A changed owner/key, missing managed object, legacy `fileUrl`,
different origin/path, URL credentials, fragment, control characters or redirect
is rejected. Signed query parameters are retained because regenerating a URL
may change its timestamp/signature; they do not select another destination.
The storage service's configured origin remains an operator trust boundary.
This supports the existing local/desktop and S3 paths without hardcoding an
AWS region, endpoint spelling or partition.

The ordinary user-facing evidence-link API keeps its existing legacy behavior.
The stronger managed-object requirement applies to the acceptance HTTP path.
No data is copied, deleted or migrated by this code change, and no acceptance
receipt is created merely by preparing or building it.

Existing test cases and gates are unchanged. Their injected source readers do
not independently prove the new production HTTP denial paths. Exact-head
hosted checks, current CodeQL analysis and real operator-approved provider and
storage acceptance remain separate evidence requirements. Do not dismiss an
alert or infer live deployment from this draft.
