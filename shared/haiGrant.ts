export const HAI_FIELD_CATEGORIES = [
  "case_overview",
  "analysis_summary",
  "analysis_claims",
  "analysis_obligations",
  "analysis_legal_issues",
  "analysis_timeline",
] as const;

export type HaiFieldCategory = (typeof HAI_FIELD_CATEGORIES)[number];

export const HAI_FIELD_CATEGORY_LABELS: Record<HaiFieldCategory, string> = {
  case_overview: "Case overview",
  analysis_summary: "Analysis summary",
  analysis_claims: "Claims",
  analysis_obligations: "Obligations and deadlines",
  analysis_legal_issues: "Legal issues",
  analysis_timeline: "Timeline events",
};

export const HAI_ANALYSIS_FIELD_CATEGORIES = HAI_FIELD_CATEGORIES.filter(
  (category): category is Exclude<HaiFieldCategory, "case_overview"> => category !== "case_overview",
);

export interface HaiGrantReview {
  caseIds: string[];
  fieldCategories: HaiFieldCategory[];
  includeFutureCases: boolean;
  includeFutureAnalyses: boolean;
  acknowledgeCaseScope: true;
  acknowledgeFieldScope: true;
  acknowledgeFutureRecords: true;
}
