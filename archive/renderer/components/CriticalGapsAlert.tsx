import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, FileWarning, Clock, ArrowRight, Eye } from "lucide-react";
import { useLocation } from "wouter";

interface CriticalGapsAlertProps {
  userId: string;
}

export function CriticalGapsAlert({ userId }: CriticalGapsAlertProps) {
  const [, setLocation] = useLocation();
  
  // Fetch critical gaps summary for all user's cases (securely uses session)
  const { data: gapsSummary, isLoading } = trpc.gapAnalysis.getUserCriticalGaps.useQuery();

  if (isLoading) {
    return null; // Don't show skeleton, just hide while loading
  }

  if (!gapsSummary || gapsSummary.totalCriticalGaps === 0) {
    return null; // No critical gaps, don't show anything
  }

  const handleViewCase = (caseId: string) => {
    // Navigate to case details with gap analysis tab
    setLocation(`/cases?caseId=${caseId}&tab=gap-analysis`);
  };

  return (
    <Card className="border-destructive/50 bg-destructive/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          Critical Evidence Gaps Detected
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="flex flex-col">
            <div className="text-2xl font-bold text-destructive">
              {gapsSummary.totalCriticalGaps}
            </div>
            <div className="text-sm text-muted-foreground">Critical Gaps</div>
          </div>
          <div className="flex flex-col">
            <div className="text-2xl font-bold text-orange-600">
              {gapsSummary.totalMissingDocs}
            </div>
            <div className="text-sm text-muted-foreground">Missing Documents</div>
          </div>
          <div className="flex flex-col">
            <div className="text-2xl font-bold text-amber-600">
              {gapsSummary.casesAffected}
            </div>
            <div className="text-sm text-muted-foreground">Cases Affected</div>
          </div>
        </div>

        {/* Top 3 most critical cases */}
        <div className="space-y-2">
          <div className="text-sm font-semibold">Most Urgent Cases:</div>
          {gapsSummary.topCases.slice(0, 3).map((caseItem) => (
            <Alert key={caseItem.caseId} variant="destructive" className="py-2">
              <AlertDescription className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <FileWarning className="h-4 w-4" />
                  <div>
                    <div className="font-medium">{caseItem.caseName}</div>
                    <div className="text-xs text-muted-foreground">
                      {caseItem.criticalGaps} critical gaps • {caseItem.missingDocs} missing docs
                      {caseItem.oldestGapDays && (
                        <span className="ml-2 inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {caseItem.oldestGapDays} days since last contact
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleViewCase(caseItem.caseId)}
                  className="shrink-0"
                >
                  <Eye className="h-4 w-4 mr-1" />
                  View Analysis
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </AlertDescription>
            </Alert>
          ))}
        </div>

        {/* Quick actions */}
        <div className="flex items-center gap-2 pt-2 border-t">
          <Badge variant="destructive" className="text-xs">
            Action Required
          </Badge>
          <span className="text-xs text-muted-foreground">
            Review gap analysis to strengthen your cases and generate legal documents
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

