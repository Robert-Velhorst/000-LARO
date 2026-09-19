# Literal Search Contract

Current as of 2026-09-20. The maintained contract version is
`literal-search-v1`.

## Query meaning

All maintained local text-search surfaces interpret user text literally. LARO
does not expose an implicit regular-expression, glob, or SQL `LIKE` language.
The characters `%`, `_`, `\`, `[`, `]`, `(`, `)`, `.`, `*`, `+`, `?`, `^`, `$`,
and `|` are ordinary searchable characters.

Before matching, both the entered query and candidate text use the same
deterministic normalization:

1. Unicode NFKC normalization;
2. leading and trailing whitespace removal;
3. internal whitespace collapse to one space; and
4. Unicode-aware lower-casing.

SQL matching escapes `\`, `%`, and `_` before adding the product-owned prefix or
contains wildcards. Relevance ranking uses normalized string comparisons and
never constructs a regular expression from user input.

## Covered surfaces

The contract is shared by global search, paginated case search, hybrid case
keywords, evidence-file search, evidence timeline search, lawyer directory
query/legal-area filters, suggestions, and saved-search replay. Saved searches
retain the owner's entered text and record the current contract version; loading
one sends that text through the same maintained case, lawyer, or evidence path.

## Completeness

Global-search responses list the requested, completed, partial, failed, and
unavailable categories. Suggestion responses provide the same boundary for case
types, lawyer names, and lawyer cities. A category failure uses a stable reason
code and never returns raw database errors.

A malformed legacy row is isolated. Searchable safe fields still produce a
result, recoverable legacy legal-area text is preserved, and the affected
category is marked partial. Other categories continue independently. The global
search dialog therefore shows **No results found** only after every requested
category completed; partial and failed responses display an explicit retryable
state alongside any successful results.

Private cases, evidence, documents, communications, and case-derived suggestions
remain owner-scoped before matching. Lawyer directory records remain shared
authenticated reference data.
