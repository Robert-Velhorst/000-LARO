/**
 * Outreach Analytics View Component
 * 
 * Reusable component that can be used in both standalone page and case details dialog
 * Accepts optional caseId to show analytics for a specific case
 */

import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  TrendingUp,
  Clock,
  Target,
  Mail,
  CheckCircle2,
  XCircle,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { format } from "date-fns";

interface OutreachAnalyticsViewProps {
  caseId?: string;
}

function MetricCard({
  title,
  value,
  icon,
  trend,
  loading,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  trend?: "up" | "down";
  loading?: boolean;
}) {
  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <>
            <div className="text-2xl font-bold">{value}</div>
            {trend && (
              <p className={`text-xs flex items-center gap-1 mt-1 ${trend === "up" ? "text-green-500" : "text-red-500"}`}>
                {trend === "up" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                {trend === "up" ? "Good" : "Needs improvement"}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function formatHours(hours: number): string {
  if (hours < 24) {
    return `${hours.toFixed(1)}h`;
  } else {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours.toFixed(0)}h`;
  }
}

export default function OutreachAnalyticsView({ caseId }: OutreachAnalyticsViewProps) {
  // Fetch outreach data for this case
  const { data: outreachHistory, isLoading } = trpc.cases.getOutreachByCaseId.useQuery(
    caseId || "",
    { enabled: !!caseId }
  );

  // Calculate metrics from outreach history
  const totalOutreaches = outreachHistory?.length || 0;
  const sentOutreach = outreachHistory?.filter(o => ["Sent", "Interested", "Declined", "NoResponse"].includes(String(o.status))).length || 0;
  const responsesReceived = outreachHistory?.filter(o => ["Interested", "Declined"].includes(String(o.status)) || !!o.response)?.length || 0;
  const acceptances = outreachHistory?.filter(o => o.status === "Interested")?.length || 0;
  const responseRate = sentOutreach > 0 ? (responsesReceived / sentOutreach) * 100 : 0;
  const acceptanceRate = responsesReceived > 0 ? (acceptances / responsesReceived) * 100 : 0;

  // Calculate average response time
  const responseTimes = outreachHistory
    ?.filter(o => o.lastContact && o.initialContact)
    ?.map(o => {
      const initial = new Date(o.initialContact!).getTime();
      const last = new Date(o.lastContact!).getTime();
      return (last - initial) / (1000 * 60 * 60); // hours
    }) || [];
  const avgResponseTime = responseTimes.length > 0
    ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
    : 0;

  return (
    <div className="space-y-6">
      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          title="Total Outreaches"
          value={totalOutreaches.toString()}
          icon={<Mail className="h-4 w-4" />}
          loading={isLoading}
        />
        
        <MetricCard
          title="Response Rate"
          value={responseRate.toFixed(1) + "%"}
          icon={<TrendingUp className="h-4 w-4" />}
          trend={responseRate > 50 ? "up" : "down"}
          loading={isLoading}
        />
        
        <MetricCard
          title="Acceptance Rate"
          value={acceptanceRate.toFixed(1) + "%"}
          icon={<Target className="h-4 w-4" />}
          trend={acceptanceRate > 60 ? "up" : "down"}
          loading={isLoading}
        />
        
        <MetricCard
          title="Avg Response Time"
          value={avgResponseTime > 0 ? formatHours(avgResponseTime) : "N/A"}
          icon={<Clock className="h-4 w-4" />}
          trend={avgResponseTime > 0 && avgResponseTime < 48 ? "up" : "down"}
          loading={isLoading}
        />
      </div>

      {/* Outreach History Table */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader>
          <CardTitle>Outreach History</CardTitle>
          <CardDescription>
            Detailed view of all lawyer outreach attempts for this case
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : !outreachHistory || outreachHistory.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Mail className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No outreach attempts yet</p>
              <p className="text-sm mt-2">Prepare and approve outreach from the Lawyer Matching tab.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {outreachHistory.map((outreach) => (
                <div
                  key={outreach.id}
                  className="flex items-center justify-between p-4 rounded-lg border border-border/50 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <div className="font-medium">{outreach.lawyerName || "Unknown Lawyer"}</div>
                      <Badge variant={
                        outreach.status === "Interested" ? "default" :
                        outreach.status === "Declined" ? "destructive" :
                        outreach.status === "Contacted" ? "secondary" :
                        "outline"
                      }>
                        {outreach.status}
                      </Badge>
                      {outreach.response && (
                        <Badge variant="outline" className="text-xs">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Responded
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm text-muted-foreground mt-1">
                      Initial contact: {outreach.initialContact ? format(new Date(outreach.initialContact), "MMM dd, yyyy HH:mm") : "Not recorded"}
                      {outreach.lastContact && outreach.lastContact !== outreach.initialContact && (
                        <> • Last contact: {format(new Date(outreach.lastContact), "MMM dd, yyyy HH:mm")}</>
                      )}
                    </div>
                    {outreach.response && (
                      <div className="text-sm mt-2 p-2 rounded bg-accent/30 italic">
                        "{outreach.response}"
                      </div>
                    )}
                  </div>
                  <div className="text-right ml-4">
                    <div className="text-sm font-medium">{outreach.distanceKm} km</div>
                    <div className="text-xs text-muted-foreground">distance</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Performance Insights */}
      <Card className="border-border/50 bg-card/50">
        <CardHeader>
          <CardTitle>Performance Insights</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {responseRate >= 70 ? (
              <div className="flex items-start gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                <CheckCircle2 className="h-5 w-5 text-green-500 mt-0.5" />
                <div>
                  <div className="font-medium text-green-500">Excellent Response Rate</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Your case is getting strong engagement from lawyers. Keep the momentum going!
                  </div>
                </div>
              </div>
            ) : responseRate >= 40 ? (
              <div className="flex items-start gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                <TrendingUp className="h-5 w-5 text-yellow-500 mt-0.5" />
                <div>
                  <div className="font-medium text-yellow-500">Moderate Response Rate</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Response rate is decent but could be improved. Consider expanding search radius or adjusting case details.
                  </div>
                </div>
              </div>
            ) : totalOutreaches > 0 ? (
              <div className="flex items-start gap-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                <XCircle className="h-5 w-5 text-red-500 mt-0.5" />
                <div>
                  <div className="font-medium text-red-500">Low Response Rate</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Consider reviewing your case details, expanding search criteria, or reaching out to our support team for assistance.
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <Mail className="h-5 w-5 text-blue-500 mt-0.5" />
                <div>
                  <div className="font-medium text-blue-500">No Outreach Yet</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Prepare drafts from Lawyer Matching when you are ready to begin.
                  </div>
                </div>
              </div>
            )}

            {avgResponseTime > 0 && avgResponseTime < 24 && (
              <div className="flex items-start gap-3 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
                <Clock className="h-5 w-5 text-green-500 mt-0.5" />
                <div>
                  <div className="font-medium text-green-500">Fast Response Times</div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Lawyers are responding quickly to your case (avg {formatHours(avgResponseTime)}).
                  </div>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
