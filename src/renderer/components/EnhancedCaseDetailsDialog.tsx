import { useCallback, useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { MultiAreaOutreachProgress } from "@/components/OutreachProgressBar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  MapPin,
  Phone,
  Mail,
  Briefcase,
  Target,
  Send,
  CheckCircle2,
  XCircle,
  Edit,
  Save,
  X,
  MessageSquare,
  Calendar,
  Scale,
  CloudDownload,
  Download,
  Printer,
  FileText,
  BarChart3,
  Users,
  Search,
  Activity,
  Layers,
  GitBranch,
  TrendingUp,
  Shield,
  ChevronRight,
  Sparkles,
  Loader2,
  FolderPlus,
  Plus,
  Folder,
  ExternalLink,
  Database,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import { LegalAreasSelect } from "@/components/LegalAreasSelect";
import { EvidenceCollection } from "@/components/EvidenceCollection";
import TimelineView from "@/components/TimelineView";
import CommunicationHub from "@/components/CommunicationHub";
import EvidenceTimelineView from "@/components/EvidenceTimelineView";
import OutreachAnalyticsView from "@/components/OutreachAnalyticsView";
import { EvidenceGapAnalysisDashboard } from "@/components/EvidenceGapAnalysisDashboard";
import EnhancedEvidenceUpload from "@/components/EnhancedEvidenceUpload";
import { CollectionMonitoringDashboard } from "@/components/CollectionMonitoringDashboard";
import ProgressTrackingDashboard from "@/components/ProgressTrackingDashboard";
import { AutomatedDocumentAnalysis } from "@/components/AutomatedDocumentAnalysis";
import { CaseTimeline } from "@/components/CaseTimeline";
import { CaseReconstruction } from "@/components/CaseReconstruction";
import { exportCaseSummary, printCaseSummary } from "@/lib/export";
import { getElectronAPI, isElectron } from "@/lib/electronApiShim";
import CaseStatusWorkflow from "@/components/CaseStatusWorkflow";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGoogleOAuthConnection } from "@/hooks/useGoogleOAuthConnection";

