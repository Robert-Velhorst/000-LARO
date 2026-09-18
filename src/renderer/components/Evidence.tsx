import { lazy, Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams } from "wouter";
import { AlertTriangle, BarChart2, ChevronDown, ChevronLeft, ChevronRight, Clock, Cloud, Download, FileText, FolderOpen, Gauge, Link2, ListChecks } from "lucide-react";
import DashboardLayout from "./DashboardLayout";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { CasePicker, PageHeading, QueryNotice, SectionNavigation } from "./WorkspaceUi";
import { useI18n } from "@/contexts/I18nContext";
import { getElectronAPI } from "@/lib/electronApiShim";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import SearchResultSelection from "./SearchResultSelection";

const EvidenceCollection = lazy(() => import("./EvidenceCollection").then(module => ({ default: module.EvidenceCollection })));
const AutoCollectionSettings = lazy(() => import("./AutoCollectionSettings"));
const EvidenceConnectionsCard = lazy(() => import("./EvidenceConnectionsCard"));
const EvidenceSummaryDashboard = lazy(() => import("./EvidenceSummaryDashboard"));
const CaseReconstruction = lazy(() => import("./CaseReconstruction").then(module => ({ default: module.CaseReconstruction })));
const EvidenceGapAnalysisDashboard = lazy(() => import("./EvidenceGapAnalysisDashboard").then(module => ({ default: module.EvidenceGapAnalysisDashboard })));
const RelevanceScoringDashboard = lazy(() => import("./RelevanceScoringDashboard"));
const EvidenceExportUI = lazy(() => import("./EvidenceExportUI"));
const DocumentInbox = lazy(() => import("./DocumentInbox"));

const VIEW_IDS = ["inbox", "items", "timeline", "connections", "dashboard", "collect", "gaps", "export", "scoring"];
const CASE_VIEWS = ["timeline", "collect", "gaps", "export", "scoring"];

function EvidenceFiles({ caseId }: { caseId: string | null }) {
  const { locale, t, formatDate } = useI18n();
  const nl = locale === "nl";
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(20);
  const files = trpc.evidenceFiles.search.useQuery({ caseId: caseId ?? undefined, query: search, limit: limit + 1, offset: page * limit });
  const source = trpc.evidenceFiles.getDownloadUrl.useMutation();
  const opened = trpc.evidenceFiles.recordSourceOpened.useMutation();
  const openFile = async (id: string) => {
    try {
      const result = await source.mutateAsync({ id });
      if (!result.url) throw new Error(result.message || (nl ? "Bronbestand niet beschikbaar" : "Source unavailable"));
      await getElectronAPI().openExternal(result.url);
      await opened.mutateAsync({ id });
    } catch (error) { toast.error(error instanceof Error ? error.message : t("auth.genericError")); }
  };
  return <section className="space-y-4" aria-label={nl ? "Bewijsstukken" : "Evidence files"}>
    <div className="flex flex-wrap items-end justify-between gap-3">
      <label className="w-full max-w-md text-sm">{nl ? "Bestanden zoeken" : "Search files"}
        <input value={search} onChange={event => { setSearch(event.target.value); setPage(0); }} className="mt-1 min-h-10 w-full rounded-md border border-input bg-background px-3" />
      </label>
      <label className="text-sm">{nl ? "Per pagina" : "Per page"}<select value={limit} onChange={event => { setLimit(Number(event.target.value)); setPage(0); }} className="ml-2 min-h-10 rounded-md border border-input bg-background px-3">{[10,20,50].map(n => <option key={n}>{n}</option>)}</select></label>
    </div>
    {files.error ? <QueryNotice error={files.error} retry={files.refetch} /> : files.isLoading ? <p role="status" className="py-8 text-sm">{t("common.loading")}</p> : <>
      {!files.data?.length && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><FileText className="h-8 w-8" />{nl ? "Geen bestanden gevonden." : "No files found."}</div>}
      <div className="divide-y divide-border">
        {files.data?.slice(0, limit).map(item => <article key={item.id} className="flex items-center gap-3 py-4">
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1">
            <h2 className="break-words text-sm font-medium">{item.fileName || item.title || (nl ? "Naamloos document" : "Untitled document")}</h2>
            <p className="mt-1 break-words text-xs text-muted-foreground">{item.uploadSource}{item.uploadedAt && Number.isFinite(new Date(item.uploadedAt).getTime()) ? ` / ${formatDate(item.uploadedAt)}` : ""}</p>
          </div>
          <Button variant="outline" size="icon" title={nl ? "Bron openen" : "Open source"} aria-label={`${nl ? "Bron openen" : "Open source"}: ${item.fileName || item.title || item.id}`} disabled={source.isPending} onClick={() => void openFile(item.id)}><FolderOpen className="h-4 w-4" /></Button>
        </article>)}
      </div>
      {(page > 0 || (files.data?.length ?? 0) > limit) && <div className="flex items-center justify-between border-t border-border pt-4 text-sm">
        <Button size="icon" variant="outline" disabled={!page || files.isFetching} aria-label={nl ? "Vorige pagina" : "Previous page"} onClick={() => setPage(page - 1)}><ChevronLeft /></Button>
        <span>{nl ? "Pagina" : "Page"} {page + 1}</span>
        <Button size="icon" variant="outline" disabled={(files.data?.length ?? 0) <= limit || files.isFetching} aria-label={nl ? "Volgende pagina" : "Next page"} onClick={() => setPage(page + 1)}><ChevronRight /></Button>
      </div>}
    </>}
  </section>;
}

