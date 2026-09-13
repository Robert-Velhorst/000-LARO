import { ArrowRight, Briefcase, FileText, FolderInput, MessageSquare, UserCheck } from "lucide-react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "./DashboardLayout";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { PageHeading, QueryNotice } from "./WorkspaceUi";
import { useI18n } from "@/contexts/I18nContext";

export default function Home() {
  const [, navigate] = useLocation();
  const { t, locale, formatDate } = useI18n();
  const nl = locale === "nl";
  const stats = trpc.dashboard.stats.useQuery();
  const questions = trpc.clarifications.pending.useQuery();
  const inbox = trpc.documentInbox.list.useQuery({ view: "unassigned", offset: 0, limit: 1 });
  const cases = trpc.cases.list.useQuery({ limit: 6, sortBy: "updatedAt" });
  const openAssistant = () => window.dispatchEvent(new Event("laro:open-assistant"));
  const metrics = [
    { label: nl ? "Dossiers" : "Cases", value: cases.data?.pagination.total, loading: cases.isLoading, icon: Briefcase, path: "/cases" },
    { label: nl ? "Verzamelde bewijsstukken" : "Filed evidence", value: stats.data?.evidenceCollected, icon: FileText, path: "/evidence?view=items" },
    { label: nl ? "Benaderingen" : "Outreach records", value: stats.data?.matchesMade, icon: UserCheck, path: "/outreach" },
  ];

  return <DashboardLayout><div className="space-y-7">
    <PageHeading title={nl ? "Overzicht" : "Overview"} actions={<Button onClick={() => navigate("/evidence")}><FolderInput className="h-4 w-4" />{t("home.openInbox")}</Button>} />
    {stats.error ? <QueryNotice error={stats.error} retry={stats.refetch} /> : <div className="grid grid-cols-1 divide-y divide-border border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      {metrics.map(metric => <button key={metric.path} type="button" onClick={() => navigate(metric.path)} className="flex items-center gap-4 px-4 py-5 text-left hover:bg-muted/40">
        <metric.icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1"><span className="block text-sm text-muted-foreground">{metric.label}</span>
          {stats.isLoading || metric.loading ? <Skeleton className="mt-2 h-7 w-12" /> : <strong className="mt-1 block text-2xl font-semibold tabular-nums">{metric.value ?? "..."}</strong>}
        </span><ArrowRight className="h-4 w-4 text-muted-foreground" />
      </button>)}
    </div>}

    <section aria-labelledby="home-attention">
      <div className="workspace-heading"><h2 id="home-attention">{nl ? "Te beoordelen" : "Needs attention"}</h2></div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          {inbox.error ? <QueryNotice error={inbox.error} retry={inbox.refetch} /> : <button type="button" onClick={() => navigate("/evidence?view=inbox")} className="flex min-h-24 w-full items-center gap-4 rounded-md border border-border bg-card p-4 text-left hover:border-primary/60">
            <FolderInput className="h-6 w-6 shrink-0 text-primary" />
            <span className="min-w-0 flex-1"><span className="block font-medium">{nl ? "Documenten zonder dossier" : "Documents not yet filed"}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{inbox.isLoading ? t("common.loading") : nl ? `${inbox.data?.total ?? 0} documenten` : `${inbox.data?.total ?? 0} documents`}</span>
            </span><ArrowRight className="h-4 w-4 shrink-0" />
          </button>}
        </div>
        <div>
          {questions.error ? <QueryNotice error={questions.error} retry={questions.refetch} /> : questions.isLoading ? <Skeleton className="h-24 w-full" /> : questions.data?.length ? <div className="divide-y divide-border">
            {questions.data.slice(0, 5).map(item => <button key={item.id} type="button" onClick={openAssistant} className="flex w-full items-start gap-3 py-3 text-left text-sm hover:text-primary">
              <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span className="min-w-0 flex-1 break-words">{item.question}</span><ArrowRight className="h-4 w-4 shrink-0" />
            </button>)}
            {questions.data.length > 5 && <Button variant="ghost" onClick={openAssistant}>{nl ? "Alle open vragen" : "All open questions"} ({questions.data.length})<ArrowRight className="h-4 w-4" /></Button>}
          </div> : <div className="flex min-h-24 items-center gap-3 py-4 text-sm text-muted-foreground"><MessageSquare className="h-5 w-5 shrink-0" />{nl ? "Geen open verduidelijkingsvragen." : "No unanswered clarification questions."}</div>}
        </div>
      </div>
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