interface EnhancedCaseDetailsDialogProps {
  caseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * One-shot keyword pull panel — the acceptance-test entry point. User types
 * keywords, clicks Pull, and LARO autonomously fetches matching evidence
 * from every connected source (Gmail, Google Drive, local folders) into the
 * case.
 */
function KeywordEvidencePull({ caseId }: { caseId: string }) {
  const [keywordsRaw, setKeywordsRaw] = useState("");
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [matchMode, setMatchMode] = useState<"all" | "any">("any");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [pullJobId, setPullJobId] = useState<string | null>(null);
  const [handledJobId, setHandledJobId] = useState<string | null>(null);

  const utils = trpc.useUtils();

  const {
    data: driveStatus,
    error: driveStatusError,
    refetch: refetchDriveStatus,
  } = trpc.googleDrive.checkConnection.useQuery(undefined, {
    refetchOnWindowFocus: true,
  });
  const refreshGoogleConnection = useCallback(async () => {
    const result = await refetchDriveStatus();
    return Boolean(result.data?.connected);
  }, [refetchDriveStatus]);
  const {
    connecting: connectingGoogle,
    beginConnection: beginGoogleConnection,
    cancelConnection: cancelGoogleConnection,
  } = useGoogleOAuthConnection({
    connected: Boolean(driveStatus?.connected),
    refreshConnection: refreshGoogleConnection,
  });
  const { data: localFolderData, refetch: refetchLocalFolders } =
    trpc.autoCollection.getLocalFolders.useQuery({ caseId });

  const activePullJob = trpc.autoCollection.activePullJob.useQuery({ caseId }, {
    refetchInterval: (data) => data?.status === "queued" || data?.status === "running" ? 1_000 : false,
  });
  const pullJob = trpc.autoCollection.pullJobStatus.useQuery(
    { jobId: pullJobId || "00000000-0000-0000-0000-000000000000" },
    {
      enabled: Boolean(pullJobId),
      refetchInterval: (data) => !data || data.status === "queued" || data.status === "running" ? 1_000 : false,
    },
  );
  const currentJob = pullJob.data ?? activePullJob.data ?? null;
  const pullActive = currentJob?.status === "queued" || currentJob?.status === "running";

  useEffect(() => {
    if (!pullJobId && activePullJob.data?.id) setPullJobId(activePullJob.data.id);
  }, [activePullJob.data?.id, pullJobId]);

  useEffect(() => {
    if (!currentJob || pullActive || handledJobId === currentJob.id) return;
    setHandledJobId(currentJob.id);
    if (currentJob.status === "failed") {
      toast.error(`Pull failed: ${currentJob.error || "Unknown error"}`);
      return;
    }
    try {
      const result = JSON.parse(currentJob.result || "{}") as {
        gmailMessages?: number;
        gmailAttachments?: number;
        driveFiles?: number;
        localFiles?: number;
        errors?: string[];
      };
      const total = (result.gmailMessages || 0)
        + (result.gmailAttachments || 0)
        + (result.driveFiles || 0)
        + (result.localFiles || 0);
      if (total === 0) {
        toast.message("Pull complete - no new matches", {
          description: result.errors?.length
            ? `Some sources errored: ${result.errors[0]}`
            : "No items matched your keywords. Try different terms or connect a source.",
        });
      } else {
        toast.success(`Pulled ${total} item${total === 1 ? "" : "s"} into the case`, {
          description: `Gmail: ${result.gmailMessages || 0} email(s), ${result.gmailAttachments || 0} attachment(s). Drive: ${result.driveFiles || 0}. Local: ${result.localFiles || 0}.`,
        });
      }
      if (result.errors?.length) console.warn("[KeywordPull] errors:", result.errors);
      void utils.evidenceFiles.search.invalidate({ caseId });
      (utils.autoCollection as any)?.getLogs?.invalidate?.({ caseId });
      (utils.evidenceTimeline as any)?.getTimeline?.invalidate?.({ caseId });
    } catch {
      toast.error("Pull completed but its result could not be read.");
    }
  }, [caseId, currentJob, handledJobId, pullActive, utils]);

  const pullMutation = trpc.autoCollection.startPullByKeywords.useMutation({
    onSuccess: (data) => {
      setHandledJobId(null);
      setPullJobId(data.job.id);
    },
    onError: (err) => {
      toast.error(`Pull failed: ${err.message}`);
    },
  });

  const addFolderMutation = trpc.autoCollection.setLocalFolders.useMutation({
    onSuccess: () => {
      toast.success("Local folder added");
      setNewFolderPath("");
      setShowFolderInput(false);
      refetchLocalFolders();
    },
    onError: (err) => toast.error(`Failed to add folder: ${err.message}`),
  });

  const connectMutation = trpc.googleDrive.connect.useMutation({
    onSuccess: (data) => {
      if (data?.authUrl) {
        beginGoogleConnection(data.authUrl);
      } else {
        toast.error("No auth URL returned");
      }
    },
    onError: (err) => toast.error(`Could not start Google sign-in: ${err.message}`),
  });

  const currentLocalFolders = localFolderData?.paths || [];

  // Read the user-level default folders that Settings → Local Computer
  // Scanner adds. We merge them with per-case folders so a folder added in
  // Settings is included in every keyword pull without re-typing the path.
  const readDefaultFolders = (): string[] => {
    try {
      const raw = localStorage.getItem("laroDefaultLocalScanFolders");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  const handlePull = () => {
    const keywords = keywordsRaw
      .split(/[,\n]/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (keywords.length === 0) {
      toast.error("Enter at least one keyword (comma-separated for multiple).");
      return;
    }
    const defaultFolders = readDefaultFolders();
    const localFolderPaths = Array.from(
      new Set([...defaultFolders, ...currentLocalFolders]),
    );
    pullMutation.mutate({
      caseId,
      keywords,
      matchMode,
      // Send the union so the server scans both case-level and user-default folders.
      localFolderPaths: localFolderPaths.length > 0 ? localFolderPaths : undefined,
      dateStart: dateStart ? new Date(dateStart) : undefined,
      dateEnd: dateEnd ? new Date(dateEnd) : undefined,
    });
  };

  const handleAddFolder = () => {
    const p = newFolderPath.trim();
    if (!p) return;
    const next = Array.from(new Set([...currentLocalFolders, p]));
    addFolderMutation.mutate({ caseId, paths: next });
  };

  const handleChooseFolder = async () => {
    if (!isElectron()) {
      setShowFolderInput(true);
      return;
    }
    try {
      const selected = await getElectronAPI().selectFolder();
      if (!selected?.length) return;
      addFolderMutation.mutate({
        caseId,
        paths: Array.from(new Set([...currentLocalFolders, ...selected])),
      });
    } catch (error) {
      toast.error(`Could not select folder: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleRemoveFolder = (p: string) => {
    const next = currentLocalFolders.filter((x) => x !== p);
    addFolderMutation.mutate({ caseId, paths: next });
  };

  const handleConnectDrive = () => {
    connectMutation.mutate();
  };

  const progressValue = currentJob
    ? currentJob.status === "completed" || currentJob.status === "completed_with_errors"
      ? 100
      : currentJob.totalItems > 0
        ? Math.min(99, Math.round((currentJob.processedItems / currentJob.totalItems) * 100))
        : currentJob.totalWords > 0
          ? Math.min(99, Math.round((currentJob.processedWords / currentJob.totalWords) * 100))
          : currentJob.status === "running"
            ? 5
            : 0
    : 0;

  return (
    <Card className="border-purple-500/30 bg-gradient-to-br from-purple-500/5 to-pink-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="w-5 h-5 text-purple-400" />
          Pull evidence by keyword
        </CardTitle>
        <CardDescription>
          Type one or more keywords and LARO will autonomously pull matching
          emails, Drive files, and local files into this case.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="keyword-pull">Keywords (comma-separated)</Label>
          <div className="flex gap-2">
            <Input
              id="keyword-pull"
              placeholder="contract, invoice, NDA…"
              value={keywordsRaw}
              onChange={(e) => setKeywordsRaw(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !pullMutation.isLoading && !pullActive) handlePull();
              }}
              className="bg-background"
              disabled={pullActive}
            />
            <Button
              onClick={handlePull}
              disabled={pullMutation.isLoading || pullActive}
              className="bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
            >
              {pullMutation.isLoading || pullActive ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Pulling…
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  Pull now
                </>
              )}
            </Button>
          </div>
        </div>

        {currentJob && (
          <div className="space-y-2 rounded-md border border-border/50 bg-background/60 p-3" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">{currentJob.message}</span>
              <span className="tabular-nums text-muted-foreground">{progressValue}%</span>
            </div>
            <Progress aria-label="Document analysis progress" value={progressValue} className="h-2" />
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {currentJob.processedWords.toLocaleString()} words analyzed
              </span>
              <span className="tabular-nums">
                {currentJob.processedItems} / {currentJob.totalItems} items
              </span>
              <span className="tabular-nums">
                {pullActive
                  ? currentJob.estimatedSecondsRemaining == null
                    ? "Estimating time remaining"
                    : `${currentJob.estimatedSecondsRemaining}s remaining`
                  : currentJob.status === "failed"
                    ? "Stopped"
                    : "Complete"}
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-border/40">
          {/* Gmail / Drive */}
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Gmail & Drive
            </div>
            {driveStatusError ? (
              <Button size="sm" variant="outline" onClick={() => void refetchDriveStatus()}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Google status unavailable - retry
              </Button>
            ) : driveStatus?.connected ? (
              <Badge variant="outline" className="border-green-500/40 text-green-400">
                <CheckCircle2 className="w-3 h-3 mr-1" /> Connected
              </Badge>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleConnectDrive}
                  disabled={connectingGoogle || connectMutation.isPending}
                >
                  {(connectingGoogle || connectMutation.isPending) ? (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ExternalLink className="mr-2 h-3.5 w-3.5" />
                  )}
                  {connectingGoogle ? "Finishing Google connection..." : "Connect Google"}
                </Button>
                {connectingGoogle ? (
                  <Button size="sm" variant="ghost" onClick={cancelGoogleConnection}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            )}
          </div>

          {/* Local folders */}
          <div className="space-y-1 sm:col-span-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Local folders to scan
            </div>
            <div className="flex flex-wrap gap-1.5">
              {currentLocalFolders.map((p) => (
                <Badge
                  key={p}
                  variant="secondary"
                  className="gap-1 max-w-[280px]"
                  title={p}
                >
                  <Folder className="w-3 h-3 shrink-0" />
                  <span className="truncate">{p}</span>
                  <button
                    onClick={() => handleRemoveFolder(p)}
                    className="ml-1 hover:text-destructive"
                    aria-label={`Remove ${p}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
              {currentLocalFolders.length === 0 && !showFolderInput && (
                <span className="text-xs text-muted-foreground">None configured</span>
              )}
              {showFolderInput ? (
                <div className="flex w-full gap-1.5">
                  <Input
                    placeholder="/Users/me/Scans"
                    value={newFolderPath}
                    onChange={(e) => setNewFolderPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddFolder();
                      if (e.key === "Escape") {
                        setShowFolderInput(false);
                        setNewFolderPath("");
                      }
                    }}
                    className="h-8 text-xs"
                    autoFocus
                  />
                  <Button size="sm" onClick={handleAddFolder}>
                    Add
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleChooseFolder()}
                  className="h-7 px-2"
                >
                  <FolderPlus className="w-3 h-3 mr-1" /> Add folder
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="pt-3 border-t border-border/40">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronRight
              className={`w-3 h-3 transition-transform ${showAdvanced ? "rotate-90" : ""}`}
            />
            Advanced options
          </button>
          {showAdvanced && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Match mode</Label>
                <select
                  value={matchMode}
                  onChange={(e) => setMatchMode(e.target.value as "all" | "any")}
                  className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="any">Match ANY keyword</option>
                  <option value="all">Match ALL keywords</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={dateStart}
                  onChange={(e) => setDateStart(e.target.value)}
                  className="h-9 bg-background"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To</Label>
                <Input
                  type="date"
                  value={dateEnd}
                  onChange={(e) => setDateEnd(e.target.value)}
                  className="h-9 bg-background"
                />
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── nav items ─── */
const NAV_ITEMS = [
  { id: "overview", label: "Overview", icon: Briefcase },
  { id: "status", label: "Status", icon: Activity },
  { id: "progress", label: "Progress", icon: TrendingUp },
  { id: "messages", label: "Messages", icon: MessageSquare },
  { id: "evidence", label: "Evidence", icon: FileText },
  { id: "analysis", label: "Analysis", icon: Sparkles },
  { id: "evidence-timeline", label: "Timeline", icon: GitBranch },
  { id: "gap-analysis", label: "Gap Analysis", icon: Shield },
  { id: "matching", label: "Lawyers", icon: Users },
  { id: "outreach", label: "Outreach", icon: Send },
  { id: "outreach-analytics", label: "Analytics", icon: BarChart3 },
] as const;

/* ─── Outreach progress wrapper ─── */
function OutreachProgressVisualization({ caseId }: { caseId: string }) {
  const { data, isLoading } = trpc.cases.outreachProgress.useQuery({ caseId });
  if (isLoading) return <Skeleton className="h-32 w-full rounded-xl" />;
  if (!data || data.legalAreas.length === 0) return null;
  return (
    <MultiAreaOutreachProgress
      caseId={caseId}
      legalAreas={data.legalAreas as any}
      overallStats={data.overallStats as any}
    />
  );
}

/* ═══════════════════════════════════════════════════ */
export default function EnhancedCaseDetailsDialog({
  caseId,
  open,
  onOpenChange,
}: EnhancedCaseDetailsDialogProps) {
  const [selectedDistance, setSelectedDistance] = useState(50);
  const [matchLocation, setMatchLocation] = useState("");
  const [requireSpecializationAssociation, setRequireSpecializationAssociation] = useState(false);
  const [requiresFinancedLegalAid, setRequiresFinancedLegalAid] = useState(false);
  const [appliedMatchFilters, setAppliedMatchFilters] = useState({
    maxDistance: 50,
    location: "",
    requireSpecializationAssociation: false,
    requiresFinancedLegalAid: false,
  });
  const [isEditing, setIsEditing] = useState(false);
  const [editedCase, setEditedCase] = useState<any>(null);

  const [activeTab, setActiveTab] = useState(() => {
    const saved = localStorage.getItem(`case-tab-${caseId}`);
    return saved === "timeline" ? "evidence-timeline" : saved || "overview";
  });

  useEffect(() => {
    const saved = localStorage.getItem(`case-tab-${caseId}`);
    setActiveTab(saved === "timeline" ? "evidence-timeline" : saved || "overview");
    localStorage.setItem("active-case-context-id", caseId);
  }, [caseId]);

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    localStorage.setItem(`case-tab-${caseId}`, value);
    localStorage.setItem("active-case-context-id", caseId);
  };

  /* ── queries ── */
  const { data: caseData, isLoading: caseLoading, refetch: refetchCase } =
    trpc.cases.byId.useQuery(caseId, { enabled: open && !!caseId });

  const { data: officialMatches, isLoading: matchingLoading, refetch: refetchMatches } =
    trpc.matching.findOfficialLawyers.useQuery(
      {
        caseId,
        maxDistance: appliedMatchFilters.maxDistance,
        maxResults: 10,
        location: appliedMatchFilters.location || undefined,
        requireSpecializationAssociation: appliedMatchFilters.requireSpecializationAssociation,
        requiresFinancedLegalAid: appliedMatchFilters.requiresFinancedLegalAid,
      },
      {
        enabled: open && !!caseId,
        staleTime: 10 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: false,
      }
    );
  const matchedLawyers = officialMatches?.lawyers;
  const directoryReport = officialMatches?.directory;

  const handleOfficialDirectorySearch = () => {
    const nextFilters = {
      maxDistance: selectedDistance,
      location: matchLocation.trim(),
      requireSpecializationAssociation,
      requiresFinancedLegalAid,
    };
    if (JSON.stringify(nextFilters) === JSON.stringify(appliedMatchFilters)) {
      void refetchMatches();
      return;
    }
    setAppliedMatchFilters(nextFilters);
  };

  const { data: outreachHistory, refetch: refetchOutreach } = trpc.outreach.byCaseId.useQuery(caseId, {
    enabled: open && !!caseId,
  });
  const workflowPreferences = trpc.userPreferences.workflow.useQuery(undefined, { enabled: open });

  /* ── mutations ── */
  const initiateOutreachMutation = trpc.workflow.initiateOutreach.useMutation({
    onSuccess: (result) => {
      toast.success(result.created ? `${result.created} outreach draft(s) prepared for review` : "Outreach is up to date");
      refetchMatches(); refetchCase(); refetchOutreach();
    },
    onError: (error) => { toast.error(`Failed to initiate outreach: ${error.message}`); },
  });

  const approveDraftMutation = trpc.workflow.approveDraft.useMutation({
    onSuccess: () => { toast.success("Draft approved; nothing has been sent yet"); refetchOutreach(); },
    onError: (error) => toast.error(error.message),
  });
  const approveDraftsMutation = trpc.workflow.approveDrafts.useMutation({
    onSuccess: (result) => { toast.success(`${result.approved} drafts approved; nothing has been sent yet`); refetchOutreach(); },
    onError: (error) => toast.error(error.message),
  });
  const rejectDraftMutation = trpc.workflow.rejectDraft.useMutation({
    onSuccess: () => { toast.success("Draft rejected"); refetchOutreach(); },
    onError: (error) => toast.error(error.message),
  });
  const sendApprovedMutation = trpc.workflow.sendApproved.useMutation({
    onSuccess: () => { toast.success("Outreach sent"); refetchOutreach(); },
    onError: (error) => toast.error(error.message),
  });
  const recordResponseMutation = trpc.workflow.recordResponse.useMutation({
    onSuccess: (result) => { toast.success(`Response recorded: ${result.status}`); refetchOutreach(); refetchCase(); },
    onError: (error) => toast.error(error.message),
  });

  const updateCaseMutation = trpc.cases.update.useMutation({
    onSuccess: () => { toast.success("Case updated successfully!"); setIsEditing(false); setEditedCase(null); refetchCase(); },
    onError: (error) => { toast.error(`Failed to update case: ${error.message}`); },
  });

  const handleInitiateOutreach = () => { if (caseId) initiateOutreachMutation.mutate({ caseId }); };
  const handleEdit = () => { setEditedCase(caseData); setIsEditing(true); };
  const handleCancelEdit = () => { setIsEditing(false); setEditedCase(null); };
  const handleSaveEdit = () => {
    if (!editedCase || !caseId) return;
    updateCaseMutation.mutate({ id: caseId, caseSummary: editedCase.caseSummary, urgency: editedCase.urgency });
  };
  const handleSendApproved = (outreach: any) => {
    const recipient = outreach.lawyerEmail || outreach.lawyerName || "this lawyer";
    if (window.confirm(`Send the approved outreach to ${recipient}? This external action cannot be recalled.`)) {
      sendApprovedMutation.mutate({ outreachId: outreach.id });
    }
  };
  const handleRecordResponse = (outreachId: string, response: "Interested" | "Declined") => {
    const notes = window.prompt("Optional response summary")?.trim() || undefined;
    recordResponseMutation.mutate({ outreachId, response, notes });
  };
  const pendingOutreachIds = (outreachHistory ?? [])
    .filter((outreach: any) => outreach.status === "PendingApproval")
    .map((outreach: any) => outreach.id);

  if (!open) return null;

  /* ── urgency colors ── */
  const urgencyClass = (u: string | null | undefined) =>
    u === "High" ? "border-red-500/50 text-red-400" :
    u === "Medium" ? "border-orange-500/50 text-orange-400" :
    "border-emerald-500/50 text-emerald-400";

  const statusClass = (s: string | null | undefined) =>
    s === "Matched" ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" :
    s === "Outreach" ? "bg-blue-500/15 text-blue-400 border-blue-500/30" :
    "bg-orange-500/15 text-orange-400 border-orange-500/30";

  /* ── parse legal areas helper ── */
  const parseLegalAreas = (c: any): string[] => {
    if (!c?.legalAreas) return [];
    try {
      const raw = typeof c.legalAreas === "string" ? JSON.parse(c.legalAreas) : c.legalAreas;
      return Array.isArray(raw) ? raw.map((a: any) => (typeof a === "string" ? a : a?.area || a?.areaEn || "")) : [];
    } catch { return []; }
  };

  /* ═══════════════════════ RENDER ═══════════════════════ */
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="h-[94vh] w-[calc(100vw-1rem)] max-w-[1400px] overflow-hidden border-border/40 bg-background p-0 shadow-2xl shadow-black/40 sm:h-[88vh] sm:max-w-[92vw]"
      >
        {/* ─── top header bar ─── */}
        <div className="flex items-center justify-between border-b border-border/40 bg-gradient-to-r from-background via-card to-background px-3 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/15 ring-1 ring-orange-500/30 sm:h-10 sm:w-10 sm:rounded-xl">
              <Briefcase className="h-5 w-5 text-orange-500" />
            </div>
            <div className="min-w-0">
              <DialogHeader className="p-0 space-y-0">
                <DialogTitle className="text-lg font-semibold text-foreground truncate">
                  {caseLoading ? "Loading…" : caseData?.caseType || "Case Details"}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground truncate">
                  {caseLoading ? "" : caseData?.clientName} · Created {caseData?.createdAt ? new Date(caseData.createdAt).toLocaleDateString() : ""}
                </DialogDescription>
              </DialogHeader>
            </div>
            {caseData && (
              <div className="ml-2 hidden items-center gap-2 lg:flex">
                <Badge variant="outline" className={`text-[11px] ${statusClass(caseData.status)}`}>
                  {caseData.status}
                </Badge>
                <Badge variant="outline" className={`text-[11px] ${urgencyClass(caseData.urgency)}`}>
                  {caseData.urgency}
                </Badge>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <Button onClick={() => exportCaseSummary(caseData)} variant="ghost" size="sm" title="Export case" aria-label="Export case" className="h-8 w-8 px-0 text-xs text-muted-foreground hover:text-foreground sm:w-auto sm:px-2.5">
              <Download className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Export</span>
            </Button>
            <Button onClick={() => printCaseSummary(caseData)} variant="ghost" size="sm" title="Print case" aria-label="Print case" className="h-8 w-8 px-0 text-xs text-muted-foreground hover:text-foreground sm:w-auto sm:px-2.5">
              <Printer className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Print</span>
            </Button>
            {!isEditing && (
              <Button onClick={handleEdit} variant="ghost" size="sm" title="Edit case" aria-label="Edit case" className="h-8 w-8 px-0 text-xs text-orange-400 hover:bg-orange-500/10 hover:text-orange-300 sm:w-auto sm:px-2.5">
                <Edit className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">Edit</span>
              </Button>
            )}
            <div className="mx-0.5 h-5 w-px bg-border/60 sm:mx-1" />
            <Button onClick={() => onOpenChange(false)} variant="ghost" size="sm" aria-label="Close case details" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* ─── body: sidebar + content ─── */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* sidebar nav */}
          <nav className="w-full shrink-0 overflow-x-auto border-b border-border/40 bg-card/30 py-2 md:w-[200px] md:overflow-y-auto md:border-b-0 md:border-r md:py-3">
            <div className="flex gap-1 px-2 md:block md:space-y-0.5">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleTabChange(item.id)}
                    className={`
                      group flex w-auto shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-all duration-150 md:w-full md:gap-2.5
                      ${active
                        ? "bg-orange-500/12 text-orange-400 ring-1 ring-orange-500/20"
                        : "text-muted-foreground hover:text-foreground hover:bg-card/60"
                      }
                    `}
                  >
                    <Icon className={`w-4 h-4 shrink-0 transition-colors ${active ? "text-orange-500" : "text-muted-foreground/60 group-hover:text-muted-foreground"}`} />
                    <span className="truncate">{item.label}</span>
                    {active && <ChevronRight className="ml-auto hidden h-3 w-3 text-orange-500/60 md:block" />}
                  </button>
                );
              })}
            </div>
          </nav>

          {/* main content area */}
          <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {caseLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-8 w-48 rounded-lg" />
                <Skeleton className="h-40 w-full rounded-xl" />
                <Skeleton className="h-64 w-full rounded-xl" />
              </div>
            ) : !caseData ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <XCircle className="w-12 h-12 text-muted-foreground/40 mb-4" />
                <p className="text-muted-foreground">Case not found</p>
              </div>
            ) : (
              <>
                {/* ═══ OVERVIEW ═══ */}
                {activeTab === "overview" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Briefcase className="w-5 h-5 text-orange-500" /> Case Overview
                    </h2>

                    {isEditing ? (
                      <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
                        <CardContent className="pt-6 space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">Client Name</Label>
                              <Input value={editedCase?.clientName || ""} onChange={(e) => setEditedCase({ ...editedCase, clientName: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">Email</Label>
                              <Input type="email" value={editedCase?.clientEmail || ""} onChange={(e) => setEditedCase({ ...editedCase, clientEmail: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">Phone</Label>
                              <Input value={editedCase?.clientPhone || ""} onChange={(e) => setEditedCase({ ...editedCase, clientPhone: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">Case Type</Label>
                              <Input value={editedCase?.caseType || ""} onChange={(e) => setEditedCase({ ...editedCase, caseType: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">Priority</Label>
                              <select
                                value={editedCase?.urgency || "Medium"}
                                onChange={(e) => setEditedCase({ ...editedCase, urgency: e.target.value })}
                                className="w-full h-9 px-3 bg-background border border-input rounded-md text-sm"
                              >
                                <option value="Low">Low</option>
                                <option value="Medium">Medium</option>
                                <option value="High">High</option>
                              </select>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">Case Summary</Label>
                            <Textarea value={editedCase?.caseSummary || ""} onChange={(e) => setEditedCase({ ...editedCase, caseSummary: e.target.value })} rows={5} />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">Legal Areas</Label>
                            <LegalAreasSelect
                              value={editedCase?.legalAreas ? JSON.parse(editedCase.legalAreas as string) : []}
                              onChange={(areas) => setEditedCase({ ...editedCase, legalAreas: JSON.stringify(areas) })}
                            />
                            <p className="text-[11px] text-muted-foreground/70">Adjust the legal areas if the AI classification needs correction</p>
                          </div>
                          <div className="flex gap-2 pt-2">
                            <Button onClick={handleSaveEdit} size="sm" className="bg-orange-500 hover:bg-orange-600 text-white">
                              <Save className="w-3.5 h-3.5 mr-1.5" /> Save Changes
                            </Button>
                            <Button onClick={handleCancelEdit} size="sm" variant="outline" className="border-border/60">
                              <X className="w-3.5 h-3.5 mr-1.5" /> Cancel
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ) : (
                      <>
                        {/* info grid */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          {[
                            { label: "Client Name", value: caseData.clientName, icon: <Briefcase className="w-3.5 h-3.5" /> },
                            { label: "Email", value: caseData.clientEmail, icon: <Mail className="w-3.5 h-3.5" /> },
                            { label: "Phone", value: caseData.clientPhone || "—", icon: <Phone className="w-3.5 h-3.5" /> },
                            { label: "Address", value: caseData.clientAddress || "No address provided", icon: <MapPin className="w-3.5 h-3.5" /> },
                          ].map((item, i) => (
                            <div key={i} className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                              <div className="flex items-center gap-1.5 mb-1.5">
                                <span className="text-muted-foreground/50">{item.icon}</span>
                                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{item.label}</span>
                              </div>
                              <p className="text-sm font-medium text-foreground truncate" title={item.value ?? ""}>{item.value ?? "—"}</p>
                            </div>
                          ))}
                        </div>

                        {/* case type + status + priority + created */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <div className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Case Type</span>
                            <p className="text-sm font-medium text-foreground mt-1">{caseData.caseType}</p>
                          </div>
                          <div className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Status</span>
                            <div className="mt-1.5">
                              <Badge variant="outline" className={`text-xs ${statusClass(caseData.status)}`}>{caseData.status}</Badge>
                            </div>
                          </div>
                          <div className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Priority</span>
                            <div className="mt-1.5">
                              <Badge variant="outline" className={`text-xs ${urgencyClass(caseData.urgency)}`}>{caseData.urgency}</Badge>
                            </div>
                          </div>
                          <div className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Calendar className="w-3.5 h-3.5 text-muted-foreground/50" />
                              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Created</span>
                            </div>
                            <p className="text-sm font-medium text-foreground">{caseData.createdAt ? new Date(caseData.createdAt).toLocaleDateString() : "N/A"}</p>
                          </div>
                        </div>

                        {/* summary */}
                        <div className="rounded-xl border border-border/30 bg-card/40 p-4">
                          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Case Summary</span>
                          <p className="text-sm text-foreground/80 mt-2 leading-relaxed">{caseData.caseSummary}</p>
                        </div>

                        {/* legal areas */}
                        <div className="rounded-xl border border-border/30 bg-card/40 p-4">
                          <div className="flex items-center gap-2 mb-3">
                            <Scale className="w-4 h-4 text-muted-foreground/50" />
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Legal Areas</span>
                            {parseLegalAreas(caseData).length > 0 && (
                              <span className="text-[10px] text-muted-foreground/50 ml-1">(AI-detected, editable)</span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {parseLegalAreas(caseData).length > 0 ? (
                              parseLegalAreas(caseData).map((area, i) => (
                                <Badge key={i} variant="secondary" className="bg-purple-500/10 text-purple-300 border border-purple-500/25 text-xs">
                                  {area}
                                </Badge>
                              ))
                            ) : (
                              <p className="text-sm text-muted-foreground/60 italic">No legal areas assigned yet</p>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ═══ STATUS ═══ */}
                {activeTab === "status" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Activity className="w-5 h-5 text-orange-500" /> Case Status
                    </h2>
                    <CaseStatusWorkflow
                      currentStatus={caseData.status || "Matching"}
                      onStatusChange={(newStatus) => {
                        updateCaseMutation.mutate(
                          { id: caseId, status: newStatus as any },
                          {
                            onSuccess: () => { toast.success("Case status updated"); refetchCase(); },
                            onError: () => { toast.error("Failed to update status"); },
                          }
                        );
                      }}
                      canEdit={true}
                    />
                  </div>
                )}

                {/* ═══ PROGRESS ═══ */}
                {activeTab === "progress" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-orange-500" /> Progress Tracking
                    </h2>
                    <ProgressTrackingDashboard caseId={caseId} onNavigateTab={handleTabChange} />
                  </div>
                )}

                {/* ═══ MESSAGES ═══ */}
                {activeTab === "messages" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <MessageSquare className="w-5 h-5 text-orange-500" /> Messages
                    </h2>
                    <CommunicationHub caseId={caseId} />
                  </div>
                )}

                {/* ═══ EVIDENCE ═══ */}
                {activeTab === "evidence" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <FileText className="w-5 h-5 text-orange-500" /> Evidence Management
                    </h2>
                    <KeywordEvidencePull caseId={caseId} />
                    <Tabs defaultValue="upload" className="w-full">
                      <TabsList className="w-full justify-start gap-1 h-auto bg-card/40 border border-border/30 rounded-xl p-1">
                        <TabsTrigger value="upload" className="text-xs rounded-lg">Upload</TabsTrigger>
                        <TabsTrigger value="google-drive" className="text-xs rounded-lg">Google Drive</TabsTrigger>
                        <TabsTrigger value="monitoring" className="text-xs rounded-lg">Monitoring</TabsTrigger>
                      </TabsList>
                      <TabsContent value="upload" className="mt-4 space-y-4">
                        <EnhancedEvidenceUpload caseId={caseId} />
                        <div className="mt-6">
                          <h3 className="text-base font-semibold mb-4 text-foreground/80">Existing Evidence</h3>
                          <EvidenceCollection caseId={caseId} />
                        </div>
                      </TabsContent>
                      <TabsContent value="google-drive" className="mt-4">
                        <Card className="border-border/30 bg-card/40">
                          <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-base"><CloudDownload className="w-5 h-5" /> Browse Google Drive</CardTitle>
                            <CardDescription>Pick specific Drive files to attach. For keyword-based imports use the panel above.</CardDescription>
                          </CardHeader>
                          <CardContent>
                            <div className="text-center py-8 text-muted-foreground">
                              <p>Connect Google in the "Pull evidence by keyword" panel above, then select files here.</p>
                            </div>
                          </CardContent>
                        </Card>
                      </TabsContent>
                      <TabsContent value="monitoring" className="mt-4">
                        <CollectionMonitoringDashboard caseId={caseId} />
                      </TabsContent>
                    </Tabs>
                  </div>
                )}

                {/* ═══ EVIDENCE TIMELINE ═══ */}
                {activeTab === "analysis" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-orange-500" /> Document Analysis
                    </h2>
                    <AutomatedDocumentAnalysis caseId={caseId} />
                  </div>
                )}

                {activeTab === "evidence-timeline" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <GitBranch className="w-5 h-5 text-orange-500" /> Evidence Timeline
                    </h2>
                      <Tabs defaultValue="reconstruction" className="w-full">
                      <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto border border-border/30 bg-card/40 p-1">
                        <TabsTrigger value="reconstruction" className="text-xs">Document map</TabsTrigger>
                        <TabsTrigger value="events" className="text-xs">Legal events</TabsTrigger>
                        <TabsTrigger value="sources" className="text-xs">Source documents</TabsTrigger>
                        <TabsTrigger value="activity" className="text-xs">Case activity</TabsTrigger>
                      </TabsList>
                      <TabsContent value="reconstruction" className="mt-4">
                        <CaseReconstruction caseId={caseId} />
                      </TabsContent>
                      <TabsContent value="events" className="mt-4">
                        <CaseTimeline caseId={caseId} />
                      </TabsContent>
                      <TabsContent value="sources" className="mt-4">
                        <EvidenceTimelineView caseId={caseId} />
                      </TabsContent>
                      <TabsContent value="activity" className="mt-4">
                        <TimelineView
                          events={[
                            {
                              id: "case-created",
                              date: caseData.createdAt ? new Date(caseData.createdAt) : new Date(),
                              type: "case_created",
                              title: "Case Created",
                              description: `Case for ${caseData.clientName} was created with ${caseData.urgency} priority`,
                              metadata: { urgency: caseData.urgency, caseType: caseData.caseType },
                            },
                            ...(outreachHistory?.map((outreach: any) => ({
                              id: `outreach-${outreach.id}`,
                              date: new Date(outreach.initialContact),
                              type: "lawyer_contacted" as const,
                              title: "Lawyer Contacted",
                              description: `Reached out to ${outreach.lawyerName || "lawyer"}`,
                              metadata: { lawyer: outreach.lawyerName, status: outreach.status, distance: `${outreach.distanceKm} km` },
                            })) || []),
                            ...(outreachHistory?.filter((outreach: any) => outreach.response).map((outreach: any) => ({
                              id: `response-${outreach.id}`,
                              date: outreach.lastContact ? new Date(outreach.lastContact) : new Date(outreach.initialContact),
                              type: "response_received" as const,
                              title: "Response Received",
                              description: outreach.response || "Lawyer responded to outreach",
                              metadata: { lawyer: outreach.lawyerName },
                            })) || []),
                          ]}
                        />
                      </TabsContent>
                    </Tabs>
                  </div>
                )}

                {/* ═══ GAP ANALYSIS ═══ */}
                {activeTab === "gap-analysis" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Shield className="w-5 h-5 text-orange-500" /> Gap Analysis
                    </h2>
                    <EvidenceGapAnalysisDashboard caseId={caseId} />
                  </div>
                )}

                {/* ═══ MATCHING ═══ */}
                {activeTab === "matching" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Users className="w-5 h-5 text-orange-500" /> Lawyer Matching
                    </h2>

                    {/* Official directory controls */}
                    <div className="space-y-4 rounded-xl border border-border/30 bg-card/40 p-4">
                      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)_auto] md:items-end">
                      <div>
                        <label className="text-xs font-medium text-muted-foreground block mb-2">
                          Search Radius: <span className="text-orange-400 font-semibold">{selectedDistance} km</span>
                        </label>
                        <input
                          type="range" min="10" max="200" step="10"
                          value={selectedDistance}
                          onChange={(e) => setSelectedDistance(parseInt(e.target.value))}
                          className="w-full accent-orange-500"
                        />
                      </div>
                      <div>
                        <Label htmlFor="nova-match-location" className="mb-2 block text-xs text-muted-foreground">
                          City or postcode
                        </Label>
                        <Input
                          id="nova-match-location"
                          value={matchLocation}
                          onChange={(event) => setMatchLocation(event.target.value)}
                          placeholder="Optional; shared only when you search"
                        />
                      </div>
                      <Button
                        onClick={handleOfficialDirectorySearch}
                        disabled={matchingLoading}
                        variant="outline"
                        size="sm"
                        className="border-border/50 hover:bg-card/60"
                      >
                        <Target className="w-3.5 h-3.5 mr-1.5" /> {matchingLoading ? "Searching..." : "Search NOvA"}
                      </Button>
                      </div>
                      <div className="flex flex-wrap gap-x-5 gap-y-3 text-xs text-muted-foreground">
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={requireSpecializationAssociation}
                            onCheckedChange={(checked) => setRequireSpecializationAssociation(checked === true)}
                          />
                          Require specialization association
                        </label>
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={requiresFinancedLegalAid}
                            onCheckedChange={(checked) => setRequiresFinancedLegalAid(checked === true)}
                          />
                          Accepts financed legal aid
                        </label>
                      </div>
                      {directoryReport && (
                        <div className="flex flex-wrap items-center gap-2 border-t border-border/30 pt-3 text-xs text-muted-foreground">
                          {directoryReport.status === "unavailable" ? (
                            <AlertTriangle className="h-4 w-4 text-amber-500" />
                          ) : (
                            <Database className="h-4 w-4 text-emerald-500" />
                          )}
                          <span>
                            {directoryReport.status === "complete" ? "Official directory results loaded" :
                              directoryReport.status === "partial" ? "Official directory window loaded; more results exist" :
                              directoryReport.status === "unavailable" ? "Official directory unavailable; showing persisted records" :
                              "Official directory lookup was not required"}
                          </span>
                          <Badge variant="outline">{directoryReport.fetchedCandidates} fetched</Badge>
                          {directoryReport.reportedTotal !== null && <Badge variant="outline">{directoryReport.reportedTotal} reported</Badge>}
                          {directoryReport.errors[0] && <span className="text-amber-500">{directoryReport.errors[0]}</span>}
                        </div>
                      )}
                    </div>

                    {/* header + outreach button */}
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-muted-foreground">
                        Matched Lawyers <span className="text-foreground">({matchedLawyers?.length || 0})</span>
                      </h3>
                      {matchedLawyers && matchedLawyers.length > 0 && (
                        <Button
                          onClick={handleInitiateOutreach}
                          disabled={initiateOutreachMutation.isPending}
                          size="sm"
                          className="bg-orange-500 hover:bg-orange-600 text-white"
                        >
                          <Send className="w-3.5 h-3.5 mr-1.5" />
                          {initiateOutreachMutation.isPending ? "Initiating…" : "Start Outreach"}
                        </Button>
                      )}
                    </div>

                    {matchingLoading ? (
                      <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}</div>
                    ) : matchedLawyers && matchedLawyers.length > 0 ? (
                      <div className="space-y-3">
                        {matchedLawyers.map((lawyer: any, index: number) => (
                          <div key={lawyer.id} className="rounded-xl border border-border/30 bg-card/40 p-4 transition-colors hover:bg-card/60">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-3 mb-2.5">
                                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-amber-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                                    {index + 1}
                                  </div>
                                  <div className="min-w-0">
                                    <h4 className="font-semibold text-sm text-foreground truncate">{lawyer.name}</h4>
                                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                                      <MapPin className="w-3 h-3" /> {lawyer.distanceKnown ? `${lawyer.distance} km away` : "Distance not available"}
                                    </p>
                                  </div>
                                </div>
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mb-2">
                                  {lawyer.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {lawyer.email}</span>}
                                  {lawyer.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {lawyer.phone}</span>}
                                  {lawyer.officialProfileUrl && (
                                    <a
                                      href={lawyer.officialProfileUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="flex items-center gap-1 text-orange-400 hover:underline"
                                    >
                                      <ExternalLink className="h-3 w-3" /> Official NOvA profile
                                    </a>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {lawyer.legalAreas?.map((area: any, i: number) => (
                                    <Badge key={i} variant="secondary" className="bg-blue-500/10 text-blue-300 border-blue-500/25 text-[11px]">
                                      {typeof area === "string" ? area : area.area || area.areaEn || "Unknown"}
                                    </Badge>
                                  ))}
                                  {lawyer.matchReasons?.map((reason: string, i: number) => (
                                    <Badge key={`r-${i}`} variant="outline" className="text-[11px] border-emerald-500/25 text-emerald-400">
                                      <CheckCircle2 className="w-2.5 h-2.5 mr-1" /> {reason}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                              {/* score */}
                              <div className="text-right shrink-0 min-w-[90px]">
                                <div className="text-2xl font-bold bg-gradient-to-r from-orange-400 to-amber-400 bg-clip-text text-transparent">
                                  {lawyer.matchScore}
                                </div>
                                <p className="text-[10px] text-muted-foreground mb-2">Verified-data score (max 245)</p>
                                <div className="text-[11px] space-y-0.5">
                                  {lawyer.caseLoadScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">Load</span><span className="text-emerald-400">{lawyer.caseLoadScore}/50</span></div>}
                                  {lawyer.responseTimeScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">Response</span><span className="text-blue-400">{lawyer.responseTimeScore}/50</span></div>}
                                  {lawyer.acceptanceRateScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">Accept</span><span className="text-purple-400">{lawyer.acceptanceRateScore}/50</span></div>}
                                  {lawyer.capacityScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">Capacity</span><span className="text-yellow-400">{lawyer.capacityScore}/20</span></div>}
                                  {lawyer.distanceScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">Distance</span><span className="text-cyan-400">{lawyer.distanceScore}/10</span></div>}
                                  {lawyer.experienceScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">Exp.</span><span className="text-orange-400">{lawyer.experienceScore}/10</span></div>}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-border/30 bg-card/40 p-8 text-center">
                        <Search className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                        <p className="text-muted-foreground text-sm">No matching lawyers found within {appliedMatchFilters.maxDistance} km.</p>
                        <p className="text-xs text-muted-foreground/60 mt-1">Try increasing the search radius.</p>
                      </div>
                    )}
                  </div>
                )}

                {/* ═══ OUTREACH ═══ */}
                {activeTab === "outreach" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Send className="w-5 h-5 text-orange-500" /> Outreach History
                    </h2>
                    <OutreachProgressVisualization caseId={caseId} />
                    <Card className="border-border/30 bg-card/40">
                      <CardHeader className="pb-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <MessageSquare className="w-4 h-4 text-muted-foreground/60" /> Lawyer outreach
                          </CardTitle>
                          {workflowPreferences.data?.messageApprovalMode === "batch" && pendingOutreachIds.length > 1 ? (
                            <Button size="sm" variant="outline" disabled={approveDraftsMutation.isPending} onClick={() => approveDraftsMutation.mutate({ outreachIds: pendingOutreachIds })}>
                              {approveDraftsMutation.isPending ? "Approving..." : `Approve ${pendingOutreachIds.length} drafts`}
                            </Button>
                          ) : null}
                        </div>
                      </CardHeader>
                      <CardContent>
                        {outreachHistory && outreachHistory.length > 0 ? (
                          <div className="space-y-3">
                            {outreachHistory.map((outreach: any) => (
                              <div key={outreach.id} className="rounded-lg border border-border/20 bg-background/40 p-3">
                                <div className="flex items-center justify-between mb-2">
                                  <p className="font-medium text-sm">{outreach.lawyerName || "Unknown Lawyer"}</p>
                                  <Badge variant={outreach.status === "Interested" ? "default" : outreach.status === "Declined" ? "destructive" : "secondary"} className="text-[11px]">
                                    {outreach.status}
                                  </Badge>
                                </div>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                  {outreach.distanceKm !== null && outreach.distanceKm !== undefined ? <span>Distance: {outreach.distanceKm} km</span> : null}
                                  {outreach.initialContact ? <span>Contact: {new Date(outreach.initialContact).toLocaleDateString()}</span> : <span>Not sent</span>}
                                  <span>Follow-ups: {outreach.followUpsSent}</span>
                                </div>
                                {outreach.response && (
                                  <p className="text-xs mt-2 bg-background/60 p-2 rounded border border-border/20 text-foreground/70">{outreach.response}</p>
                                )}
                                <div className="mt-3 flex flex-wrap justify-end gap-2">
                                  {outreach.status === "PendingApproval" && (
                                    <>
                                      <Button size="sm" variant="outline" onClick={() => rejectDraftMutation.mutate({ outreachId: outreach.id })}>Reject</Button>
                                      <Button size="sm" onClick={() => approveDraftMutation.mutate({ outreachId: outreach.id })}>Approve</Button>
                                    </>
                                  )}
                                  {outreach.status === "Approved" && (
                                    <Button size="sm" onClick={() => handleSendApproved(outreach)} disabled={sendApprovedMutation.isPending}>Review &amp; send</Button>
                                  )}
                                  {outreach.status === "Sent" && (
                                    <>
                                      <Button size="sm" variant="outline" onClick={() => handleRecordResponse(outreach.id, "Declined")}>Declined</Button>
                                      <Button size="sm" onClick={() => handleRecordResponse(outreach.id, "Interested")}>Interested</Button>
                                    </>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-center text-muted-foreground/60 py-6 text-sm">No outreach history yet.</p>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* ═══ OUTREACH ANALYTICS ═══ */}
                {activeTab === "outreach-analytics" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <BarChart3 className="w-5 h-5 text-orange-500" /> Outreach Analytics
                    </h2>
                    <OutreachAnalyticsView caseId={caseId} />
                  </div>
                )}

              </>
            )}
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
