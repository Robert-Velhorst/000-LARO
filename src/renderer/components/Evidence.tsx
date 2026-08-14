import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import {
  FileText, Cloud, BarChart2, ListChecks,
  Clock, FolderOpen, AlertTriangle, Link2, Download, Gauge, Sparkles,
} from "lucide-react";
import { lazy, Suspense, useState, useEffect, useCallback, useMemo } from "react";
import EvidenceSummaryDashboard from "@/components/EvidenceSummaryDashboard";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

const EvidenceCollection = lazy(() =>
  import("@/components/EvidenceCollection").then((module) => ({ default: module.EvidenceCollection }))
);
const AutoCollectionSettings = lazy(() => import("@/components/AutoCollectionSettings"));
const EvidenceConnectionsCard = lazy(() => import("@/components/EvidenceConnectionsCard"));
const EvidenceTimeline = lazy(() => import("@/components/EvidenceTimeline"));
const EvidenceGapAnalysisDashboard = lazy(() =>
  import("@/components/EvidenceGapAnalysisDashboard").then((module) => ({ default: module.EvidenceGapAnalysisDashboard }))
);
const RelevanceScoringDashboard = lazy(() => import("@/components/RelevanceScoringDashboard"));
const EvidenceExportUI = lazy(() => import("@/components/EvidenceExportUI"));

function EvidenceViewFallback() {
  return (
    <Card>
      <CardContent className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
        Loading evidence view...
      </CardContent>
    </Card>
  );
}

