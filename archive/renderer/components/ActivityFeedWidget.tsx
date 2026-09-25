import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  FileText,
  Mail,
  UserCheck,
  AlertCircle,
  CheckCircle2,
  Clock,
  ArrowRight
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Skeleton } from "@/components/ui/skeleton";

const activityIcons = {
  case_created: FileText,
  lawyer_contacted: Mail,
  lawyer_responded: UserCheck,
  lawyer_accepted: CheckCircle2,
  lawyer_declined: AlertCircle,
  document_uploaded: FileText,
  status_changed: ArrowRight,
  deadline_approaching: Clock
};

const activityColors = {
  case_created: "text-blue-500",
  lawyer_contacted: "text-purple-500",
  lawyer_responded: "text-orange-500",
  lawyer_accepted: "text-green-500",
  lawyer_declined: "text-red-500",
  document_uploaded: "text-blue-500",
  status_changed: "text-yellow-500",
  deadline_approaching: "text-red-500"
};

export default function ActivityFeedWidget() {
  const { data: activities = [], isLoading } = trpc.dashboard.activityFeed.useQuery({
    limit: 10
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
          <CardDescription>Latest updates across all cases</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-start gap-3">
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
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
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest updates across all cases</CardDescription>
          </div>
          <Button variant="ghost" size="sm">
            View All
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4">
          {activities.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Clock className="h-12 w-12 text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No recent activity</p>
              <p className="text-sm text-muted-foreground mt-2">
                Activity will appear here as you use the system
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {activities.map((activity: any, index: number) => {
                const Icon = activityIcons[activity.type as keyof typeof activityIcons] || FileText;
                const color = activityColors[activity.type as keyof typeof activityColors] || "text-gray-500";

                return (
                  <div
                    key={activity.id || index}
                    className="flex items-start gap-3 p-3 rounded-lg hover:bg-accent transition-all"
                  >
                    <div className={`p-2 rounded-full bg-background border ${color}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium leading-none mb-1">
                        {activity.title}
                      </p>
                      <p className="text-sm text-muted-foreground mb-2">
                        {activity.description}
                      </p>
                      <div className="flex items-center gap-2">
                        {activity.caseId && (
                          <Badge variant="secondary" className="text-xs">
                            Case #{activity.caseId}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: true })}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

