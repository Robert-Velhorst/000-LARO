export const SEARCH_RESULT_TYPES = [
  "case",
  "lawyer",
  "evidence",
  "document",
  "communication",
] as const;

export type SearchResultType = (typeof SEARCH_RESULT_TYPES)[number];

export const SEARCH_DESTINATION_ROUTES = {
  case: "/cases",
  lawyer: "/lawyers/:id",
  evidence: "/evidence",
  document: "/evidence",
  communication: "/messages",
} as const satisfies Record<SearchResultType, string>;

export type SearchDestinationInput = {
  type: SearchResultType;
  id: string;
};

/**
 * Build the sole supported deep link for a global-search result.
 *
 * Record IDs, rather than result titles or other metadata, are carried in the
 * URL. The destination must resolve the ID again under the current session so
 * stale, deleted, or foreign results cannot disclose their prior metadata.
 */
export function getSearchDestination(result: SearchDestinationInput): string | null {
  if (!result.id.trim()) return null;

  const id = encodeURIComponent(result.id);
  switch (result.type) {
    case "case":
      return `${SEARCH_DESTINATION_ROUTES.case}?case=${id}`;
    case "lawyer":
      return SEARCH_DESTINATION_ROUTES.lawyer.replace(":id", id);
    case "evidence":
      return `${SEARCH_DESTINATION_ROUTES.evidence}?view=items&evidence=${id}`;
    case "document":
      return `${SEARCH_DESTINATION_ROUTES.document}?view=items&document=${id}`;
    case "communication":
      return `${SEARCH_DESTINATION_ROUTES.communication}?communication=${id}`;
  }
}

export function isRegisteredSearchDestination(destination: string): boolean {
  const pathname = new URL(destination, "https://laro.invalid").pathname;
  return pathname === SEARCH_DESTINATION_ROUTES.case
    || pathname === SEARCH_DESTINATION_ROUTES.evidence
    || pathname === SEARCH_DESTINATION_ROUTES.communication
    || /^\/lawyers\/[^/]+$/.test(pathname);
}
