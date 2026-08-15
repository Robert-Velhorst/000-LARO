import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import CaseCreationWizard from "@/components/CaseCreationWizard";
import EnhancedCaseDetailsDialog from "@/components/EnhancedCaseDetailsDialog";
import { useCallback, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, MapPin, Clock, Briefcase, FileText, Upload, Trash2 } from "lucide-react";
import SmartSearchFilters from "@/components/SmartSearchFilters";
import { BulkCaseImport } from "@/components/BulkCaseImport";
import BulkEvidenceUpload from "@/components/BulkEvidenceUpload";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function matchesUrgencyFilter(caseUrgency: string | null | undefined, filter: string | null) {
  if (!filter || filter === "all") return true;
  return (caseUrgency ?? "").toLowerCase() === filter.toLowerCase();
}

/** UI filter values vs DB status strings (e.g. Matching, Outreach, Matched) */
function matchesStatusFilter(dbStatus: string | null | undefined, filter: string | null) {
  if (!filter || filter === "all") return true;
  const s = (dbStatus ?? "").toLowerCase().replace(/\s+/g, "_");
  const f = filter.toLowerCase();
  if (s === f) return true;
  const groups: Record<string, string[]> = {
    open: ["matching", "active", "pending", "open", "new"],
    in_progress: ["outreach", "in_progress", "review", "progress"],
    waiting_for_lawyer: ["waiting_for_lawyer", "waiting"],
    closed: ["closed", "matched", "resolved", "complete"],
  };
  return (groups[f] ?? []).includes(s);
}

const LEGAL_AREA_HINTS: Record<string, string[]> = {
  family: ["family", "divorce", "custody", "familierecht", "marriage"],
  employment: ["employment", "labor", "arbeid", "workplace", "termination", "wrongful"],
  contract: ["contract", "agreement", "lease", "verbint", "commercial"],
  "real-estate": ["real estate", "property", "huur", "tenancy", "huurrecht", "landlord"],
};

function matchesLegalAreaFilter(caseItem: any, filter: string | null) {
  if (!filter || filter === "all") return true;
  let areas: string[] = [];
  if (caseItem.legalAreas) {
    try {
      const raw =
        typeof caseItem.legalAreas === "string"
          ? JSON.parse(caseItem.legalAreas)
          : caseItem.legalAreas;
      areas = Array.isArray(raw) ? raw.map((a: any) => (typeof a === "string" ? a : a?.area || a?.areaEn || "")) : [];
    } catch {
      areas = typeof caseItem.legalAreas === "string" ? [caseItem.legalAreas] : [];
    }
  }
  const blob = [caseItem.caseType, caseItem.caseSummary, ...areas].join(" ").toLowerCase();
  const hints = LEGAL_AREA_HINTS[filter] ?? [filter.replace(/-/g, " ")];
  return hints.some((h) => blob.includes(h.toLowerCase()));
}

function matchesDateRangeFilter(createdAt: Date | string | null | undefined, range: string | null) {
  if (!range || range === "all") return true;
  const t = new Date(createdAt ?? 0).getTime();
  if (Number.isNaN(t)) return true;
  const now = Date.now();
  const day = 86400000;
  switch (range) {
    case "today":
      return t >= now - day;
    case "week":
      return t >= now - 7 * day;
    case "month":
      return t >= now - 30 * day;
    case "year":
      return t >= now - 365 * day;
    default:
      return true;
  }
}

function parseLegalAreas(caseItem: any): string[] {
  if (!caseItem.legalAreas) return [];
  try {
    const raw =
      typeof caseItem.legalAreas === "string"
        ? JSON.parse(caseItem.legalAreas)
        : caseItem.legalAreas;
    return Array.isArray(raw)
      ? raw.map((a: any) => (typeof a === "string" ? a : a?.area || a?.areaEn || ""))
      : [];
  } catch {
    return typeof caseItem.legalAreas === "string" ? [caseItem.legalAreas] : [];
  }
}

