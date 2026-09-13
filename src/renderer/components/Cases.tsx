import { trpc } from "@/lib/trpc";
import DashboardLayout from "./DashboardLayout";
import { lazy, Suspense, useCallback, useState } from "react";
import { useLocation, useSearchParams } from "wouter";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { ArrowRight, Plus, ChevronDown, ChevronLeft, ChevronRight, Briefcase, FileText, Upload, Trash2, Clock } from "lucide-react";
import SmartSearchFilters from "./SmartSearchFilters";
import { PageHeading, QueryNotice } from "./WorkspaceUi";
import { useI18n } from "@/contexts/I18nContext";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

const EnhancedCaseDetailsDialog = lazy(() => import("./EnhancedCaseDetailsDialog"));
const CaseCreationWizard = lazy(() => import("./CaseCreationWizard"));
const BulkCaseImport = lazy(() => import("./BulkCaseImport").then(module => ({ default: module.BulkCaseImport })));
const BulkEvidenceUpload = lazy(() => import("./BulkEvidenceUpload"));

function CaseWorkspaceLoadingDialog({ title, onClose }: { title: string; onClose: () => void }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className="max-w-md">
    <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
    <div role="status" className="space-y-3"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-20 w-full" /></div>
  </DialogContent></Dialog>;
}

