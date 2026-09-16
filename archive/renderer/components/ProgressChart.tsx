import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  TrendingUp, 
  Users, 
  FileText, 
  Calendar,
  ArrowRight
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDistanceToNow } from "date-fns";

export default function ProgressChart() {
  const { data: metrics = [], isLoading } = trpc.dashboard.progressMetrics.useQuery();

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Case Progress</CardTitle>
          <CardDescription>Track progress of active cases</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="space-y-2">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-12" />
                </div>
                <Skeleton className="h-2 w-full" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (metrics.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Case Progress</CardTitle>
          <CardDescription>Track progress of active cases</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <TrendingUp className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No active cases</p>
            <p className="text-sm text-muted-foreground mt-2">
              Create a case to start tracking progress
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Case Progress</CardTitle>
            <CardDescription>
              Tracking {metrics.length} active case{metrics.length !== 1 ? 's' : ''}
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm">
            View All
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {metrics.map((metric: any) => {
            const progressPercentage = metric.progress || 0;
            const statusColor = 
              progressPercentage >= 75 ? "text-green-600" :
              progressPercentage >= 50 ? "text-blue-600" :
              progressPercentage >= 25 ? "text-yellow-600" :
              "text-red-600";

            return (
              <div key={metric.caseId} className="space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-medium text-sm">
                        Case #{metric.caseId}
                      </h4>
                      <Badge variant="secondary" className="text-xs">
                        {metric.status}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {metric.title || "Untitled Case"}
                    </p>
                  </div>
                  <div className={`text-lg font-bold ${statusColor}`}>
                    {progressPercentage}%
                  </div>
                </div>

                <Progress value={progressPercentage} className="h-2" />

                <div className="grid grid-cols-3 gap-4 text-xs">
                  <div className="flex items-center gap-2">
                    <Users className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {metric.lawyersContacted || 0} contacted
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <FileText className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {metric.documentsUploaded || 0} documents
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="h-3 w-3 text-muted-foreground" />
                    <span className="text-muted-foreground">
                      {metric.daysActive || 0} days active
                    </span>
                  </div>
                </div>

                {metric.nextStep && (
                  <div className="flex items-center gap-2 p-2 rounded bg-accent/50 text-xs">
                    <ArrowRight className="h-3 w-3 text-primary" />
                    <span className="font-medium">Next:</span>
                    <span className="text-muted-foreground">{metric.nextStep}</span>
                  </div>
                )}

                {metric.lastActivity && (
                  <p className="text-xs text-muted-foreground">
                    Last activity: {formatDistanceToNow(new Date(metric.lastActivity), { addSuffix: true })}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

