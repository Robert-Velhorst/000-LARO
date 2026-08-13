import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  AlertTriangle,
  FileWarning,
  TrendingUp,
  Shield,
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

  const toStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  // Fetch gap analysis data
  const { data: summary, refetch: refetchSummary, isLoading: summaryLoading } = trpc.gapAnalysis.getSummary.useQuery({
    caseId,
  });

  const { data: gaps, refetch: refetchGaps } = trpc.gapAnalysis.getGaps.useQuery({ caseId });
  const { data: expectedDocs, refetch: refetchDocs } = trpc.gapAnalysis.getExpectedDocuments.useQuery({ caseId });
  const { data: patterns, refetch: refetchPatterns } = trpc.gapAnalysis.getPatterns.useQuery({ caseId });
  const { data: inferences, refetch: refetchInferences } = trpc.gapAnalysis.getInferences.useQuery({ caseId });
  const { data: caseStrength, refetch: refetchStrength } = trpc.gapAnalysis.getCaseStrength.useQuery({ caseId });

  const normalizedGaps = ((gaps ?? []) as any[]);
  const normalizedExpectedDocs = ((expectedDocs ?? []) as any[]);
  const normalizedPatterns = ((patterns ?? []) as any[]);
  const normalizedInferences = ((inferences ?? []) as any[]);
  const cs = ((caseStrength ?? {}) as any);

  // Parse scores as numbers — they may be stored as strings in DB
  const score = {
    overall:         Number(cs.overallScore ?? 0),
    directEvidence:  Number(cs.directEvidenceScore ?? 0),
    circumstantial:  Number(cs.circumstantialEvidenceScore ?? 0),
    legalBasis:      Number(cs.legalBasisScore ?? 0),
    gapImpact:       Number(cs.gapAnalysisImpact ?? 0),
  };

  const analyzeMutation = trpc.gapAnalysis.analyze.useMutation({
    onSuccess: () => {
      setAnalyzing(false);
      // Refetch all gap analysis data
      refetchSummary();
      refetchGaps();
      refetchDocs();
      refetchPatterns();
      refetchInferences();
      refetchStrength();
    },
    onError: (err) => {
      setAnalyzing(false);
      console.error("[GapAnalysis] Analysis failed:", err);
    },
  });

  // Auto-run analysis when caseId changes and no analysis exists yet
  useEffect(() => {
    if (caseId && !summaryLoading && !summary?.hasAnalysis && !analyzing) {
      setAnalyzing(true);
      analyzeMutation.mutate({ caseId });
    }
  }, [caseId, summaryLoading, summary?.hasAnalysis]);

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
            Detect communication gaps, missing documents, and strengthen your case
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <FileWarning className="h-16 w-16 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Analysis Yet</h3>
            <p className="text-muted-foreground mb-6">
              Run gap analysis to identify evidence gaps, missing documents, and legal inferences
              that strengthen your case.
            </p>
            <Button onClick={handleAnalyze} disabled={analyzing}>
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? "Analyzing..." : "Run Gap Analysis"}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  const getSignificanceBadge = (significance: string) => {
    switch (significance) {
      case "critical":
        return <Badge variant="destructive">Critical</Badge>;
      case "important":
        return <Badge className="bg-orange-500">Important</Badge>;
      default:
        return <Badge variant="secondary">Notable</Badge>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "missing":
        return (
          <Badge variant="destructive" className="gap-1">
            <XCircle className="h-3 w-3" />
            Missing
          </Badge>
        );
      case "delayed":
        return (
          <Badge className="bg-orange-500 gap-1">
            <Clock className="h-3 w-3" />
            Delayed
          </Badge>
        );
      case "received":
        return (
          <Badge variant="default" className="bg-green-600 gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Received
          </Badge>
        );
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const getStrengthBadge = (strength: string) => (
    <Badge variant="secondary">{strength === "review_required" ? "Review required" : "Unverified"}</Badge>
  );

  const strengths = toStringArray(cs.strengths);
  const weaknesses = toStringArray(cs.weaknesses);
  const recommendations = toStringArray(cs.recommendations);

  return (
    <div className="space-y-6">
      {/* Evidence completeness overview */}
      {caseStrength && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Evidence Completeness Analysis
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Overall Score */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Completeness Score</span>
                <span className="text-2xl font-bold">{score.overall}%</span>
              </div>
              <Progress aria-label="Overall evidence completeness" value={score.overall} className="h-3" />
            </div>

            {/* Score Breakdown */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-muted-foreground mb-1">Direct Evidence</div>
                <div className="flex items-center gap-2">
                  <Progress
                    aria-label="Direct evidence strength"
                    value={score.directEvidence}
                    className="h-2 flex-1"
                  />
                  <span className="text-sm font-medium w-12 text-right">
                    {score.directEvidence}%
                  </span>
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Context Coverage</div>
                <div className="flex items-center gap-2">
                  <Progress
                    aria-label="Context coverage"
                    value={score.circumstantial}
                    className="h-2 flex-1"
                  />
                  <span className="text-sm font-medium w-12 text-right">
                    {score.circumstantial}%
                  </span>
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Verified Legal Basis</div>
                <div className="flex items-center gap-2">
                  <Progress
                    aria-label="Verified legal basis"
                    value={score.legalBasis}
                    className="h-2 flex-1"
                  />
                  <span className="text-sm font-medium w-12 text-right">
                    {score.legalBasis}%
                  </span>
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground mb-1">Gap Risk</div>
                <div className="flex items-center gap-2">
                  <Progress
                    aria-label="Evidence gap risk"
                    value={score.gapImpact}
                    className="h-2 flex-1"
                  />
                  <span className="text-sm font-medium w-12 text-right">
                    {score.gapImpact}%
                  </span>
                </div>
              </div>
            </div>

            {/* Narrative */}
            {cs.analysisNarrative && (
              <Alert>
                <TrendingUp className="h-4 w-4" />
                <AlertTitle>Analysis Summary</AlertTitle>
                <AlertDescription>{cs.analysisNarrative}</AlertDescription>
              </Alert>
            )}

            {/* Strengths & Weaknesses */}
            <div className="grid md:grid-cols-2 gap-4">
              {strengths.length > 0 && (
                <div>
                  <h4 className="font-semibold text-sm mb-2 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    Available Evidence
                  </h4>
                  <ul className="space-y-1">
                    {strengths.map((strength: string, idx: number) => (
                      <li key={idx} className="text-sm text-muted-foreground">
                        • {strength}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {weaknesses.length > 0 && (
                <div>
                  <h4 className="font-semibold text-sm mb-2 flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-orange-500" />
                    Areas to Improve
                  </h4>
                  <ul className="space-y-1">
                    {weaknesses.map((weakness: string, idx: number) => (
                      <li key={idx} className="text-sm text-muted-foreground">
                        • {weakness}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Recommendations */}
            {recommendations.length > 0 && (
              <div>
                <h4 className="font-semibold text-sm mb-2">Recommended Actions</h4>
                <div className="space-y-2">
                  {recommendations.map(
                    (recommendation: string, idx: number) => (
                      <div
                        key={idx}
                        className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg"
                      >
                        <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <span className="text-xs font-semibold text-primary">{idx + 1}</span>
                        </div>
                        <p className="text-sm">{recommendation}</p>
                      </div>
                    )
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Detailed Analysis Tabs */}
      <Tabs defaultValue="gaps" className="w-full">
        <TabsList className="grid w-full grid-cols-6">
          <TabsTrigger value="gaps" className="gap-2">
            <Clock className="h-4 w-4" />
            Gaps ({summary?.gapsCount || 0})
          </TabsTrigger>
          <TabsTrigger value="documents" className="gap-2">
            <FileText className="h-4 w-4" />
            Missing Docs ({summary?.missingDocsCount || 0})
          </TabsTrigger>
          <TabsTrigger value="patterns" className="gap-2">
            <AlertTriangle className="h-4 w-4" />
            Patterns ({summary?.patternsCount || 0})
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
                      <h4 className="font-semibold text-sm mb-2">Legal Implications:</h4>
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
                No communication gaps detected
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
                            Legal Requirement
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
                      <span className="font-semibold">Legal Basis: </span>
                      <span className="text-muted-foreground">{doc.legalBasis}</span>
                    </div>
                  </CardContent>
                )}
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No missing documents identified
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
                        <Badge variant="outline">
                          {pattern.confidence}% confidence
                        </Badge>
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
                      <AlertTitle>Legal Significance</AlertTitle>
                      <AlertDescription>{pattern.legalSignificance}</AlertDescription>
                    </Alert>
                  </CardContent>
                )}
              </Card>
            ))
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No suspicious patterns detected
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
                        {getStrengthBadge(inference.strength)}
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
                      <h4 className="font-semibold text-sm mb-1">Legal Principle:</h4>
                      <p className="text-sm text-muted-foreground">{inference.legalPrinciple}</p>
                    </div>
                  )}
                  {inference.supportingEvidence && inference.supportingEvidence.length > 0 && (
                    <div>
                      <h4 className="font-semibold text-sm mb-2">Supporting Evidence:</h4>
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
                      <h4 className="font-semibold text-sm mb-2">Case Law:</h4>
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
                No legal inferences generated
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
              <p className="font-semibold">Re-run Analysis</p>
              <p className="text-sm text-muted-foreground">
                Update gap analysis with latest evidence
              </p>
            </div>
            <Button onClick={handleAnalyze} disabled={analyzing} variant="outline">
              {analyzing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {analyzing ? "Analyzing..." : "Re-analyze"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