export default function Cases() {
  const [newCaseOpen, setNewCaseOpen] = useState(false);
  const createCase = trpc.cases.create.useMutation();
  const utils = trpc.useUtils();
  const deleteCase = trpc.cases.delete.useMutation({
    onSuccess: (result) => {
      if (result.deletionStatus === "storage_cleanup_pending") {
        toast.warning("Case records deleted. Storage cleanup is pending and will retry automatically.");
      } else {
        toast.success("Case deleted");
      }
      utils.cases.list.invalidate();
    },
    onError: (err) => {
      toast.error(`Failed to delete case: ${err.message}`);
    },
  });
  const [caseToDelete, setCaseToDelete] = useState<{ id: string; name: string } | null>(null);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [urgencyFilter, setUrgencyFilter] = useState<string | null>(null);
  const [legalAreaFilter, setLegalAreaFilter] = useState<string | null>(null);
  const [dateRangeFilter, setDateRangeFilter] = useState<string | null>(null);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [evidenceUploadCaseId, setEvidenceUploadCaseId] = useState<string | null>(null);

  const applySearchFilters = useCallback((query: string, filters: Record<string, string | undefined> | null | undefined) => {
    setSearchTerm(query ?? "");
    if (filters == null) {
      setStatusFilter(null);
      setUrgencyFilter(null);
      setLegalAreaFilter(null);
      setDateRangeFilter(null);
      return;
    }
    const pick = (v: string | undefined) => (v && v !== "all" ? v : null);
    setStatusFilter(pick(filters.status));
    setUrgencyFilter(pick(filters.urgency));
    setLegalAreaFilter(pick(filters.legalArea));
    setDateRangeFilter(pick(filters.dateRange));
  }, []);

  const { data, isLoading } = trpc.cases.list.useQuery({ page, limit: 20 });
  const allCases = data?.cases ?? [];
  const pagination = data?.pagination;

  const hybridEnabled = searchTerm.trim().length >= 2;
  const { data: hybridCaseIds = [] } = trpc.search.hybridCases.useQuery(
    { query: searchTerm.trim() },
    { enabled: hybridEnabled, staleTime: 20_000 }
  );
  const hybridSet = useMemo(
    () => (hybridEnabled ? new Set(hybridCaseIds) : null),
    [hybridEnabled, hybridCaseIds]
  );

  const cases = useMemo(() => {
    return allCases.filter((c: any) => {
      const qRaw = searchTerm.trim();
      const q = qRaw.toLowerCase();
      const clientKeywordMatch =
        !qRaw ||
        (c.caseType && String(c.caseType).toLowerCase().includes(q)) ||
        (c.caseSummary && String(c.caseSummary).toLowerCase().includes(q)) ||
        (c.clientName && String(c.clientName).toLowerCase().includes(q));

      const matchesNl = hybridEnabled && hybridSet ? hybridSet.has(c.id) : false;
      const matchesSearch = !qRaw || clientKeywordMatch || matchesNl;

      const matchesStatus = matchesStatusFilter(c.status, statusFilter);
      const matchesUrgency = matchesUrgencyFilter(c.urgency, urgencyFilter);
      const matchesLegal = matchesLegalAreaFilter(c, legalAreaFilter);
      const matchesDate = matchesDateRangeFilter(c.createdAt, dateRangeFilter);

      return matchesSearch && matchesStatus && matchesUrgency && matchesLegal && matchesDate;
    });
  }, [
    allCases,
    searchTerm,
    hybridEnabled,
    hybridSet,
    statusFilter,
    urgencyFilter,
    legalAreaFilter,
    dateRangeFilter,
  ]);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Top controls: title + actions + search/filter */}
        <div className="space-y-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h1 className="text-3xl font-bold bg-gradient-to-r from-orange-400 to-orange-600 bg-clip-text text-transparent sm:text-4xl">
                Your Cases
              </h1>
              <p className="text-muted-foreground mt-2">
                Track your legal matters and lawyer connections
              </p>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button
                onClick={() => setBulkImportOpen(true)}
                variant="outline"
                className="flex-1 border-orange-500/30 hover:bg-orange-500/10 sm:flex-none"
              >
                <Upload className="w-4 h-4 mr-2" />
                Bulk Import
              </Button>
              <Button
                onClick={() => setNewCaseOpen(true)}
                className="flex-1 bg-orange-500 hover:bg-orange-600 sm:flex-none"
              >
                <Plus className="w-4 h-4 mr-2" />
                New Case
              </Button>
            </div>
          </div>

          <div>
            <SmartSearchFilters compact onSearch={applySearchFilters} />
          </div>
        </div>

        {/* Cases Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-80 w-full bg-card/50" />
            ))}
          </div>
        ) : allCases.length === 0 ? (
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="p-4 rounded-full bg-orange-500/10 mb-4">
                <FileText className="w-12 h-12 text-orange-500" />
              </div>
              <h3 className="text-2xl font-semibold mb-2">You haven't created any cases yet</h3>
              <p className="text-muted-foreground mb-6 max-w-md">
                Tell us about your legal issue and we'll connect you with qualified lawyers who can help.
              </p>
              <p className="text-sm text-muted-foreground">
                Use the single <span className="font-medium text-foreground">New Case</span> action in the page header to create your case.
              </p>
            </CardContent>
          </Card>
        ) : cases.length === 0 ? (
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <FileText className="w-12 h-12 text-orange-500 mx-auto mb-4 opacity-80" />
              <h3 className="text-xl font-semibold mb-2">No cases match your filters</h3>
              <p className="text-muted-foreground text-sm max-w-md">
                Try clearing urgency, status, legal area, or date filters, or adjust your search text.
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {cases.map((caseItem: any) => {
                const legalAreas = parseLegalAreas(caseItem);
                return (
                  <Card
                    key={caseItem.id}
                    className="group border-border/50 bg-card/50 backdrop-blur-sm transition-all duration-300 hover:scale-[1.02] hover:bg-card/80 hover:shadow-xl hover:shadow-orange-500/10"
                  >
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="mb-2 flex items-center gap-2">
                            <div className="rounded-lg bg-blue-500/10 p-2">
                              <Briefcase className="h-4 w-4 text-blue-500" />
                            </div>
                            <CardTitle className="text-lg">Your {caseItem.caseType} Case</CardTitle>
                          </div>
                          <p className="text-sm text-muted-foreground">{caseItem.caseType}</p>
                        </div>
                        <Badge
                          variant={
                            caseItem.status === "Matched"
                              ? "default"
                              : caseItem.status === "Outreach"
                                ? "secondary"
                                : "outline"
                          }
                          className={
                            caseItem.status === "Matched"
                              ? "bg-green-500 hover:bg-green-600"
                              : caseItem.status === "Outreach"
                                ? "bg-blue-500 hover:bg-blue-600"
                                : ""
                          }
                        >
                          {caseItem.status}
                        </Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="line-clamp-2 text-sm text-muted-foreground">{caseItem.caseSummary}</p>
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <MapPin className="h-4 w-4 shrink-0" />
                          <span>{caseItem.clientAddress || "No address provided"}</span>
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Clock className="h-4 w-4 shrink-0" />
                          <span>Created {new Date(caseItem.createdAt).toLocaleDateString()}</span>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {legalAreas.map((area: any, index: number) => (
                          <Badge
                            key={index}
                            variant="secondary"
                            className="border-purple-500/30 bg-purple-500/20 text-purple-300"
                          >
                            {typeof area === "string" ? area : area.area || area.areaEn || "Unknown"}
                          </Badge>
                        ))}
                      </div>
                      <div className="flex items-center justify-between pt-2">
                        <Badge
                          variant="outline"
                          className={
                            caseItem.urgency === "High"
                              ? "border-red-500/50 text-red-400"
                              : caseItem.urgency === "Medium"
                                ? "border-yellow-500/50 text-yellow-400"
                                : "border-green-500/50 text-green-400"
                          }
                        >
                          {caseItem.urgency} Priority
                        </Badge>
                      </div>
                      <div className="mt-4 flex gap-2">
                        <Button
                          variant="outline"
                          onClick={() => {
                            localStorage.setItem(`case-tab-${caseItem.id}`, "evidence");
                            setSelectedCaseId(caseItem.id);
                          }}
                          className="flex-1 border-blue-500/30 transition-all group-hover:border-blue-500/50 hover:bg-blue-500/10"
                        >
                          View Your Case Details
                        </Button>
                        <Button
                          variant="outline"
                          size="icon"
                          aria-label="Delete case"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCaseToDelete({
                              id: caseItem.id,
                              name: caseItem.clientName || caseItem.caseType || caseItem.id,
                            });
                          }}
                          className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Pagination Controls */}
            {pagination && pagination.totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-8">
                <Button
                  variant="outline"
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="border-purple-500/30 hover:bg-purple-500/10"
                >
                  Previous
                </Button>
                <div className="flex items-center gap-2">
                  {Array.from({ length: Math.min(pagination.totalPages, 10) }, (_, i) => i + 1).map((pageNum) => (
                    <Button
                      key={pageNum}
                      variant={page === pageNum ? "default" : "outline"}
                      onClick={() => setPage(pageNum)}
                      className={page === pageNum 
                        ? "bg-gradient-to-r from-purple-500 to-pink-500" 
                        : "border-purple-500/30 hover:bg-purple-500/10"
                      }
                    >
                      {pageNum}
                    </Button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  onClick={() => setPage(p => Math.min(pagination.totalPages, p + 1))}
                  disabled={page === pagination.totalPages}
                  className="border-purple-500/30 hover:bg-purple-500/10"
                >
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      
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
      {selectedCaseId && (
        <EnhancedCaseDetailsDialog
          caseId={selectedCaseId}
          open={!!selectedCaseId}
          onOpenChange={(open) => !open && setSelectedCaseId(null)}
        />
      )}
      
      <Dialog open={bulkImportOpen} onOpenChange={setBulkImportOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bulk Case Import</DialogTitle>
          </DialogHeader>
          <BulkCaseImport />
        </DialogContent>
      </Dialog>
      {evidenceUploadCaseId && (
        <BulkEvidenceUpload
          caseId={evidenceUploadCaseId}
          open={!!evidenceUploadCaseId}
          onClose={() => setEvidenceUploadCaseId(null)}
          onComplete={() => setEvidenceUploadCaseId(null)}
        />
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
