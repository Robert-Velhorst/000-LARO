import { useState } from "react";
import { useSearchParams } from "wouter";
import { QueryNotice } from "./WorkspaceUi";
import { useI18n } from "@/contexts/I18nContext";
import { Building2, CheckCircle2, Clock, Mail, Newspaper, Scale, Target, TrendingUp, Users } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LawyersDirectoryContent } from "@/components/Lawyers";
import OutreachTargetWorkspace from "@/components/OutreachTargetWorkspace";

function percent(value: number | undefined): string {
  return `${(value ?? 0).toFixed(1)}%`;
}

function duration(hours: number | undefined): string {
  if (!hours) return "n/a";
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${Math.floor(hours / 24)}d ${Math.round(hours % 24)}h`;
}

function Metric({ label, value, icon: Icon, loading }: { label: string; value: string; icon: typeof Mail; loading: boolean }) {
  return (
    <Card className="border-border/50 bg-card/60">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>{loading ? <Skeleton className="h-8 w-20" /> : <div className="text-2xl font-semibold">{value}</div>}</CardContent>
    </Card>
  );
}

export default function OutreachAnalytics() {
  const { locale } = useI18n();
  const nl = locale === "nl";
  const [params, setParams] = useSearchParams();
  const view = ["overview", "lawyers", "media", "organizations"].includes(params.get("view") || "") ? params.get("view")! : "overview";
  const selectView = (value: string) => setParams(previous => { const next = new URLSearchParams(previous); next.set("view", value); return next; });
  const [days, setDays] = useState("30");
  const overviewOptions = { enabled: view === "overview" };
  const metrics = trpc.outreachAnalytics.getOverallMetrics.useQuery(undefined, overviewOptions);
  const trends = trpc.outreachAnalytics.getPerformanceTrends.useQuery({ days: Number(days) }, overviewOptions);
  const lawyers = trpc.outreachAnalytics.getResponseRateByLawyer.useQuery({ limit: 20 }, overviewOptions);
  const legalAreas = trpc.outreachAnalytics.getTimeToMatchByLegalArea.useQuery(undefined, overviewOptions);
  const regions = trpc.outreachAnalytics.getMatchSuccessByRegion.useQuery(undefined, overviewOptions);
  const directory = trpc.outreachDirectory.summary.useQuery(undefined, overviewOptions);
  const data = metrics.data;
  const pipelineMax = Math.max(1, data?.prepared ?? 0);
  const directoryCount = (targetType: string, status: string) =>
    directory.data?.find((item) => item.targetType === targetType && item.status === status)?.count || 0;

  return (
    <DashboardLayout>
      <div className="min-w-0 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{nl ? "Benadering" : "Outreach"}</h1>
          </div>

        </div>

        {view === "overview" && !metrics.error && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Prepared" value={String(data?.prepared ?? 0)} icon={Mail} loading={metrics.isLoading} />
          <Metric label="Sent" value={String(data?.sent ?? 0)} icon={TrendingUp} loading={metrics.isLoading} />
          <Metric label="Response rate" value={percent(data?.overallResponseRate)} icon={Users} loading={metrics.isLoading} />
          <Metric label="Interested" value={String(data?.interested ?? 0)} icon={Target} loading={metrics.isLoading} />
        </div>}

        <Tabs value={view} onValueChange={selectView} className="space-y-4">
          <TabsList className="grid !h-auto w-full grid-cols-2 lg:w-fit lg:grid-cols-4">
            <TabsTrigger className="min-h-8" value="overview">{nl ? "Resultaten" : "Overview"}</TabsTrigger>
            <TabsTrigger className="min-h-8" value="lawyers"><Scale className="mr-2 h-4 w-4" />{nl ? "Advocaten" : "Lawyers"}</TabsTrigger>
            <TabsTrigger className="min-h-8" value="media"><Newspaper className="mr-2 h-4 w-4" />Media</TabsTrigger>
            <TabsTrigger className="min-h-8" value="organizations"><Building2 className="mr-2 h-4 w-4" />{nl ? "Organisaties" : "Organizations"}</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            {metrics.error ? <QueryNotice error={metrics.error} retry={metrics.refetch} /> : <>
            <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none">
              <CardHeader><CardTitle className="text-base">Pipeline (all time)</CardTitle></CardHeader>
              <CardContent className="grid gap-5 md:grid-cols-4">
                {[
                  ["Prepared", data?.prepared ?? 0],
                  ["Approved", data?.approved ?? 0],
                  ["Sent", data?.sent ?? 0],
                  ["Responses", data?.responses ?? 0],
                ].map(([label, count]) => (
                  <div key={String(label)} className="space-y-2">
                    <div className="flex items-center justify-between text-sm"><span>{label}</span><strong>{count}</strong></div>
                    <Progress
                      aria-label={`${label} pipeline progress`}
                      value={(Number(count) / pipelineMax) * 100}
                      className="h-2"
                    />
                  </div>
                ))}
              </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
              <Card className="border-border/50">
                <CardHeader className="flex flex-wrap flex-row items-center justify-between gap-3"><CardTitle className="text-base">Activity by day</CardTitle>          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-36" aria-label="Activity period"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
              <SelectItem value="365">Last year</SelectItem>
            </SelectContent>
          </Select></CardHeader>
                <CardContent className="overflow-x-auto">
                  {trends.error ? <QueryNotice error={trends.error} retry={trends.refetch} /> : trends.isLoading ? <Skeleton className="h-32 w-full" /> : trends.data?.length ? (
                    <table className="w-full min-w-[520px] text-sm">
                      <thead className="text-left text-muted-foreground"><tr><th className="pb-2 font-medium">Date</th><th>Prepared</th><th>Sent</th><th>Responses</th><th>Interested</th></tr></thead>
                      <tbody>{trends.data.map((row) => <tr key={row.date} className="border-t border-border/40"><td className="py-2">{row.date}</td><td>{row.prepared}</td><td>{row.sent}</td><td>{row.responses}</td><td>{row.interested}</td></tr>)}</tbody>
                    </table>
                  ) : <p className="py-8 text-center text-sm text-muted-foreground">No outreach in this period.</p>}
                </CardContent>
              </Card>

              <Card className="border-border/50">
                <CardHeader><CardTitle className="text-base">Response quality</CardTitle></CardHeader>
                <CardContent className="space-y-4 text-sm">
                  <div className="flex items-center justify-between"><span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-500" />Acceptance rate</span><strong>{percent(data?.acceptanceRate)}</strong></div>
                  <div className="flex items-center justify-between"><span className="flex items-center gap-2"><Clock className="h-4 w-4 text-blue-500" />Average response</span><strong>{duration(data?.averageResponseTimeHours)}</strong></div>
                  <div className="flex items-center justify-between"><span>Declined</span><Badge variant="secondary">{data?.declined ?? 0}</Badge></div>
                  <div className="flex items-center justify-between"><span>Rejected before send</span><Badge variant="secondary">{data?.rejected ?? 0}</Badge></div>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
              <Card className="rounded-none border-0 border-t border-border bg-transparent shadow-none xl:col-span-2">
                <CardHeader><CardTitle className="text-base">Lawyer performance</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {lawyers.error ? <QueryNotice error={lawyers.error} retry={lawyers.refetch} /> : lawyers.isLoading ? <Skeleton className="h-32 w-full" /> : lawyers.data?.length ? lawyers.data.map((lawyer) => (
                    <div key={lawyer.lawyerId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-border/40 py-2 last:border-0">
                      <span className="truncate text-sm font-medium">{lawyer.name}</span>
                      <span className="text-xs text-muted-foreground">{lawyer.responses}/{lawyer.totalOutreach} responses</span>
                      <Badge variant="outline">{percent(lawyer.responseRate)}</Badge>
                    </div>
                  )) : <p className="py-8 text-center text-sm text-muted-foreground">No sent outreach yet.</p>}
                </CardContent>
              </Card>

              <div className="space-y-4">
                <Card className="border-border/50">
                  <CardHeader><CardTitle className="text-base">Directory review</CardTitle></CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {directory.error ? <QueryNotice error={directory.error} retry={directory.refetch} /> : directory.isLoading ? <Skeleton className="h-16 w-full" /> : <>
                    <div className="flex items-center justify-between"><span>Media</span><span><strong>{directoryCount("media", "approved")}</strong> approved, {directoryCount("media", "pending")} pending</span></div>
                    <div className="flex flex-wrap items-center justify-between gap-2"><span>Organizations</span><span><strong>{directoryCount("organization", "approved")}</strong> approved, {directoryCount("organization", "pending")} pending</span></div>
                    </>}
                  </CardContent>
                </Card>
                <Card className="border-border/50">
                  <CardHeader><CardTitle className="text-base">Time to match</CardTitle></CardHeader>
                  <CardContent className="space-y-2">{legalAreas.error ? <QueryNotice error={legalAreas.error} retry={legalAreas.refetch} /> : legalAreas.isLoading ? <Skeleton className="h-16 w-full" /> : legalAreas.data?.length ? legalAreas.data.map((area) => <div key={area.legalArea} className="flex justify-between gap-3 text-sm"><span className="truncate">{area.legalArea}</span><strong>{area.avgDays.toFixed(1)}d</strong></div>) : <p className="text-sm text-muted-foreground">No accepted matches yet.</p>}</CardContent>
                </Card>
                <Card className="border-border/50">
                  <CardHeader><CardTitle className="text-base">Interested by region</CardTitle></CardHeader>
                  <CardContent className="space-y-2">{regions.error ? <QueryNotice error={regions.error} retry={regions.refetch} /> : regions.isLoading ? <Skeleton className="h-16 w-full" /> : regions.data?.length ? regions.data.map((region) => <div key={region.region} className="flex justify-between gap-3 text-sm"><span className="truncate">{region.region}</span><Badge variant="secondary">{region.matches}</Badge></div>) : <p className="text-sm text-muted-foreground">No regional results yet.</p>}</CardContent>
                </Card>
              </div>
            </div>
            </>}
          </TabsContent>

          <TabsContent value="lawyers"><LawyersDirectoryContent embedded /></TabsContent>
          <TabsContent value="media"><OutreachTargetWorkspace targetType="media" /></TabsContent>
          <TabsContent value="organizations"><OutreachTargetWorkspace targetType="organization" /></TabsContent>
        </Tabs>
      </div>
    </DashboardLayout>
  );
}
