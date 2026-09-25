import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  FileWarning,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Scale,
  FileText,
  Search,
  Loader2,
  Building2,
} from "lucide-react";
import { PublicRecordsPanel } from "./PublicRecordsPanel";
import { LegalDocumentGenerator } from "./LegalDocumentGenerator";
import { useI18n } from "../contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

interface EvidenceGapAnalysisDashboardProps {
  caseId: string;
}

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

const GAP_TYPE_KEYS: Record<string, TranslationKey> = {
  sudden_silence: "coverage.gap.suddenSilence",
  no_response: "coverage.gap.noResponse",
};
const INPUT_TYPE_KEYS: Record<string, TranslationKey> = {
  communication: "coverage.inputType.communication",
  timeline_event: "coverage.inputType.timeline_event",
  evidence_record: "coverage.inputType.evidence_record",
  evidence_file: "coverage.inputType.evidence_file",
};
const AVAILABILITY_KEYS: Record<string, TranslationKey> = {
  available: "coverage.availability.available",
  unavailable: "coverage.availability.unavailable",
  external_unverified: "coverage.availability.external_unverified",
  record_only: "coverage.availability.record_only",
};
const REVIEW_STATUS_KEYS: Record<string, TranslationKey> = {
  reviewed: "coverage.reviewStatus.reviewed",
  unreviewed: "coverage.reviewStatus.unreviewed",
};
const ANALYSIS_STATUS_KEYS: Record<string, TranslationKey> = {
  current: "coverage.analysisStatus.current",
  not_analyzed: "coverage.analysisStatus.not_analyzed",
  unbound: "coverage.analysisStatus.unbound",
  stale: "coverage.analysisStatus.stale",
  failed: "coverage.analysisStatus.failed",
  not_applicable: "coverage.analysisStatus.not_applicable",
};
const PATTERN_KEYS: Record<string, TranslationKey> = {
  documented_to_verbal_shift: "coverage.pattern.documented_to_verbal_shift",
  missing_expected_documents: "coverage.pattern.missing_expected_documents",
};
const CATEGORY_KEYS: Record<string, TranslationKey> = {
  communication_channel_change: "coverage.category.communication_channel_change",
  records_gap: "coverage.category.records_gap",
  no_response_review: "coverage.category.no_response_review",
};
const UNKNOWN_LABEL_KEYS: Record<string, TranslationKey> = {
  legal_basis_unknown: "coverage.unknown.legal_basis_unknown",
  no_inputs: "coverage.unknown.no_inputs",
  unreviewed_records: "coverage.unknown.unreviewed_records",
  source_unavailable: "coverage.unknown.source_unavailable",
  external_source_unverified: "coverage.unknown.external_source_unverified",
  exact_duplicates: "coverage.unknown.exact_duplicates",
  automated_contradiction_flags: "coverage.unknown.automated_contradiction_flags",
  analysis_revision_unbound: "coverage.unknown.analysis_revision_unbound",
  stale_analysis: "coverage.unknown.stale_analysis",
  missing_context: "coverage.unknown.missing_context",
};
const UNKNOWN_DETAIL_KEYS: Record<string, TranslationKey> = {
  legal_basis_unknown: "coverage.unknownDetail.legal_basis_unknown",
  no_inputs: "coverage.unknownDetail.no_inputs",
  unreviewed_records: "coverage.unknownDetail.unreviewed_records",
  source_unavailable: "coverage.unknownDetail.source_unavailable",
  external_source_unverified: "coverage.unknownDetail.external_source_unverified",
  exact_duplicates: "coverage.unknownDetail.exact_duplicates",
  automated_contradiction_flags: "coverage.unknownDetail.automated_contradiction_flags",
  analysis_revision_unbound: "coverage.unknownDetail.analysis_revision_unbound",
  stale_analysis: "coverage.unknownDetail.stale_analysis",
  missing_context: "coverage.unknownDetail.missing_context",
};
const LIMITATION_KEYS: Record<string, TranslationKey> = {
  "This snapshot inventories only records currently visible to LARO; records held elsewhere remain unknown.": "coverage.limitation.visibleOnly",
  "Record counts, source availability, duplicate signals, and context gaps do not establish claim support, legal merit, liability, or likely outcome.": "coverage.limitation.noMerit",
  "Automated contradiction flags and missing-context signals require human review against the original sources.": "coverage.limitation.humanReview",
  "External references are not treated as available unless their contents are imported and revision-bound.": "coverage.limitation.externalUnavailable",
};
const REVIEW_ACTION_KEYS: Record<string, TranslationKey> = {
  "Restore or relink unavailable managed sources before relying on their metadata.": "coverage.action.restoreSource",
  "Open and verify external references; LARO did not fetch them for this snapshot.": "coverage.action.verifyExternal",
  "Review the listed records and record an explicit review marker where appropriate.": "coverage.action.reviewRecords",
  "Review exact duplicates once and retain the record with the clearest provenance.": "coverage.action.reviewDuplicates",
  "Review every automated contradiction flag against its cited source passages.": "coverage.action.reviewContradictions",
  "Check the listed missing-context items against records inside and outside LARO.": "coverage.action.checkMissingContext",
  "Ask a qualified lawyer to identify and review the applicable legal-basis sources.": "coverage.action.legalBasis",
};

