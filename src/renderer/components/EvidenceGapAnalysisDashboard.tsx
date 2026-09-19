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

interface EvidenceGapAnalysisDashboardProps {
  caseId: string;
}

export function EvidenceGapAnalysisDashboard({ caseId }: EvidenceGapAnalysisDashboardProps) {
  const [analyzing, setAnalyzing] = useState(false);

  // Fetch gap analysis data
  const { data: summary, refetch: refetchSummary, isLoading: summaryLoading } = trpc.gapAnalysis.getSummary.useQuery({
    caseId,
  });

  const { data: gaps, refetch: refetchGaps } = trpc.gapAnalysis.getGaps.useQuery({ caseId });
  const { data: expectedDocs, refetch: refetchDocs } = trpc.gapAnalysis.getExpectedDocuments.useQuery({ caseId });
  const { data: patterns, refetch: refetchPatterns } = trpc.gapAnalysis.getPatterns.useQuery({ caseId });
  const { data: inferences, refetch: refetchInferences } = trpc.gapAnalysis.getInferences.useQuery({ caseId });
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
      console.error("[GapAnalysis] Analysis failed:", err);
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
    setAnalyzing(true);
    analyzeMutation.mutate({ caseId });
  };

  if (!summary?.hasAnalysis) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Search className="h-5 w-5" />
            Evidence Gap Analysis
          </CardTitle>
          <CardDescription>
            Review source coverage, availability, missing context, and records requiring verification
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <FileWarning className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Analysis Yet</h3>
            <p className="text-muted-foreground mb-6">
              Run a coverage review to inventory the exact records visible to LARO and identify
              unknown or unavailable source context. This does not assess legal merit or outcome.
            </p>
            <Button onClick={handleAnalyze} disabled={analyzing}>
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? "Reviewing..." : "Run Coverage Review"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const getSignificanceBadge = (significance: string) => {
    switch (significance) {
      case "critical":
        return <Badge variant="destructive">High review priority</Badge>;
      case "important":
        return <Badge className="bg-orange-500">Review priority</Badge>;
      default:
        return <Badge variant="secondary">Context signal</Badge>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "missing":
        return (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" />
            Not found in LARO
          </Badge>
        );
      case "delayed":
        return (
          <Badge className="bg-orange-500 gap-1">
            <Clock className="h-3 w-3" />
            Timing requires review
          </Badge>
        );
      case "received":
        return (
          <Badge variant="default" className="bg-green-600 gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Found in LARO
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getReviewBadge = (status: string) => (
    <Badge variant="secondary">{status === "review_required" ? "Review required" : "Unverified"}</Badge>
  );

  return (
    <div className="space-y-6">
      {coverageData.contractStatus === "retired" ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Saved coverage review retired</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {coverageData.retirementReason
                || "This saved result used the retired scoring contract and is not shown."}
            </p>
            <Button onClick={handleAnalyze} disabled={analyzing} size="sm" variant="outline">
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? "Reviewing..." : "Create current coverage review"}
            </Button>
          </AlertDescription>
        </Alert>
      ) : coverageData.contractStatus === "current" ? (
        <Card>
          <CardHeader>
            <CardTitle role="heading" aria-level={2} className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Evidence coverage and source availability
            </CardTitle>
            <CardDescription>{coverageData.summary}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                ["Input records", coverageCounts.inputRecords ?? 0],
                ["Managed sources available", coverageCounts.sourceAvailable ?? 0],
                ["Sources unavailable", coverageCounts.sourceUnavailable ?? 0],
                ["Records unreviewed", coverageCounts.unreviewed ?? 0],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg border p-3">
                  <div className="text-2xl font-semibold">{value}</div>
                  <div className="text-xs text-muted-foreground">{label}</div>
                </div>
              ))}
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div><span className="font-medium">Exact duplicates:</span> {coverageCounts.exactDuplicateRecords ?? 0}</div>
              <div><span className="font-medium">Contradiction flags:</span> {coverageCounts.automatedContradictionFlags ?? 0}</div>
              <div><span className="font-medium">Missing-context items:</span> {coverageCounts.missingContextItems ?? 0}</div>
              <div><span className="font-medium">External references unverified:</span> {coverageCounts.externalSourcesUnverified ?? 0}</div>
            </div>

            <Alert>
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Legal basis: Unknown</AlertTitle>
              <AlertDescription>
                {coverageData.legalBasis?.detail
                  || "No reviewed legal-basis source is bound to this coverage snapshot."}
              </AlertDescription>
            </Alert>

            <div>
              <h4 className="mb-2 font-semibold">Unknowns requiring review</h4>
              {coverageUnknowns.length > 0 ? (
                <ul className="space-y-2">
                  {coverageUnknowns.map((unknown: any) => (
                    <li key={unknown.code} className="rounded-lg bg-muted/50 p-3 text-sm">
                      <div className="font-medium">{String(unknown.code).replaceAll("_", " ")}</div>
                      <div className="text-muted-foreground">{unknown.detail}</div>
                      {Array.isArray(unknown.inputIds) && unknown.inputIds.length > 0 && (
                        <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          Inputs: {unknown.inputIds.join(", ")}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No additional automated unknowns were recorded.</p>
              )}
            </div>

            <details className="rounded-lg border p-4">
              <summary className="cursor-pointer font-semibold">Exact inputs and revisions</summary>
              <div className="mt-4 space-y-3">
                {coverageInputs.length > 0 ? coverageInputs.map((input: any) => (
                  <div key={`${input.inputType}:${input.id}`} className="rounded-md bg-muted/50 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{input.label}</span>
                      <Badge variant="outline">{String(input.inputType).replaceAll("_", " ")}</Badge>
                      <Badge variant="secondary">{String(input.sourceAvailability).replaceAll("_", " ")}</Badge>
                      <Badge variant="secondary">{String(input.reviewStatus).replaceAll("_", " ")}</Badge>
                    </div>
                    <div className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      ID: {input.inputType}:{input.id}<br />
                      Input revision: {input.revision}<br />
                      Analysis: {String(input.analysisStatus).replaceAll("_", " ")}
                      {input.analysisRevision ? <><br />Analysis revision: {input.analysisRevision}</> : null}
                      {input.duplicateOf ? <><br />Exact duplicate of: {input.duplicateOf}</> : null}
                      {Number(input.contradictionFlags) > 0
                        ? <><br />Automated contradiction flags: {input.contradictionFlags}</>
                        : null}
                    </div>
                  </div>
                )) : (
                  <p className="text-sm text-muted-foreground">No LARO inputs were present in this snapshot.</p>
                )}
              </div>
            </details>

            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 font-semibold">Limitations</h4>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {coverageLimitations.map((limitation, index) => <li key={index}>• {limitation}</li>)}
                </ul>
              </div>
              <div>
                <h4 className="mb-2 font-semibold">Review actions</h4>
                <ol className="space-y-1 text-sm text-muted-foreground">
                  {coverageActions.map((action, index) => <li key={index}>{index + 1}. {action}</li>)}
                </ol>
              </div>
            </div>

            <div className="break-all border-t pt-3 font-mono text-xs text-muted-foreground">
              Contract: {coverageData.contractVersion}<br />
              Source-set revision: {coverageData.sourceRevision}<br />
              Snapshot revision: {coverageData.snapshotRevision}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Detailed Analysis Tabs */}
      <Tabs defaultValue="gaps" className="w-full">
        <TabsList className="grid w-full grid-cols-2 group-data-[orientation=horizontal]/tabs:h-auto sm:grid-cols-3 lg:grid-cols-6">
          <TabsTrigger value="gaps" className="gap-2">
            <Clock className="h-4 w-4" />
            Context ({summary?.gapsCount || 0})
          </TabsTrigger>
          <TabsTrigger value="documents" className="gap-2">
            <FileText className="h-4 w-4" />
            Potential Records ({summary?.missingDocsCount || 0})
          </TabsTrigger>
          <TabsTrigger value="patterns" className="gap-2">
            <AlertTriangle className="h-4 w-4" />
            Rule Checks ({summary?.patternsCount || 0})
          </TabsTrigger>
          <TabsTrigger value="inferences" className="gap-2">
            <Scale className="h-4 w-4" />
            Review ({summary?.inferencesCount || 0})
          </TabsTrigger>
          <TabsTrigger value="records" className="gap-2">
            <Building2 className="h-4 w-4" />
            Public Records
          </TabsTrigger>
          <TabsTrigger value="legal-docs" className="gap-2">
            <FileText className="h-4 w-4" />
            Legal Docs
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
                        {gap.durationDays} days •{" "}
                        {gap.gapType.replace("_", " ").charAt(0).toUpperCase() +
                          gap.gapType.replace("_", " ").slice(1)}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {gap.legalImplications && gap.legalImplications.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-sm mb-2">Review prompts:</h4>
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
                No communication-gap signals were produced from current LARO inputs.
                Records outside LARO remain unknown.
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
                            Claimed requirement — verify source
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
                      <span className="font-semibold">Claimed basis — verify source: </span>
                      <span className="text-muted-foreground">{doc.legalBasis}</span>
                    </div>
                  </CardContent>
                )}
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No potentially relevant missing records were produced from current LARO inputs.
                Records outside LARO remain unknown.
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
                        <Badge variant="outline">Rule match</Badge>
                      </div>
                      <CardDescription>
                        {pattern.patternType.replace("_", " ").toUpperCase()}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                {pattern.legalSignificance && (
                  <CardContent>
                    <Alert>
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>Review note</AlertTitle>
                      <AlertDescription>{pattern.legalSignificance}</AlertDescription>
                    </Alert>
                  </CardContent>
                )}
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No rule-based patterns were produced from current LARO inputs.
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
                          {inference.category.replace("_", " ").toUpperCase()}
                        </CardDescription>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {inference.legalPrinciple && (
                    <div>
                      <h4 className="font-semibold text-sm mb-1">Review limitation:</h4>
                      <p className="text-sm text-muted-foreground">{inference.legalPrinciple}</p>
                    </div>
                  )}
                  {inference.supportingEvidence && inference.supportingEvidence.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-sm mb-2">Related recorded facts:</h4>
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
                      <h4 className="font-semibold text-sm mb-2">Unverified legal references:</h4>
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
                No review questions were produced from current LARO inputs.
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
              <p className="font-semibold">Re-run coverage review</p>
              <p className="text-sm text-muted-foreground">
                Rebuild the exact input, source-availability, and revision inventory
              </p>
            </div>
            <Button onClick={handleAnalyze} disabled={analyzing} variant="outline">
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? "Reviewing..." : "Re-run review"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
