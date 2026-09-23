import { Activity, AlertTriangle, ArrowRight, Briefcase, FileText, FolderInput, ListChecks, MessageSquare, Send } from "lucide-react";
import { useLocation } from "wouter";
import { useI18n } from "@/contexts/I18nContext";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "./DashboardLayout";
import { PageHeading, QueryNotice } from "./WorkspaceUi";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

const ACTION_LABELS = {
  exception: "Exception",
  next_action: "Next action",
  clarification: "Clarification",
} as const;

const ACTIVITY_LABELS = {
  case_created: "Case",
  outreach_sent: "Sent",
  outreach_response: "Response",
} as const;

export default function Home() {
  const [, navigate] = useLocation();
  const { t, locale, formatDate } = useI18n();
  const nl = locale === "nl";
  const summary = trpc.dashboard.summary.useQuery();
  const inbox = trpc.documentInbox.list.useQuery({ view: "unassigned", offset: 0, limit: 1 });
  const cases = trpc.cases.list.useQuery({ limit: 6, sortBy: "updatedAt" });
  const dashboard = summary.data?.availability === "available" && summary.data.metrics
    ? summary.data : null;
  const metrics = [
    {
      label: nl ? "Actieve dossiers" : "Active cases",
      value: dashboard?.metrics.activeCases ?? null,
      definition: summary.data?.definitions.activeCases,
      icon: Briefcase,
      path: "/cases",
      testId: "dashboard-active-cases",
    },
    {
      label: nl ? "Verzamelde bewijsstukken" : "Filed evidence",
      value: dashboard?.metrics.evidenceCollected ?? null,
      definition: summary.data?.definitions.evidenceCollected,
      icon: FileText,
      path: "/evidence?view=items",
      testId: "dashboard-filed-evidence",
    },
    {
      label: nl ? "Verzonden benaderingen" : "Outreach sent",
      value: dashboard?.metrics.outreach.sent ?? null,
      definition: summary.data?.definitions.outreachSent,
      icon: Send,
      path: "/outreach",
      testId: "dashboard-outreach-sent",
    },
  ];

  return <DashboardLayout><div className="space-y-7">
    <PageHeading title={nl ? "Overzicht" : "Overview"} actions={<Button onClick={() => navigate("/evidence")}><FolderInput className="h-4 w-4" />{t("home.openInbox")}</Button>} />
    {summary.error ? <QueryNotice error={summary.error} retry={summary.refetch} /> : <>
      <div className="grid grid-cols-1 divide-y divide-border border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {metrics.map(metric => <button data-testid={metric.testId} key={metric.path} type="button" onClick={() => navigate(metric.path)} className="flex items-start gap-4 px-4 py-5 text-left hover:bg-muted/40">
          <metric.icon className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="block text-sm text-muted-foreground">{metric.label}</span>
            {summary.isLoading ? <Skeleton className="mt-2 h-7 w-12" /> : <strong className="mt-1 block text-2xl font-semibold tabular-nums">{dashboard ? metric.value : nl ? "Niet beschikbaar" : "Unavailable"}</strong>}
            {!summary.isLoading && metric.definition ? <span className="mt-1 block text-xs leading-5 text-muted-foreground">{metric.definition}</span> : null}
          </span><ArrowRight className="mt-1 h-4 w-4 text-muted-foreground" />
        </button>)}
      </div>
      {dashboard ? <div aria-label="Outreach pipeline states" className="flex flex-wrap gap-x-5 gap-y-2 border-b border-border pb-4 text-xs text-muted-foreground">
        <span>Suggested <strong className="text-foreground">{dashboard.metrics.outreach.suggested}</strong></span>
        <span>Drafted <strong className="text-foreground">{dashboard.metrics.outreach.drafted}</strong></span>
        <span>Approved, unsent <strong className="text-foreground">{dashboard.metrics.outreach.approved}</strong></span>
        <span>Sent <strong className="text-foreground">{dashboard.metrics.outreach.sent}</strong></span>
        <span>Responded <strong className="text-foreground">{dashboard.metrics.outreach.responded}</strong></span>
        <span>Interested <strong className="text-foreground">{dashboard.metrics.outreach.interested}</strong></span>
      </div> : null}
    </>}

    <section aria-labelledby="home-attention">
      <div className="workspace-heading"><h2 id="home-attention">{nl ? "Te beoordelen" : "Needs attention"}</h2>{dashboard ? <span className="text-sm text-muted-foreground">{dashboard.actionCounts.total} {nl ? "acties" : "actions"}</span> : null}</div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          {inbox.error ? <QueryNotice error={inbox.error} retry={inbox.refetch} /> : <button type="button" onClick={() => navigate("/evidence?view=inbox")} className="flex min-h-24 w-full items-center gap-4 rounded-md border border-border bg-card p-4 text-left hover:border-primary/60">
            <FolderInput className="h-6 w-6 shrink-0 text-primary" />
            <span className="min-w-0 flex-1"><span className="block font-medium">{nl ? "Documenten zonder dossier" : "Documents not yet filed"}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{inbox.isLoading ? t("common.loading") : nl ? `${inbox.data?.total ?? 0} documenten` : `${inbox.data?.total ?? 0} documents`}</span>
            </span><ArrowRight className="h-4 w-4 shrink-0" />
          </button>}
        </div>
        <div data-testid="dashboard-pending-actions">
          {summary.isLoading ? <Skeleton className="h-24 w-full" /> : summary.error ? <QueryNotice error={summary.error} retry={summary.refetch} /> : !dashboard ? <div className="flex min-h-24 items-center gap-3 py-4 text-sm text-muted-foreground"><AlertTriangle className="h-5 w-5 shrink-0" />{nl ? "Acties zijn niet beschikbaar." : "Actions are unavailable."}</div> : dashboard.actions.length ? <div className="divide-y divide-border">
            {dashboard.actions.slice(0, 6).map(item => <button key={item.id} type="button" onClick={() => navigate(item.destination)} className="flex w-full items-start gap-3 py-3 text-left text-sm hover:text-primary">
              {item.type === "exception" ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" /> : item.type === "clarification" ? <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : <ListChecks className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="text-[10px]">{ACTION_LABELS[item.type]}</Badge><span className="font-medium">{item.title}</span></span>
                <span className="mt-1 block break-words text-muted-foreground">{item.caseTitle}: {item.detail}</span>
              </span><ArrowRight className="mt-0.5 h-4 w-4 shrink-0" />
            </button>)}
            {dashboard.actions.length > 6 ? <Button variant="ghost" onClick={() => navigate("/cases")}>{nl ? "Alle acties via dossiers" : "All actions through cases"} ({dashboard.actionCounts.total})<ArrowRight className="h-4 w-4" /></Button> : null}
          </div> : <div className="flex min-h-24 items-center gap-3 py-4 text-sm text-muted-foreground"><ListChecks className="h-5 w-5 shrink-0" />{nl ? "Geen open workflowacties." : "No open workflow actions."}</div>}
        </div>
      </div>
    </section>

    <section className="workspace-section" aria-labelledby="home-activity" data-testid="dashboard-recent-activity">
      <div className="workspace-heading"><h2 id="home-activity">{nl ? "Recente activiteit" : "Recent activity"}</h2></div>
      {summary.isLoading ? <Skeleton className="h-32 w-full" /> : summary.error ? <QueryNotice error={summary.error} retry={summary.refetch} /> : !dashboard ? <div className="flex min-h-24 items-center gap-3 text-sm text-muted-foreground"><AlertTriangle className="h-5 w-5" />{nl ? "Activiteit is niet beschikbaar." : "Activity is unavailable."}</div> : dashboard.activity.length ? <div className="divide-y divide-border">
        {dashboard.activity.map(item => <button type="button" key={item.id} onClick={() => navigate(item.destination)} className="flex w-full items-center gap-3 py-3 text-left hover:text-primary">
          <Activity className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><Badge variant="outline" className="text-[10px]">{ACTIVITY_LABELS[item.type]}</Badge><span className="font-medium">{item.title}</span>{item.status ? <span className="text-xs text-muted-foreground">{item.status}</span> : null}</span>
            <span className="mt-1 block truncate text-sm text-muted-foreground">{item.caseTitle}{item.detail ? ` — ${item.detail}` : ""}</span>
          </span><span className="text-xs text-muted-foreground">{formatDate(item.timestamp)}</span><ArrowRight className="h-4 w-4 shrink-0" />
        </button>)}
      </div> : <div className="flex min-h-24 items-center gap-3 text-sm text-muted-foreground"><Activity className="h-5 w-5" />{nl ? "Nog geen vastgelegde activiteit." : "No recorded activity yet."}</div>}
    </section>

    <section className="workspace-section" aria-labelledby="home-cases">
      <div className="workspace-heading"><h2 id="home-cases">{nl ? "Recent bijgewerkte dossiers" : "Recently updated cases"}</h2><Button variant="ghost" onClick={() => navigate("/cases")}>{nl ? "Alle dossiers" : "All cases"}<ArrowRight className="h-4 w-4" /></Button></div>
      {cases.error ? <QueryNotice error={cases.error} retry={cases.refetch} /> : cases.isLoading ? <Skeleton className="h-40 w-full" /> : cases.data?.cases.length ? <div className="divide-y divide-border">
        {cases.data.cases.map(item => <button type="button" key={item.id} onClick={() => navigate(`/cases?case=${encodeURIComponent(item.id)}`)} className="flex w-full flex-wrap items-center gap-3 py-4 text-left hover:text-primary">
          <Briefcase className="h-5 w-5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block break-words font-medium">{item.clientName || item.caseType || item.id}</span><span className="mt-1 block text-sm text-muted-foreground">{item.caseType}</span></span>
          <span className="text-xs text-muted-foreground">{item.updatedAt ? formatDate(item.updatedAt) : ""}</span><ArrowRight className="h-4 w-4 shrink-0" />
        </button>)}
      </div> : <div className="flex min-h-40 flex-col items-center justify-center gap-4 text-center">
        <Briefcase className="h-8 w-8 text-muted-foreground" /><p className="text-sm text-muted-foreground">{nl ? "Nog geen dossiers." : "No cases yet."}</p>
        <Button variant="outline" onClick={() => navigate("/evidence")}><FolderInput className="h-4 w-4" />{nl ? "Documenten toevoegen" : "Add documents"}</Button>
      </div>}
    </section>
  </div></DashboardLayout>;
}