function translatedCode(value: unknown, keys: Record<string, TranslationKey>, t: Translate): string {
  const normalized = String(value ?? "");
  return keys[normalized] ? t(keys[normalized]) : normalized.replaceAll("_", " ");
}

export function EvidenceGapAnalysisDashboard({ caseId }: EvidenceGapAnalysisDashboardProps) {
  const { t, formatNumber } = useI18n();
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Fetch gap analysis data
  const { data: summary, refetch: refetchSummary, isLoading: summaryLoading } = trpc.gapAnalysis.getSummary.useQuery({
    caseId,
  });

  const freshAnalysis = summary?.analysisStatus === "fresh";
  const { data: gaps, refetch: refetchGaps } = trpc.gapAnalysis.getGaps.useQuery({ caseId }, { enabled: freshAnalysis });
  const { data: expectedDocs, refetch: refetchDocs } = trpc.gapAnalysis.getExpectedDocuments.useQuery({ caseId }, { enabled: freshAnalysis });
  const { data: patterns, refetch: refetchPatterns } = trpc.gapAnalysis.getPatterns.useQuery({ caseId }, { enabled: freshAnalysis });
  const { data: inferences, refetch: refetchInferences } = trpc.gapAnalysis.getInferences.useQuery({ caseId }, { enabled: freshAnalysis });
  const { data: coverage, refetch: refetchCoverage } = trpc.gapAnalysis.getCoverage.useQuery({ caseId });

  const normalizedGaps = ((gaps ?? []) as any[]);
  const normalizedExpectedDocs = ((expectedDocs ?? []) as any[]);
  const normalizedPatterns = ((patterns ?? []) as any[]);
  const normalizedInferences = ((inferences ?? []) as any[]);
  const coverageData = ((coverage ?? summary?.coverage ?? {}) as any);
  const coverageInputs = (Array.isArray(coverageData.inputs) ? coverageData.inputs : []) as any[];
  const coverageUnknowns = (Array.isArray(coverageData.unknowns) ? coverageData.unknowns : []) as any[];
  const coverageLimitations = (Array.isArray(coverageData.limitations) ? coverageData.limitations : []) as string[];
  const coverageActions = (Array.isArray(coverageData.reviewActions) ? coverageData.reviewActions : []) as string[];
  const coverageCounts = (coverageData.counts ?? {}) as Record<string, number>;

  const analyzeMutation = trpc.gapAnalysis.analyze.useMutation({
    onSuccess: () => {
      setAnalyzing(false);
      setAnalysisError(null);
      // Refetch all gap analysis data
      refetchSummary();
      refetchGaps();
      refetchDocs();
      refetchPatterns();
      refetchInferences();
      refetchCoverage();
    },
    onError: (err) => {
      setAnalyzing(false);
      setAnalysisError(err.message || t("coverage.errorFallback"));
      void refetchSummary();
      void refetchCoverage();
    },
  });

  // Auto-run analysis when caseId changes and no analysis exists yet
  useEffect(() => {
    if (caseId && !summaryLoading && summary?.analysisStatus === "none" && !analyzing) {
      setAnalyzing(true);
      analyzeMutation.mutate({ caseId });
    }
  }, [caseId, summaryLoading, summary?.analysisStatus]);

  const handleAnalyze = () => {
    setAnalysisError(null);
    setAnalyzing(true);
    analyzeMutation.mutate({ caseId });
  };

  const nonFreshStatus = summary?.analysisStatus;
  if (nonFreshStatus && nonFreshStatus !== "none" && nonFreshStatus !== "fresh") {
    const states = {
      stale: {
        title: "coverage.state.staleTitle",
        detail: "coverage.state.staleDetail",
      },
      running: {
        title: "coverage.state.runningTitle",
        detail: "coverage.state.runningDetail",
      },
      failed: {
        title: "coverage.state.failedTitle",
        detail: "coverage.state.failedDetail",
      },
      unavailable: {
        title: "coverage.state.unavailableTitle",
        detail: "coverage.state.unavailableDetail",
      },
      retired: {
        title: "coverage.state.retiredTitle",
        detail: "coverage.state.retiredDetail",
      },
    } as const satisfies Record<string, { title: TranslationKey; detail: TranslationKey }>;
    const state = states[nonFreshStatus];
    return (
      <Card data-testid={`gap-analysis-state-${nonFreshStatus}`}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {nonFreshStatus === "running"
              ? <Loader2 className="h-5 w-5 animate-spin" />
              : <AlertTriangle className="h-5 w-5" />}
            {t(state.title)}
          </CardTitle>
          <CardDescription>{summary?.statusReason || t(state.detail)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {analysisError ? <Alert variant="destructive"><AlertDescription>{analysisError}</AlertDescription></Alert> : null}
          <p className="text-sm text-muted-foreground">{t(state.detail)}</p>
          {nonFreshStatus !== "running" ? (
            <Button onClick={handleAnalyze} disabled={analyzing}>
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? t("coverage.reviewing") : t("coverage.recompute")}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  if (!summary?.hasAnalysis) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            {t("coverage.title")}
          </CardTitle>
          <CardDescription>{t("coverage.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <FileWarning className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">{t("coverage.noneTitle")}</h3>
            <p className="text-muted-foreground mb-6">{t("coverage.noneBody")}</p>
            <Button onClick={handleAnalyze} disabled={analyzing}>
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? t("coverage.reviewing") : t("coverage.run")}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const getSignificanceBadge = (significance: string) => {
    switch (significance) {
      case "critical":
        return <Badge variant="destructive">{t("coverage.significance.critical")}</Badge>;
      case "important":
        return <Badge className="bg-orange-500">{t("coverage.significance.important")}</Badge>;
      default:
        return <Badge variant="secondary">{t("coverage.significance.context")}</Badge>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "missing":
        return (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" />
            {t("coverage.status.missing")}
          </Badge>
        );
      case "delayed":
        return (
          <Badge className="bg-orange-500 gap-1">
            <Clock className="h-3 w-3" />
            {t("coverage.status.delayed")}
          </Badge>
        );
      case "received":
        return (
          <Badge variant="default" className="bg-green-600 gap-1">
            <CheckCircle2 className="h-3 w-3" />
            {t("coverage.status.received")}
          </Badge>
        );
      case "incomplete":
        return <Badge variant="secondary">{t("coverage.status.incomplete")}</Badge>;
      default:
        return <Badge variant="secondary">{translatedCode(status, {}, t)}</Badge>;
    }
  };

  const getReviewBadge = (status: string) => (
    <Badge variant="secondary">{t(status === "review_required" ? "coverage.review.required" : "coverage.review.unverified")}</Badge>
  );

  return (
    <div className="space-y-6">
      {coverageData.contractStatus === "retired" ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("coverage.state.retiredTitle")}</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {coverageData.retirementReason
                || t("coverage.state.retiredDetail")}
            </p>
            <Button onClick={handleAnalyze} disabled={analyzing} size="sm" variant="outline">
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? t("coverage.reviewing") : t("coverage.createCurrent")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : coverageData.contractStatus === "current" ? (
        <Card data-testid="gap-analysis-state-fresh">
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              {t("coverage.freshTitle")}
              <Badge variant="outline">{t("coverage.currentRevision")}</Badge>
            </CardTitle>
            <CardDescription>
              {t("coverage.summary", {
                inputs: formatNumber(coverageCounts.inputRecords ?? 0),
                available: formatNumber(coverageCounts.sourceAvailable ?? 0),
                unavailable: formatNumber(coverageCounts.sourceUnavailable ?? 0),
                external: formatNumber(coverageCounts.externalSourcesUnverified ?? 0),
                unreviewed: formatNumber(coverageCounts.unreviewed ?? 0),
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {([
                ["coverage.count.inputRecords", coverageCounts.inputRecords ?? 0],
                ["coverage.count.available", coverageCounts.sourceAvailable ?? 0],
                ["coverage.count.unavailable", coverageCounts.sourceUnavailable ?? 0],
                ["coverage.count.unreviewed", coverageCounts.unreviewed ?? 0],
              ] satisfies Array<[TranslationKey, number]>).map(([labelKey, value]) => (
                <div key={labelKey} className="rounded-lg border p-3">
                  <div className="text-2xl font-semibold">{formatNumber(value)}</div>
                  <div className="text-xs text-muted-foreground">{t(labelKey)}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><span className="font-medium">{t("coverage.count.exactDuplicates")}</span> {formatNumber(coverageCounts.exactDuplicateRecords ?? 0)}</div>
              <div><span className="font-medium">{t("coverage.count.contradictions")}</span> {formatNumber(coverageCounts.automatedContradictionFlags ?? 0)}</div>
              <div><span className="font-medium">{t("coverage.count.missingContext")}</span> {formatNumber(coverageCounts.missingContextItems ?? 0)}</div>
              <div><span className="font-medium">{t("coverage.count.externalUnverified")}</span> {formatNumber(coverageCounts.externalSourcesUnverified ?? 0)}</div>
            </div>

            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{t("coverage.legalBasisUnknown")}</AlertTitle>
              <AlertDescription>
                {coverageData.legalBasis?.status === "unknown"
                  ? t("coverage.legalBasisFallback")
                  : coverageData.legalBasis?.detail || t("coverage.legalBasisFallback")}
              </AlertDescription>
            </Alert>

            <div>
              <h4 className="mb-2 font-semibold">{t("coverage.unknowns")}</h4>
              {coverageUnknowns.length > 0 ? (
                <ul className="space-y-2">
                  {coverageUnknowns.map((unknown: any) => (
                    <li key={unknown.code} className="rounded-lg bg-muted/50 p-3 text-sm">
                      <div className="font-medium">{translatedCode(unknown.code, UNKNOWN_LABEL_KEYS, t)}</div>
                      <div className="text-muted-foreground">
                        {UNKNOWN_DETAIL_KEYS[String(unknown.code)]
                          ? t(UNKNOWN_DETAIL_KEYS[String(unknown.code)], {
                            count: formatNumber(coverageCounts.missingContextItems ?? 0),
                          })
                          : unknown.detail}
                      </div>
                      {Array.isArray(unknown.inputIds) && unknown.inputIds.length > 0 && (
                        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {t("coverage.inputs")} {unknown.inputIds.join(", ")}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t("coverage.unknownsNone")}</p>
              )}
            </div>

            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer font-semibold">{t("coverage.exactInputs")}</summary>
              <div className="mt-4 space-y-3">
                {coverageInputs.length > 0 ? coverageInputs.map((input: any) => (
                  <div key={`${input.inputType}:${input.id}`} className="rounded-md bg-muted/50 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{input.label}</span>
                      <Badge variant="outline">{translatedCode(input.inputType, INPUT_TYPE_KEYS, t)}</Badge>
                      <Badge variant="secondary">{translatedCode(input.sourceAvailability, AVAILABILITY_KEYS, t)}</Badge>
                      <Badge variant="secondary">{translatedCode(input.reviewStatus, REVIEW_STATUS_KEYS, t)}</Badge>
                    </div>
                    <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {t("coverage.meta.id")} {input.inputType}:{input.id}<br />
                      {t("coverage.meta.inputRevision")} {input.revision}<br />
                      {input.contentHash ? <>{t("coverage.meta.contentHash")} {input.contentHash}<br /></> : null}
                      {t("coverage.meta.analysis")} {translatedCode(input.analysisStatus, ANALYSIS_STATUS_KEYS, t)}
                      {input.analysisRevision ? <><br />{t("coverage.meta.analysisRevision")} {input.analysisRevision}</> : null}
                      {input.duplicateOf ? <><br />{t("coverage.meta.duplicateOf")} {input.duplicateOf}</> : null}
                      {Number(input.contradictionFlags) > 0
                        ? <><br />{t("coverage.meta.automatedContradictions")} {formatNumber(Number(input.contradictionFlags))}</>
                        : null}
                    </div>
                  </div>
                )) : (
                  <p className="text-sm text-muted-foreground">{t("coverage.noInputs")}</p>
                )}
              </div>
            </details>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 font-semibold">{t("coverage.limitations")}</h4>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {coverageLimitations.map((limitation, index) => (
                    <li key={index}>• {LIMITATION_KEYS[limitation] ? t(LIMITATION_KEYS[limitation]) : limitation}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="mb-2 font-semibold">{t("coverage.reviewActions")}</h4>
                <ol className="space-y-1 text-sm text-muted-foreground">
                  {coverageActions.map((action, index) => (
                    <li key={index}>{formatNumber(index + 1)}. {REVIEW_ACTION_KEYS[action] ? t(REVIEW_ACTION_KEYS[action]) : action}</li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="break-all border-t pt-3 font-mono text-xs text-muted-foreground">
              {t("coverage.meta.contract")} {coverageData.contractVersion}<br />
              {t("coverage.meta.analysisInputRevision")} {coverageData.inputRevision}<br />
              {t("coverage.meta.caseRevision")} {coverageData.caseRevision}<br />
              {t("coverage.meta.sourceRevision")} {coverageData.sourceRevision}<br />
              {t("coverage.meta.snapshotRevision")} {coverageData.snapshotRevision}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Detailed Analysis Tabs */}
      <Tabs defaultValue="gaps" className="w-full">
        <TabsList className="grid w-full grid-cols-2 group-data-[orientation=horizontal]/tabs:h-auto sm:grid-cols-3 lg:grid-cols-6">
          <TabsTrigger value="gaps" className="gap-2">
            <Clock className="h-4 w-4" />
            {t("coverage.tabs.context", { count: formatNumber(summary?.gapsCount || 0) })}
          </TabsTrigger>
          <TabsTrigger value="documents" className="gap-2">
            <FileText className="h-4 w-4" />
            {t("coverage.tabs.records", { count: formatNumber(summary?.missingDocsCount || 0) })}
          </TabsTrigger>
          <TabsTrigger value="patterns" className="gap-2">
            <AlertTriangle className="h-4 w-4" />
            {t("coverage.tabs.rules", { count: formatNumber(summary?.patternsCount || 0) })}
          </TabsTrigger>
          <TabsTrigger value="inferences" className="gap-2">
            <Scale className="h-4 w-4" />
            {t("coverage.tabs.review", { count: formatNumber(summary?.inferencesCount || 0) })}
          </TabsTrigger>
          <TabsTrigger value="records" className="gap-2">
            <Building2 className="h-4 w-4" />
            {t("coverage.tabs.publicRecords")}
          </TabsTrigger>
          <TabsTrigger value="legal-docs" className="gap-2">
            <FileText className="h-4 w-4" />
            {t("coverage.tabs.legalDocs")}
          </TabsTrigger>
        </TabsList>

        {/* Communication Gaps */}
        <TabsContent value="gaps" className="space-y-4">
          {normalizedGaps.length > 0 ? (
            normalizedGaps.map((gap) => (
              <Card key={gap.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <CardTitle className="text-base">{gap.context}</CardTitle>
                        {getSignificanceBadge(gap.significance)}
                      </div>
                      <CardDescription>
                        {t("coverage.gap.summary", {
                          days: formatNumber(Number(gap.durationDays) || 0),
                          type: translatedCode(gap.gapType, GAP_TYPE_KEYS, t),
                        })}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {gap.legalImplications && gap.legalImplications.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("coverage.reviewPrompts")}</h4>
                      <ul className="space-y-1">
                        {gap.legalImplications.map((implication: string, idx: number) => (
                          <li key={idx} className="text-sm text-muted-foreground">
                            • {implication}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {t("coverage.empty.context")}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Expected Documents */}
        <TabsContent value="documents" className="space-y-4">
          {normalizedExpectedDocs.length > 0 ? (
            normalizedExpectedDocs.map((doc) => (
              <Card key={doc.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <CardTitle className="text-base">
                          {doc.documentType.replace("_", " ").toUpperCase()}
                        </CardTitle>
                        {getStatusBadge(doc.status)}
                        {doc.legalRequirement && (
                          <Badge variant="outline" className="gap-1">
                            <Scale className="h-3 w-3" />
                            {t("coverage.claimedRequirement")}
                          </Badge>
                        )}
                      </div>
                      <CardDescription>{doc.reason}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                {doc.legalBasis && (
                  <CardContent>
                    <div className="text-sm">
                      <span className="font-semibold">{t("coverage.claimedBasis")} </span>
                      <span className="text-muted-foreground">{doc.legalBasis}</span>
                    </div>
                  </CardContent>
                )}
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {t("coverage.empty.records")}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Suspicious Patterns */}
        <TabsContent value="patterns" className="space-y-4">
          {normalizedPatterns.length > 0 ? (
            normalizedPatterns.map((pattern) => (
              <Card key={pattern.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <CardTitle className="text-base">{pattern.description}</CardTitle>
                        <Badge variant="outline">{t("coverage.ruleMatch")}</Badge>
                      </div>
                      <CardDescription>
                        {translatedCode(pattern.patternType, PATTERN_KEYS, t)}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                {pattern.legalSignificance && (
                  <CardContent>
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>{t("coverage.reviewNote")}</AlertTitle>
                      <AlertDescription>{pattern.legalSignificance}</AlertDescription>
                    </Alert>
                  </CardContent>
                )}
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {t("coverage.empty.rules")}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Legal Inferences */}
        <TabsContent value="inferences" className="space-y-4">
          {normalizedInferences.length > 0 ? (
            normalizedInferences.map((inference) => (
              <Card key={inference.id}>
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <CardTitle className="text-base">{inference.inference}</CardTitle>
                        {getReviewBadge(inference.strength)}
                      </div>
                      {inference.category && (
                        <CardDescription>
                          {translatedCode(inference.category, CATEGORY_KEYS, t)}
                        </CardDescription>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {inference.legalPrinciple && (
                    <div>
                      <h4 className="font-semibold text-sm mb-1">{t("coverage.reviewLimitation")}</h4>
                      <p className="text-sm text-muted-foreground">{inference.legalPrinciple}</p>
                    </div>
                  )}
                  {inference.supportingEvidence && inference.supportingEvidence.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("coverage.relatedFacts")}</h4>
                      <ul className="space-y-1">
                        {inference.supportingEvidence.map((evidence: string, idx: number) => (
                          <li key={idx} className="text-sm text-muted-foreground">
                            • {evidence}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {inference.caselaw && inference.caselaw.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-sm mb-2">{t("coverage.unverifiedLegalReferences")}</h4>
                      <ul className="space-y-1">
                        {inference.caselaw.map((law: string, idx: number) => (
                          <li key={idx} className="text-sm text-muted-foreground font-mono">
                            • {law}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {t("coverage.empty.review")}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Public Records */}
        <TabsContent value="records" className="space-y-4">
          <PublicRecordsPanel caseId={caseId} />
        </TabsContent>

        {/* Legal Document Generator */}
        <TabsContent value="legal-docs" className="space-y-4">
          <LegalDocumentGenerator caseId={caseId} />
        </TabsContent>
      </Tabs>

      {/* Re-analyze Button */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold">{t("coverage.rerunTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("coverage.rerunDescription")}</p>
            </div>
            <Button onClick={handleAnalyze} disabled={analyzing} variant="outline">
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? t("coverage.reviewing") : t("coverage.rerunAction")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