export default function Evidence() {
  const { locale, t } = useI18n();
  const nl = locale === "nl";
  const [params, setParams] = useSearchParams();
  const activeView = VIEW_IDS.includes(params.get("view") || "") ? params.get("view")! : "inbox";
  const selectedCaseId = params.get("case") || null;
  const selectedEvidenceId = params.get("evidence") || null;
  const selectedDocumentId = selectedEvidenceId ? null : params.get("document") || null;
  const selected = trpc.cases.byId.useQuery(selectedCaseId || "", { enabled: !!selectedCaseId });
  const [refreshKey, setRefreshKey] = useState(0);
  const utils = trpc.useUtils();
  const selectView = (view: string, caseId = selectedCaseId) => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.set("view", view);
    if (caseId) next.set("case", caseId); else next.delete("case");
    next.delete("evidence");
    next.delete("document");
    return next;
  });
  const dismissSearchResult = () => setParams(previous => {
    const next = new URLSearchParams(previous);
    next.delete("evidence");
    next.delete("document");
    return next;
  });
  const refreshEvidence = useCallback(async () => {
    await Promise.all([utils.evidenceFiles.invalidate(), utils.documentInbox.invalidate(), utils.cases.invalidate()]);
    setRefreshKey(key => key + 1);
  }, [utils]);
  useEffect(() => {
    const uploaded = () => { void refreshEvidence(); toast.success(nl ? "Bewijsstukken bijgewerkt" : "Evidence updated"); };
    window.addEventListener("laro:evidence-updated", uploaded);
    return () => window.removeEventListener("laro:evidence-updated", uploaded);
  }, [nl, refreshEvidence]);

  const views = [
    { id: "inbox", label: nl ? "Postvak" : "Inbox", icon: FileText },
    { id: "items", label: nl ? "Bestanden" : "Files", icon: ListChecks },
    { id: "timeline", label: nl ? "Tijdlijn" : "Timeline", icon: Clock },
    { id: "connections", label: nl ? "Verbindingen" : "Connections", icon: Link2 },
    { id: "dashboard", label: nl ? "Bewijsoverzicht" : "Evidence summary", icon: BarChart2 },
    { id: "collect", label: nl ? "Aan dossier toevoegen" : "Upload to case", icon: Cloud },
    { id: "gaps", label: nl ? "Ontbrekend bewijs" : "Gap analysis", icon: AlertTriangle },
    { id: "export", label: nl ? "Exporteren" : "Export", icon: Download },
    { id: "scoring", label: nl ? "Relevantie" : "Relevance", icon: Gauge },
  ];
  const advanced = views.slice(4);
  const advancedView = advanced.find(view => view.id === activeView);
  const needsCase = CASE_VIEWS.includes(activeView) && !selectedCaseId;

  return <DashboardLayout><div className="space-y-5">
    <PageHeading title={nl ? "Documenten" : "Documents"} actions={activeView !== "inbox" && <CasePicker value={selectedCaseId} onChange={id => selectView(activeView, id)} />} />
    {selectedEvidenceId && <SearchResultSelection type="evidence" id={selectedEvidenceId} onDismiss={dismissSearchResult} />}
    {selectedDocumentId && <SearchResultSelection type="document" id={selectedDocumentId} onDismiss={dismissSearchResult} />}
    <div className="sm:hidden"><SectionNavigation label={nl ? "Documentweergave" : "Evidence view"} items={views} value={activeView} onChange={view => selectView(view)} /></div>
    <div className="hidden items-end justify-between gap-3 border-b border-border sm:flex">
      <SectionNavigation label={nl ? "Documentweergave" : "Evidence view"} items={views.slice(0,4)} value={activeView} onChange={view => selectView(view)} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" className={`mb-1 ${advancedView ? "text-primary" : ""}`}>{advancedView?.label || (nl ? "Meer" : "More")}<ChevronDown className="h-4 w-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">{advanced.map(view => <DropdownMenuItem key={view.id} onClick={() => selectView(view.id)}><view.icon className="mr-2 h-4 w-4" />{view.label}</DropdownMenuItem>)}</DropdownMenuContent>
      </DropdownMenu>
    </div>
    {selected.error && activeView !== "inbox" && <QueryNotice error={selected.error} retry={selected.refetch} />}
    <Suspense fallback={<p role="status" className="py-12 text-center text-sm text-muted-foreground">{t("common.loading")}</p>}>
      {needsCase ? <section className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
        <FolderOpen className="h-8 w-8 text-muted-foreground" /><h2 className="text-base font-medium">{nl ? "Selecteer een dossier" : "Select a case"}</h2>
        <CasePicker value={null} onChange={id => selectView(activeView, id)} />
      </section> : <>
        {activeView === "inbox" && <DocumentInbox onOpenCase={id => selectView("timeline", id)} />}
        {activeView === "items" && <EvidenceFiles key={selectedCaseId || "all"} caseId={selectedCaseId} />}
        {activeView === "dashboard" && <EvidenceSummaryDashboard key={refreshKey} caseId={selectedCaseId ?? undefined} />}
        {activeView === "collect" && selectedCaseId && <EvidenceCollection caseId={selectedCaseId} onEvidenceUpdated={() => void refreshEvidence()} />}
        {activeView === "connections" && <div className="space-y-6"><EvidenceConnectionsCard />{selectedCaseId && <AutoCollectionSettings caseId={selectedCaseId} />}</div>}
        {activeView === "timeline" && selectedCaseId && <section aria-label="Case reconstruction"><h2 className="mb-4 text-base font-semibold">{nl ? "Bewijstijdlijn" : "Evidence Timeline"}</h2><CaseReconstruction key={`${selectedCaseId}-${refreshKey}`} caseId={selectedCaseId} /></section>}
        {activeView === "gaps" && selectedCaseId && <EvidenceGapAnalysisDashboard key={refreshKey} caseId={selectedCaseId} />}
        {activeView === "export" && selectedCaseId && <EvidenceExportUI caseId={selectedCaseId} />}
        {activeView === "scoring" && selectedCaseId && <RelevanceScoringDashboard caseId={selectedCaseId} caseDescription={selected.data?.caseSummary ?? ""} legalArea={selected.data?.caseType ?? ""} keyIssues={[]} />}
      </>}
    </Suspense>
  </div></DashboardLayout>;
}