export default function Evidence() {
  const [activeView,        setActiveView]        = useState("dashboard");
  const [selectedCaseId,    setSelectedCaseId]    = useState<string | null>(null);
  const [refreshKey,        setRefreshKey]        = useState(0);
  const [itemsBatchSize,    setItemsBatchSize]    = useState(12);

  // ── Real data ──────────────────────────────────────────────────────────────
  const { data: casesData, isLoading: casesLoading } = trpc.cases.list.useQuery();
  const cases = casesData?.cases ?? [];

  const { data: filesData, refetch: refetchFiles } = trpc.evidenceFiles.search.useQuery(
    { caseId: selectedCaseId ?? undefined },
    { enabled: true }
  );
  const evidenceItems = (filesData as any[]) ?? [];
  const selectedCase = cases.find((c: any) => c.id === selectedCaseId);
  const caseLabel =
    selectedCase?.clientName ??
    selectedCase?.caseType ??
    "Selected case";

  const stats = useMemo(() => {
    const total = evidenceItems.length;
    const relevant = evidenceItems.filter((f: any) => f.relevant !== false).length;
    const sources = new Set(
      evidenceItems.map((f: any) => String(f.uploadSource ?? f.source ?? "manual").toLowerCase())
    );
    const scanCount = evidenceItems.filter((f: any) => {
      const src = String(f.uploadSource ?? f.source ?? "").toLowerCase();
      return src.includes("scan") || src.includes("agent");
    }).length;
    const completeness = total === 0 ? 0 : Math.min(100, Math.round((relevant / total) * 70 + Math.min(total, 30)));
    return { total, relevant, sources: sources.size, scanCount, completeness };
  }, [evidenceItems]);

  const prioritizedIssues = useMemo(() => {
    const issues: Array<{ label: string; severity: "high" | "medium" | "low" }> = [];
    if (stats.total < 5) issues.push({ label: "Low evidence volume for this case", severity: "high" });
    if (stats.sources < 2) issues.push({ label: "Evidence comes from too few sources", severity: "medium" });
    if (stats.scanCount === 0) issues.push({ label: "No desktop scan evidence included", severity: "medium" });
    if (stats.relevant < Math.max(1, Math.floor(stats.total * 0.5))) {
      issues.push({ label: "Low relevance ratio detected", severity: "high" });
    }
    if (issues.length === 0) issues.push({ label: "No critical gaps detected", severity: "low" });
    return issues;
  }, [stats]);

  // ── Listen for Electron scanner events ────────────────────────────────────
  const handleEvidenceUpdated = useCallback((event: Event) => {
    const detail = (event as CustomEvent).detail;
    toast.success(`Scanner upload complete — refreshing evidence...`);
    refetchFiles();
    setRefreshKey(k => k + 1);
    // Auto-switch to dashboard so she sees the new files
    setActiveView("dashboard");
  }, [refetchFiles]);

  useEffect(() => {
    window.addEventListener("laro:evidence-updated", handleEvidenceUpdated);
    return () => window.removeEventListener("laro:evidence-updated", handleEvidenceUpdated);
  }, [handleEvidenceUpdated]);

  const handleManualEvidenceUpdated = useCallback(() => {
    refetchFiles();
    setRefreshKey((k) => k + 1);
  }, [refetchFiles]);

  const visibleItems = useMemo(() => {
    return [...evidenceItems]
      .sort((a: any, b: any) => {
        const ad = new Date(a.uploadedAt ?? a.createdAt ?? 0).getTime();
        const bd = new Date(b.uploadedAt ?? b.createdAt ?? 0).getTime();
        return bd - ad;
      })
      .slice(0, itemsBatchSize);
  }, [evidenceItems, itemsBatchSize]);

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: BarChart2 },
    { id: "collect", label: "Collect", icon: Cloud },
    { id: "connections", label: "Connections", icon: Link2 },
    { id: "items", label: "Items", icon: ListChecks },
    { id: "timeline", label: "Timeline", icon: Clock },
    { id: "gaps", label: "Gap Analysis", icon: AlertTriangle },
    { id: "export", label: "Export", icon: Download },
    { id: "scoring", label: "Scoring", icon: Gauge },
  ];

  return (
    <DashboardLayout>
      <div className="space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-orange-400 to-orange-600 bg-clip-text text-transparent">
              Evidence & Documents
            </h1>
            <p className="text-muted-foreground mt-2 text-lg">
              Case-focused evidence workspace
            </p>
          </div>
          <div />
        </div>

        {/* Case Selection */}
        {casesLoading ? (
          <Card className="border-border/50">
            <CardContent className="py-8 text-center text-muted-foreground">
              Loading cases...
            </CardContent>
          </Card>
        ) : cases.length === 0 ? (
          <Card className="border-dashed border-2 border-border/50">
            <CardContent className="py-8 text-center">
              <AlertTriangle className="w-10 h-10 mx-auto text-orange-400 mb-3" />
              <p className="font-semibold">No cases available</p>
              <p className="text-sm text-muted-foreground mt-1">
                Evidence analytics will appear once at least one case exists.
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5" />
                Select a Case
                {selectedCaseId && (
                  <Badge variant="outline" className="ml-2 text-orange-500 border-orange-300">
                    {cases.find((c: any) => c.id === selectedCaseId)?.clientName ?? "Selected"}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                Choose which case to view evidence for, or leave unselected to see all
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant={selectedCaseId === null ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedCaseId(null)}
                  className={selectedCaseId === null ? "bg-orange-500 hover:bg-orange-600" : ""}
                >
                  All Cases
                </Button>
                {cases.map((c: any) => (
                  <Button
                    key={c.id}
                    variant={selectedCaseId === c.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedCaseId(c.id)}
                    className={selectedCaseId === c.id ? "bg-orange-500 hover:bg-orange-600" : ""}
                  >
                    {c.clientName ?? c.caseType ?? "Case"}
                    <Badge variant="secondary" className="ml-2 text-xs">
                      {c.status ?? "active"}
                    </Badge>
                  </Button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Sidebar layout: nav + main + persistent context */}
        <div className="grid grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)_340px] gap-6">
          <Card className="border-border/50 bg-card/50 h-fit shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Evidence Pages</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeView === item.id;
                return (
                  <Button
                    key={item.id}
                    variant={active ? "default" : "ghost"}
                    className={`w-full justify-start ${active ? "bg-orange-500 hover:bg-orange-600" : ""}`}
                    onClick={() => setActiveView(item.id)}
                  >
                    <Icon className="w-4 h-4 mr-2" />
                    {item.label}
                  </Button>
                );
              })}
            </CardContent>
          </Card>

          <Suspense fallback={<EvidenceViewFallback />}>
          <div className="min-w-0 space-y-4">
            {activeView === "dashboard" && (
              <EvidenceSummaryDashboard key={refreshKey} caseId={selectedCaseId ?? undefined} />
            )}

            {activeView === "collect" && (
              selectedCaseId ? (
                <EvidenceCollection
                  caseId={selectedCaseId}
                  onEvidenceUpdated={handleManualEvidenceUpdated}
                />
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Cloud className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <p className="text-lg font-semibold">Select a case above</p>
                    <p className="text-muted-foreground mt-2">
                      Choose a specific case to upload and manage evidence.
                    </p>
                  </CardContent>
                </Card>
              )
            )}

            {activeView === "connections" && (
              <>
                <EvidenceConnectionsCard />
                {selectedCaseId && <AutoCollectionSettings caseId={selectedCaseId} />}
              </>
            )}

            {activeView === "items" && (
              <Card className="border-border/50 bg-card/50">
                <CardHeader>
                  <CardTitle>Evidence Items</CardTitle>
                  <CardDescription>
                    Review recent files with adjustable batch size
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Items per batch</span>
                      <span className="font-medium">{itemsBatchSize}</span>
                    </div>
                    <Slider
                      value={[itemsBatchSize]}
                      min={5}
                      max={50}
                      step={1}
                      onValueChange={(v: number[]) => setItemsBatchSize(v[0] ?? 12)}
                    />
                  </div>
                  <div className="space-y-2 max-h-[520px] overflow-y-auto">
                    {visibleItems.map((item: any) => (
                      <div key={item.id} className="rounded-lg border border-border/50 p-3">
                        <p className="font-medium text-sm truncate">{item.fileName ?? item.title ?? "Untitled"}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(item.uploadedAt ?? item.createdAt).toLocaleString()} • {item.fileType ?? item.mimeType ?? "file"}
                        </p>
                      </div>
                    ))}
                    {visibleItems.length === 0 && (
                      <p className="text-sm text-muted-foreground py-6 text-center">No items for this case.</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {activeView === "timeline" && (
              selectedCaseId ? (
                <EvidenceTimeline key={`timeline-${refreshKey}`} caseId={selectedCaseId} />
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Clock className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                    <p className="text-lg font-semibold">Select a case above</p>
                    <p className="text-muted-foreground mt-2">
                      Choose a case to see its evidence timeline.
                    </p>
                  </CardContent>
                </Card>
              )
            )}

            {activeView === "gaps" && (
              selectedCaseId ? (
                <EvidenceGapAnalysisDashboard key={`gaps-${refreshKey}`} caseId={selectedCaseId} />
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <AlertTriangle className="w-12 h-12 mx-auto mb-4 text-orange-400 opacity-70" />
                    <p className="text-lg font-semibold">Select a case above</p>
                    <p className="text-muted-foreground mt-2">
                      Gap analysis needs a specific case context.
                    </p>
                  </CardContent>
                </Card>
              )
            )}

            {activeView === "export" && (
              selectedCaseId ? (
                <EvidenceExportUI caseId={selectedCaseId} />
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Download className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-60" />
                    <p className="text-lg font-semibold">Select a case above</p>
                    <p className="text-muted-foreground mt-2">Exports are always scoped to one case.</p>
                  </CardContent>
                </Card>
              )
            )}

            {activeView === "scoring" && (
              selectedCaseId ? (
                <RelevanceScoringDashboard
                  caseId={selectedCaseId}
                  caseDescription={selectedCase?.caseSummary ?? ""}
                  legalArea={selectedCase?.caseType ?? selectedCase?.legalAreas ?? ""}
                  keyIssues={[]}
                />
              ) : (
                <Card>
                  <CardContent className="p-12 text-center">
                    <Gauge className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-60" />
                    <p className="text-lg font-semibold">Select a case above</p>
                    <p className="text-muted-foreground mt-2">
                      Scoring needs case-specific evidence.
                    </p>
                  </CardContent>
                </Card>
              )
            )}
          </div>
          </Suspense>

          <div className="space-y-4">
            <Card className="border-border/50 bg-card/50 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Case Context</CardTitle>
                <CardDescription>{selectedCaseId ? caseLabel : "All cases overview"}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  <Card className="border-border/50 bg-background/40">
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">Total</p>
                      <p className="text-2xl font-bold">{stats.total}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/50 bg-background/40">
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">Relevant</p>
                      <p className="text-2xl font-bold text-green-500">{stats.relevant}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/50 bg-background/40">
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">Sources</p>
                      <p className="text-2xl font-bold">{stats.sources}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/50 bg-background/40">
                    <CardContent className="p-4">
                      <p className="text-xs text-muted-foreground mb-1">Scans</p>
                      <p className="text-2xl font-bold">{stats.scanCount}</p>
                    </CardContent>
                  </Card>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/50 bg-card/50 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Evidence Completeness</CardTitle>
                <CardDescription>Coverage signal from the current evidence profile, not a legal-outcome score</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Score</span>
                  <span className="text-lg font-semibold">{stats.completeness}/100</span>
                </div>
                <Progress aria-label="Evidence completeness" value={stats.completeness} />
              </CardContent>
            </Card>

            <Card className="border-border/50 bg-card/50 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Areas To Improve</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {prioritizedIssues.map((issue, idx) => (
                  <div key={idx} className="rounded-md border border-border/50 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm">{issue.label}</p>
                      <Badge variant={issue.severity === "high" ? "destructive" : "outline"}>
                        {issue.severity}
                      </Badge>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card className="border-border/50 bg-card/50 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="w-4 h-4 text-orange-500" />
                  Recommended Actions
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p>1. Add missing source evidence (email + cloud + local).</p>
                <p>2. Run scoring after major uploads for updated relevance.</p>
                <p>3. Export a fresh report once gap items are resolved.</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
