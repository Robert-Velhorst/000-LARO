# Lawyer-rating product decision

LARO does not calculate, advertise, or use a lawyer-performance rating.

The retired subsystem had no production writer connected to the outreach reply
lifecycle, no recalculation schedule, and no maintained renderer consumer. Its
optional matching boost therefore treated missing measurements as zero while
still implying that lawyer performance had been assessed. The response-quality
model also risked turning private owner communications into an unexplained
cross-account score.

The maintained matching score is now a 230-point calculation based only on the
documented lawyer and case fields: case load, response time, acceptance rate,
current availability, capacity, distance, experience, and curated legal-term
matches. An outreach reply remains attached to its owner-scoped case and audit
trail, but it cannot silently change a lawyer's score.

The public rating routes, model operation, dormant writers, schema exports,
calculation logs, and 15-point matching boost are removed. The retirement
migrations also remove the three unused tables. To protect an installation that
somehow contains legacy rating rows, each migration fails before dropping any
table; the operator must first export and explicitly review those rows.

A future feedback feature must be designed as a new owner-scoped product. It
must define consent, provenance, minimum sample size, confidence, visibility,
recalculation timing, correction and erasure behavior before it can affect
matching.