export default function Cases() {
  const { locale, t, formatDate } = useI18n();
  const nl = locale === "nl";
  const [, navigate] = useLocation();
  const [params, setParams] = useSearchParams();
  const selectedCaseId = params.get("case");
  const setSelectedCaseId = (id: string | null) => setParams(previous => {
    const next = new URLSearchParams(previous);
    if (id) next.set("case", id); else next.delete("case");
    return next;
  });
  const [newCaseOpen, setNewCaseOpen] = useState(false);
  const createCase = trpc.cases.create.useMutation();
  const utils = trpc.useUtils();
  const [page, setPage] = useState(1);
  const deleteCase = trpc.cases.delete.useMutation({
    onSuccess: result => {
      if (result.deletionStatus === "storage_cleanup_pending") {
        toast.warning(nl ? "Dossiergegevens verwijderd. Het opruimen van bestanden wordt automatisch opnieuw geprobeerd." : "Case records deleted. Storage cleanup is pending and will retry automatically.");
      } else { toast.success(nl ? "Dossier verwijderd" : "Case deleted"); }
      setPage(1);
      void utils.cases.invalidate();
      void utils.dashboard.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const [caseToDelete, setCaseToDelete] = useState<{ id: string; name: string } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filters, setFilters] = useState<Record<string, string | undefined>>({});
  const [sortBy, setSortBy] = useState<"updatedAt" | "createdAt" | "clientName">("updatedAt");
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [evidenceUploadCaseId, setEvidenceUploadCaseId] = useState<string | null>(null);
  const applySearchFilters = useCallback((query: string, nextFilters: Record<string, string | undefined> | null | undefined) => {
    setSearchTerm(query ?? "");
    setFilters(nextFilters || {});
    setPage(1);
  }, []);
  const hybrid = trpc.search.hybridCases.useQuery({ query: searchTerm.trim() }, { enabled: searchTerm.trim().length >= 2 && searchTerm.length <= 500, staleTime: 20_000 });
  const query = trpc.cases.list.useQuery({
    page, limit: 20, search: searchTerm, matchingIds: hybrid.data?.slice(0, 500), sortBy, sortDir: sortBy === "clientName" ? "asc" : "desc",
    statusGroup: ["open", "in_progress", "waiting_for_lawyer", "closed"].includes(filters.status || "") ? filters.status as "open" | "in_progress" | "waiting_for_lawyer" | "closed" : undefined,
    urgency: filters.urgency === "high" ? "High" : filters.urgency === "medium" ? "Medium" : filters.urgency === "low" ? "Low" : undefined,
    legalArea: filters.legalArea || undefined,
    createdWithin: ["today", "week", "month", "year"].includes(filters.dateRange || "") ? filters.dateRange as "today" | "week" | "month" | "year" : undefined,
  });
  const cases = query.data?.cases ?? [];
  const pagination = query.data?.pagination;
  const filtered = !!searchTerm || Object.values(filters).some(value => value && value !== "all");

  return (<DashboardLayout>
    <div className="space-y-5">
      <PageHeading title={nl ? "Dossiers" : "Cases"} actions={<>
        <Button variant="outline" onClick={() => setBulkImportOpen(true)}><Upload className="h-4 w-4" />{nl ? "Importeren" : "Bulk Import"}</Button>
        <Button onClick={() => setNewCaseOpen(true)}><Plus className="h-4 w-4" />{nl ? "Nieuw dossier" : "New Case"}</Button>
      </>} />
      <SmartSearchFilters compact onSearch={applySearchFilters} />
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <p role="status" className="text-muted-foreground">{query.isLoading ? t("common.loading") : query.error ? "" : `${pagination?.total ?? 0} ${nl ? "dossiers" : "cases"}`}</p>
        <label>{nl ? "Sorteren" : "Sort by"}<select value={sortBy} onChange={event => { setSortBy(event.target.value as typeof sortBy); setPage(1); }} className="ml-2 min-h-9 rounded-md border border-input bg-background px-2">
          <option value="updatedAt">{nl ? "Laatst bijgewerkt" : "Last updated"}</option><option value="createdAt">{nl ? "Nieuwste eerst" : "Newest first"}</option><option value="clientName">{nl ? "Naam" : "Name"}</option>
        </select></label>
      </div>
      {hybrid.error && searchTerm && <p role="status" className="text-sm text-muted-foreground">{nl ? "Uitgebreid zoeken is niet beschikbaar. Resultaten op trefwoorden worden wel getoond." : "Expanded search is unavailable. Keyword results are still shown."}</p>}
      {query.error ? <QueryNotice error={query.error} retry={query.refetch} /> : query.isLoading ? <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-24 w-full" />)}</div> : !cases.length ? <div className="flex min-h-64 flex-col items-center justify-center gap-4 border-y border-border text-center">
        <Briefcase className="h-8 w-8 text-muted-foreground" /><h2 className="text-base font-medium">{filtered ? nl ? "Geen dossiers gevonden" : "No matching cases" : nl ? "Nog geen dossiers" : "No cases yet"}</h2>
        {!filtered && <Button variant="outline" onClick={() => navigate("/evidence")}><FileText className="h-4 w-4" />{nl ? "Documenten toevoegen" : "Add documents"}</Button>}
      </div> : <div className="divide-y divide-border border-y border-border">
        {cases.map(item => <article key={item.id} className="flex items-start gap-3 py-5 sm:gap-4">
          <Briefcase className="mt-1 hidden h-5 w-5 shrink-0 text-muted-foreground sm:block" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="min-w-0 text-base font-semibold"><button type="button" onClick={() => setSelectedCaseId(item.id)} className="break-words text-left hover:text-primary">{item.clientName || item.caseType || item.id}</button></h2>
              <Badge variant="outline">{t(`case.status.${item.status}` as Parameters<typeof t>[0]) === `case.status.${item.status}` ? item.status : t(`case.status.${item.status}` as Parameters<typeof t>[0])}</Badge>
              {item.urgency === "High" && <Badge variant="outline" className="border-red-400/40 text-red-300">{nl ? "Hoge prioriteit" : "High priority"}</Badge>}
            </div>
            <p className="mt-1 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">{item.caseSummary}</p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
              <span>{item.caseType}</span><span>{item.updatedAt ? formatDate(item.updatedAt) : ""}</span>
              <Button variant="ghost" size="sm" onClick={() => setSelectedCaseId(item.id)}>{nl ? "Dossier openen" : "Open case"}<ArrowRight className="h-4 w-4" /></Button>
              <Button variant="ghost" size="sm" onClick={() => navigate(`/evidence?view=timeline&case=${encodeURIComponent(item.id)}`)}><Clock className="h-4 w-4" />{nl ? "Tijdlijn" : "Timeline"}</Button>
            </div>
          </div>
          <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="ghost" aria-label={`${nl ? "Dossieracties" : "Case actions"}: ${item.clientName || item.id}`}><ChevronDown /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEvidenceUploadCaseId(item.id)}><Upload className="mr-2 h-4 w-4" />{nl ? "Bewijs toevoegen" : "Upload evidence"}</DropdownMenuItem>
              <DropdownMenuItem className="text-destructive" onClick={() => setCaseToDelete({ id: item.id, name: item.clientName || item.caseType || item.id })}><Trash2 className="mr-2 h-4 w-4" />{nl ? "Dossier verwijderen" : "Delete case"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </article>)}
      </div>}
      {pagination && pagination.totalPages > 1 && <nav aria-label={nl ? "Dossierpagina's" : "Case pages"} className="flex items-center justify-between gap-3">
        <Button variant="outline" size="icon" aria-label={nl ? "Vorige pagina" : "Previous page"} disabled={page === 1 || query.isFetching} onClick={() => setPage(page - 1)}><ChevronLeft /></Button>
        <span className="text-sm">{nl ? "Pagina" : "Page"} {page} / {pagination.totalPages}</span>
        <Button variant="outline" size="icon" aria-label={nl ? "Volgende pagina" : "Next page"} disabled={page >= pagination.totalPages || query.isFetching} onClick={() => setPage(page + 1)}><ChevronRight /></Button>
      </nav>}
    </div>
      {newCaseOpen && (
        <Suspense fallback={<CaseWorkspaceLoadingDialog title="Opening new case form" onClose={() => setNewCaseOpen(false)} />}>
          <CaseCreationWizard
            open={newCaseOpen}
            onOpenChange={setNewCaseOpen}
            onComplete={async (caseData) => {
              try {
                const created = await createCase.mutateAsync({
                  caseType: caseData.legalArea || "AI Classification Pending",
                  caseSummary: caseData.summary || "",
                  urgency: "Medium",
                  clientName: caseData.clientName,
                  clientEmail: caseData.clientEmail,
                });
                setPage(1);
                await Promise.all([
                  utils.cases.list.invalidate(),
                  utils.dashboard.stats.invalidate(),
                  utils.dashboard.recentCases.invalidate(),
                ]);
                if (caseData.uploadDocumentsAfterCreate) {
                  setEvidenceUploadCaseId(created.id);
                }
                return true;
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Failed to create case");
                return false;
              }
            }}
          />
        </Suspense>
      )}
      {selectedCaseId && (
        <Suspense fallback={<CaseWorkspaceLoadingDialog title="Opening case details" onClose={() => setSelectedCaseId(null)} />}>
          <EnhancedCaseDetailsDialog
            caseId={selectedCaseId}
            open={!!selectedCaseId}
            onOpenChange={(open) => !open && setSelectedCaseId(null)}
          />
        </Suspense>
      )}
      
      <Dialog open={bulkImportOpen} onOpenChange={setBulkImportOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bulk Case Import</DialogTitle>
          </DialogHeader>
          {bulkImportOpen && (
            <Suspense fallback={<div role="status" aria-live="polite"><Skeleton className="h-48 w-full" /></div>}>
              <BulkCaseImport />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
      {evidenceUploadCaseId && (
        <Suspense fallback={<CaseWorkspaceLoadingDialog title="Opening evidence upload" onClose={() => setEvidenceUploadCaseId(null)} />}>
          <BulkEvidenceUpload
            caseId={evidenceUploadCaseId}
            open={!!evidenceUploadCaseId}
            onClose={() => setEvidenceUploadCaseId(null)}
            onComplete={() => setEvidenceUploadCaseId(null)}
          />
        </Suspense>
      )}

      <Dialog
        open={!!caseToDelete}
        onOpenChange={(open: boolean) => {
          if (!open && !deleteCase.isLoading) setCaseToDelete(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this case?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will erase{" "}
            <span className="font-medium text-foreground">
              {caseToDelete?.name}
            </span>{" "}
            and all its live evidence, outreach, deadlines, and related data. Recovery backups may retain prior copies until the configured retention period expires (30 days by default).
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setCaseToDelete(null)}
              disabled={deleteCase.isLoading}
            >
              Cancel
            </Button>
            <Button
              className="bg-red-500 hover:bg-red-600"
              disabled={deleteCase.isLoading}
              onClick={async () => {
                if (!caseToDelete) return;
                try {
                  await deleteCase.mutateAsync({ id: caseToDelete.id });
                  setCaseToDelete(null);
                } catch {
                  // toast already shown by onError
                }
              }}
            >
              {deleteCase.isLoading ? "Deleting…" : "Erase case"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
