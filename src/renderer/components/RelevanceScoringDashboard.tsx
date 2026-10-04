import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import {
  BarChart3,
  Zap,
  TrendingUp,
  AlertCircle,
  Loader2,
  Tag,
} from "lucide-react";

interface RelevanceScoringDashboardProps {
  caseId: string;
  caseDescription: string;
  legalArea: string;
  keyIssues: string[];
}

export default function RelevanceScoringDashboard({
  caseId,
  caseDescription,
  legalArea,
  keyIssues,
}: RelevanceScoringDashboardProps) {
  const [batchSize, setBatchSize] = useState(10);

  // Get relevance statistics
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } =
    trpc.relevanceScoring.getStatistics.useQuery({ caseId });

  // Get recommendations
  const { data: recommendations } = trpc.relevanceScoring.getRecommendations.useQuery({
    caseId,
  });

  // Batch score mutation
  const batchScoreMutation = trpc.relevanceScoring.batchScore.useMutation({
    onSuccess: (data) => {
      toast.success(`Scored ${data.totalScored} evidence items`);
      refetchStats();
    },
    onError: (error) => {
      toast.error(`Scoring failed: ${error.message}`);
    },
  });

  const handleBatchScore = async () => {
    try {
      await batchScoreMutation.mutateAsync({
        caseContext: {
          caseId,
          description: caseDescription,
          legalArea,
          keyIssues,
        },
        batchSize,
      });
    } catch (error) {
      console.error("Batch scoring error:", error);
    }
  };

  if (statsLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Scored */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Total Scored</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.statistics.totalScored || 0}</div>
            <p className="text-xs text-muted-foreground mt-1">Evidence items analyzed</p>
          </CardContent>
        </Card>

        {/* High Relevance */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-green-600">High Relevance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {stats?.statistics.highRelevance || 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats?.statistics.totalScored
                ? Math.round(
                    ((stats.statistics.highRelevance || 0) / stats.statistics.totalScored) * 100
                  )
                : 0}
              % of total
            </p>
          </CardContent>
        </Card>

        {/* Medium Relevance */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-yellow-600">
              Medium Relevance
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-yellow-600">
              {stats?.statistics.mediumRelevance || 0}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {stats?.statistics.totalScored
                ? Math.round(
                    ((stats.statistics.mediumRelevance || 0) / stats.statistics.totalScored) * 100
                  )
                : 0}
              % of total
            </p>
          </CardContent>
        </Card>

        {/* Average Score */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium">Average Score</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.statistics.averageScore || 0}/100</div>
            <p className="text-xs text-muted-foreground mt-1">Overall relevance score</p>
          </CardContent>
        </Card>
      </div>

      {/* Batch Scoring Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="w-5 h-5" />
            Batch Scoring
          </CardTitle>
          <CardDescription>
            Compare evidence metadata and source-linked document analysis with the persisted case context
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Batch Size Input */}
          <div className="space-y-2">
            <Label htmlFor="batch-size">Items per batch</Label>
            <Input
              id="batch-size"
              type="number"
              min="1"
              max="50"
              value={batchSize}
              onChange={(e) => setBatchSize(Math.min(50, Math.max(1, parseInt(e.target.value) || 10)))}
              disabled={batchScoreMutation.isPending}
              className="max-w-xs"
            />
            <p className="text-xs text-muted-foreground">
              Smaller batches are slower but more reliable. Recommended: 10-20
            </p>
          </div>

          {/* Progress Bar */}
          {/* Start Scoring Button */}
          <Button
            onClick={handleBatchScore}
            disabled={batchScoreMutation.isPending || !stats?.statistics.totalEvidence}
            className="w-full"
          >
            {batchScoreMutation.isPending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Scoring Evidence...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4 mr-2" />
                Start Batch Scoring
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Relevance Distribution */}
      {stats && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5" />
              Relevance Distribution
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* High Relevance Bar */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">High Relevance</span>
                <Badge variant="outline" className="bg-green-50 text-green-700">
                  {stats.statistics.highRelevance} items
                </Badge>
              </div>
              <Progress
                aria-label="High relevance evidence distribution"
                value={
                  stats.statistics.totalScored > 0
                    ? (stats.statistics.highRelevance / stats.statistics.totalScored) * 100
                    : 0
                }
                className="h-2 bg-green-100"
              />
            </div>

            {/* Medium Relevance Bar */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Medium Relevance</span>
                <Badge variant="outline" className="bg-yellow-50 text-yellow-700">
                  {stats.statistics.mediumRelevance} items
                </Badge>
              </div>
              <Progress
                aria-label="Medium relevance evidence distribution"
                value={
                  stats.statistics.totalScored > 0
                    ? (stats.statistics.mediumRelevance / stats.statistics.totalScored) * 100
                    : 0
                }
                className="h-2 bg-yellow-100"
              />
            </div>

            {/* Low Relevance Bar */}
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Low Relevance</span>
                <Badge variant="outline" className="bg-red-50 text-red-700">
                  {stats.statistics.lowRelevance} items
                </Badge>
              </div>
              <Progress
                aria-label="Low relevance evidence distribution"
                value={
                  stats.statistics.totalScored > 0
                    ? (stats.statistics.lowRelevance / stats.statistics.totalScored) * 100
                    : 0
                }
                className="h-2 bg-red-100"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top Keywords */}
      {stats?.statistics.topKeywords && stats.statistics.topKeywords.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Tag className="w-5 h-5" />
              Top Keywords
            </CardTitle>
            <CardDescription>Most frequently identified relevance indicators</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {stats.statistics.topKeywords.map((item, index) => (
                <Badge key={index} variant="secondary" className="px-3 py-1">
                  {item.keyword}
                  <span className="ml-1 text-xs opacity-70">({item.frequency})</span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recommendations */}
      {recommendations?.recommendations && recommendations.recommendations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="w-5 h-5" />
              Recommendations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recommendations.recommendations.map((rec, index) => (
                <div
                  key={index}
                  className={`p-3 rounded-lg border-l-4 ${
                    rec.priority === "high"
                      ? "border-red-500 bg-red-50 text-red-950 dark:bg-red-950 dark:text-red-50"
                      : "border-yellow-500 bg-yellow-50 text-yellow-950 dark:bg-yellow-950 dark:text-yellow-50"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {rec.priority === "high" ? (
                      <AlertCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
                    ) : (
                      <TrendingUp className="w-4 h-4 text-yellow-600 mt-0.5 shrink-0" />
                    )}
                    <p className="text-sm">{rec.message}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* No Data State */}
      {!stats?.statistics.totalScored && (
        <Card className="border-dashed">
          <CardContent className="pt-6">
            <div className="text-center space-y-3">
              <BarChart3 className="w-12 h-12 mx-auto text-muted-foreground opacity-50" />
              <p className="text-muted-foreground">
                {stats?.statistics.totalEvidence
                  ? 'No evidence has been scored yet. Select "Start Batch Scoring" to compare it with this case.'
                  : "Collect evidence for this case before running relevance scoring."}
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
