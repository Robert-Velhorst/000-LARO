import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAssistantCaseContext } from '@/components/DashboardLayout';
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
import { exportCaseSummary, printCaseSummary } from "@/lib/export";
import { getElectronAPI, isElectron } from "@/lib/electronApiShim";
import { useAuth } from "@/_core/hooks/useAuth";
import { readDefaultScannerFolders } from "@/lib/scannerDefaultFolders";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useGoogleOAuthConnection } from "@/hooks/useGoogleOAuthConnection";
import { QueryNotice } from "@/components/WorkspaceUi";
import { MATCH_SCORE_MAX } from "../../../shared/lawyerMatching";
import { useI18n } from "@/contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

const EvidenceCollection = lazy(() => import("@/components/EvidenceCollection").then((module) => ({ default: module.EvidenceCollection })));
const TimelineView = lazy(() => import("@/components/TimelineView"));
const CommunicationHub = lazy(() => import("@/components/CommunicationHub"));
const EvidenceTimelineView = lazy(() => import("@/components/EvidenceTimelineView"));
const OutreachAnalyticsView = lazy(() => import("@/components/OutreachAnalyticsView"));
const EvidenceGapAnalysisDashboard = lazy(() => import("@/components/EvidenceGapAnalysisDashboard").then((module) => ({ default: module.EvidenceGapAnalysisDashboard })));
const EnhancedEvidenceUpload = lazy(() => import("@/components/EnhancedEvidenceUpload"));
const CollectionMonitoringDashboard = lazy(() => import("@/components/CollectionMonitoringDashboard").then((module) => ({ default: module.CollectionMonitoringDashboard })));
const ProgressTrackingDashboard = lazy(() => import("@/components/ProgressTrackingDashboard"));
const AutomatedDocumentAnalysis = lazy(() => import("@/components/AutomatedDocumentAnalysis").then((module) => ({ default: module.AutomatedDocumentAnalysis })));
const CaseTimeline = lazy(() => import("@/components/CaseTimeline").then((module) => ({ default: module.CaseTimeline })));
const CaseReconstruction = lazy(() => import("@/components/CaseReconstruction").then((module) => ({ default: module.CaseReconstruction })));
const CaseActionManager = lazy(() => import("@/components/CaseActionManager"));
const CaseStatusWorkflow = lazy(() => import("@/components/CaseStatusWorkflow"));

interface EnhancedCaseDetailsDialogProps {
  caseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PULL_PHASE_KEYS: Record<string, TranslationKey> = {
  discovering: "case.pull.phase.discovering",
  gmail: "case.pull.phase.gmail",
  drive: "case.pull.phase.drive",
  local: "case.pull.phase.local",
  finalizing: "case.pull.phase.finalizing",
};

/**
 * One-shot keyword pull panel — the acceptance-test entry point. User types
 * keywords, clicks Pull, and LARO autonomously fetches matching evidence
 * from every connected source (Gmail, Google Drive, local folders) into the
 * case.
 */
function KeywordEvidencePull({ caseId }: { caseId: string }) {
  const { t, formatNumber } = useI18n();
  const { user } = useAuth();
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
  } = trpc.providerConnections.list.useQuery({ provider: "gmail" }, {
    refetchOnWindowFocus: true,
  });
  const driveConnected = (driveStatus ?? []).some((account) => account.status === "connected");
  const refreshGoogleConnection = useCallback(async () => {
    const result = await refetchDriveStatus();
    return Boolean(result.data?.some((account) => account.status === "connected"));
  }, [refetchDriveStatus]);
  const {
    connecting: connectingGoogle,
    beginConnection: beginGoogleConnection,
    cancelConnection: cancelGoogleConnection,
  } = useGoogleOAuthConnection({
    connected: driveConnected,
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
      toast.error(t("case.pull.failed", { message: currentJob.error || t("auth.genericError") }));
      return;
    }
    if (currentJob.status === "cancelled") {
      toast.message(t("case.pull.cancelled"), {
        description: t(currentJob.processedItems === 1 ? "case.pull.cancelledOne" : "case.pull.cancelledMany", {
          count: currentJob.processedItems,
        }),
      });
      return;
    }
    try {
      const result = JSON.parse(currentJob.result || "{}") as {
        gmailMessages?: number;
        gmailAttachments?: number;
        driveFiles?: number;
        localFiles?: number;
        errors?: string[];
        outcome?: "completed" | "partial" | "cancelled";
      };
      const total = (result.gmailMessages || 0)
        + (result.gmailAttachments || 0)
        + (result.driveFiles || 0)
        + (result.localFiles || 0);
      const limited = result.outcome === "partial" || Boolean(result.errors?.length);
      if (total === 0) {
        toast.message(limited ? t("case.pull.partialTitle") : t("case.pull.noMatches"), {
          description: limited
            ? result.errors?.[0] || t("case.pull.deferred")
            : t("case.pull.noMatchesHint"),
        });
      } else if (limited) {
        toast.warning(t(total === 1 ? "case.pull.partialOne" : "case.pull.partialMany", { count: total }), {
          description: result.errors?.[0] || t("case.pull.deferred"),
        });
      } else {
        toast.success(t(total === 1 ? "case.pull.successOne" : "case.pull.successMany", { count: total }), {
          description: t("case.pull.summary", {
            emails: result.gmailMessages || 0,
            attachments: result.gmailAttachments || 0,
            drive: result.driveFiles || 0,
            local: result.localFiles || 0,
          }),
        });
      }
      if (result.errors?.length) console.warn("[KeywordPull] errors:", result.errors);
      void utils.evidenceFiles.search.invalidate({ caseId });
      void utils.autoCollection.monitoring.invalidate({ caseId, limit: 20 });
      (utils.evidenceTimeline as any)?.getTimeline?.invalidate?.({ caseId });
    } catch {
      toast.error(t("case.pull.resultUnreadable"));
    }
  }, [caseId, currentJob, handledJobId, pullActive, t, utils]);

  const pullMutation = trpc.autoCollection.startPullByKeywords.useMutation({
    onSuccess: (data) => {
      setHandledJobId(null);
      setPullJobId(data.job.id);
    },
    onError: (err) => {
      toast.error(t("case.pull.failed", { message: err.message }));
    },
  });
  const cancelPullMutation = trpc.autoCollection.cancelPullJob.useMutation({
    onSuccess: () => {
      void pullJob.refetch();
      void activePullJob.refetch();
    },
    onError: (error) => toast.error(t("case.pull.cancelFailed", { message: error.message })),
  });

  const addFolderMutation = trpc.autoCollection.setLocalFolders.useMutation({
    onSuccess: () => {
      toast.success(t("case.pull.folderAdded"));
      setNewFolderPath("");
      setShowFolderInput(false);
      refetchLocalFolders();
    },
    onError: (err) => toast.error(t("case.pull.folderAddFailed", { message: err.message })),
  });

  const connectMutation = trpc.providerConnections.begin.useMutation({
    onSuccess: (data) => {
      if (data?.authUrl) {
        beginGoogleConnection(data.authUrl);
      } else {
        toast.error(t("case.pull.authUrlMissing"));
      }
    },
    onError: (err) => toast.error(t("case.pull.googleStartFailed", { message: err.message })),
  });

  const currentLocalFolders = localFolderData?.paths || [];

  // Read the user-level default folders that Settings → Local Computer
  // Scanner adds. We merge them with per-case folders so a folder added in
  // Settings is included in every keyword pull without re-typing the path.
  const handlePull = () => {
    const keywords = keywordsRaw
      .split(/[,\n]/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (keywords.length === 0) {
      toast.error(t("case.pull.keywordRequired"));
      return;
    }
    const defaultFolders = readDefaultScannerFolders(user?.id);
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
      toast.error(t("case.pull.folderSelectFailed", {
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const handleRemoveFolder = (p: string) => {
    const next = currentLocalFolders.filter((x) => x !== p);
    addFolderMutation.mutate({ caseId, paths: next });
  };

  const handleConnectDrive = () => {
    connectMutation.mutate({ provider: "gmail" });
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
  const currentJobMessage = currentJob
    ? currentJob.status === "queued"
      ? t("case.pull.phase.queued")
      : currentJob.status === "running"
        ? t(PULL_PHASE_KEYS[currentJob.phase] ?? "case.pull.phase.discovering")
        : currentJob.status === "failed"
          ? t("case.pull.stopped")
          : currentJob.status === "cancelled"
            ? t("case.pull.cancelledStatus")
            : t("case.pull.complete")
    : "";

  return (
    <Card className="border-purple-500/30 bg-gradient-to-br from-purple-500/5 to-pink-500/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Sparkles className="w-5 h-5 text-purple-400" />
          {t("case.pull.title")}
        </CardTitle>
        <CardDescription>
          {t("case.pull.description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="keyword-pull">{t("case.pull.keywords")}</Label>
          <div className="flex gap-2">
            <Input
              id="keyword-pull"
              placeholder={t("case.pull.placeholder")}
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
                  {t("case.pull.pulling")}
                </>
              ) : (
                <>
                  <Search className="w-4 h-4 mr-2" />
                  {t("case.pull.now")}
                </>
              )}
            </Button>
          </div>
        </div>

        {currentJob && (
          <div className="space-y-2 rounded-md border border-border/50 bg-background/60 p-3" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="font-medium">{currentJobMessage}</span>
              <div className="flex items-center gap-2">
                <span className="tabular-nums text-muted-foreground">{progressValue}%</span>
                {pullActive && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={cancelPullMutation.isLoading}
                    onClick={() => cancelPullMutation.mutate({ jobId: currentJob.id })}
                  >
                    <X className="mr-1 h-3.5 w-3.5" /> {t("common.cancel")}
                  </Button>
                )}
              </div>
            </div>
            <Progress aria-label={t("case.pull.progress")} value={progressValue} className="h-2" />
            <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {t("case.pull.wordsAnalyzed", { count: formatNumber(currentJob.processedWords) })}
              </span>
              <span className="tabular-nums">
                {t("case.pull.itemsProgress", {
                  processed: formatNumber(currentJob.processedItems),
                  total: formatNumber(currentJob.totalItems),
                })}
              </span>
              <span className="tabular-nums">
                {pullActive
                  ? currentJob.estimatedSecondsRemaining == null
                    ? t("case.pull.estimating")
                    : t("case.pull.secondsRemaining", { seconds: currentJob.estimatedSecondsRemaining })
                  : currentJob.status === "failed"
                    ? t("case.pull.stopped")
                    : currentJob.status === "cancelled"
                      ? t("case.pull.cancelledStatus")
                    : t("case.pull.complete")}
              </span>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-border/40">
          {/* Gmail / Drive */}
          <div className="space-y-1">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Gmail &amp; Drive
            </div>
            {driveStatusError ? (
              <Button size="sm" variant="outline" onClick={() => void refetchDriveStatus()}>
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                {t("case.pull.googleStatusUnavailable")}
              </Button>
            ) : driveConnected ? (
              <Badge variant="outline" className="border-green-500/40 text-green-400">
                <CheckCircle2 className="w-3 h-3 mr-1" /> {t("case.pull.connected")}
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
                  {connectingGoogle ? t("case.pull.finishingGoogle") : t("case.pull.connectGoogle")}
                </Button>
                {connectingGoogle ? (
                  <Button size="sm" variant="ghost" onClick={cancelGoogleConnection}>
                    {t("common.cancel")}
                  </Button>
                ) : null}
              </div>
            )}
          </div>

          {/* Local folders */}
          <div className="space-y-1 sm:col-span-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("case.pull.localFolders")}
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
                    aria-label={t("case.pull.removeFolder", { path: p })}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
              {currentLocalFolders.length === 0 && !showFolderInput && (
                <span className="text-xs text-muted-foreground">{t("case.pull.noFolders")}</span>
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
                    {t("case.pull.add")}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleChooseFolder()}
                  className="h-7 px-2"
                >
                  <FolderPlus className="w-3 h-3 mr-1" /> {t("case.pull.addFolder")}
                </Button>
              )}
            </div>
            {currentLocalFolders.length > 0 && (
              <p className="text-xs text-muted-foreground" role="status" data-testid="local-folder-schedule-status">
                {localFolderData?.scheduleActive
                  ? t("case.pull.scheduleActive")
                  : t("case.pull.savedOnly")}
              </p>
            )}
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
            {t("case.pull.advanced")}
          </button>
          {showAdvanced && (
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{t("collection.matchMode.label")}</Label>
                <select
                  value={matchMode}
                  onChange={(e) => setMatchMode(e.target.value as "all" | "any")}
                  className="w-full h-9 rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="any">{t("collection.matchMode.any")}</option>
                  <option value="all">{t("collection.matchMode.all")}</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("collection.dateFrom")}</Label>
                <Input
                  type="date"
                  value={dateStart}
                  onChange={(e) => setDateStart(e.target.value)}
                  className="h-9 bg-background"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t("collection.dateTo")}</Label>
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
  { id: "overview", labelKey: "case.nav.overview", icon: Briefcase },
  { id: "status", labelKey: "case.nav.status", icon: Activity },
  { id: "progress", labelKey: "case.nav.progress", icon: TrendingUp },
  { id: "messages", labelKey: "case.nav.notes", icon: MessageSquare },
  { id: "evidence", labelKey: "case.nav.documents", icon: FileText },
  { id: "analysis", labelKey: "case.nav.analysis", icon: Sparkles },
  { id: "evidence-timeline", labelKey: "case.nav.timeline", icon: GitBranch },
  { id: "gap-analysis", labelKey: "case.nav.gaps", icon: Shield },
  { id: "matching", labelKey: "case.nav.lawyers", icon: Users },
  { id: "outreach", labelKey: "case.nav.outreach", icon: Send },
  { id: "outreach-analytics", labelKey: "case.nav.analytics", icon: BarChart3 },
] as const;

const PRIMARY_CASE_TABS = ["overview", "evidence", "evidence-timeline", "messages", "outreach"];
function savedCaseTab(caseId: string): string {
  try {
    const saved = localStorage.getItem(`case-tab-${caseId}`);
    const value = saved === "timeline" ? "evidence-timeline" : saved;
    return NAV_ITEMS.some((item) => item.id === value) ? value! : "overview";
  } catch {
    return "overview";
  }
}

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
  const { t, formatDate, formatNumber } = useI18n();
  const [selectedDistance, setSelectedDistance] = useState(50);
  const [matchLocation, setMatchLocation] = useState("");
  const [requireSpecializationAssociation, setRequireSpecializationAssociation] = useState(false);
  const [requiresFinancedLegalAid, setRequiresFinancedLegalAid] = useState(false);
  const [searchedCaseId, setSearchedCaseId] = useState<string | null>(null);
  const [appliedMatchFilters, setAppliedMatchFilters] = useState({
    maxDistance: 50,
    location: "",
    requireSpecializationAssociation: false,
    requiresFinancedLegalAid: false,
  });
  const [isEditing, setIsEditing] = useState(false);
  const [editedCase, setEditedCase] = useState<any>(null);
  const [outreachReview, setOutreachReview] = useState<{
    action: "approve" | "approve-batch" | "send";
    entries: any[];
  } | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const utils = trpc.useUtils();
  const assistantCaseContext = useAssistantCaseContext();
  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) assistantCaseContext?.clearCaseView(caseId);
    onOpenChange(nextOpen);
  };

  const [activeTab, setActiveTab] = useState(() => savedCaseTab(caseId));

  useEffect(() => {
    setActiveTab(savedCaseTab(caseId));
    setIsEditing(false);
    setEditedCase(null);
  }, [caseId]);

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    try {
      localStorage.setItem(`case-tab-${caseId}`, value);
    } catch { /* View selection still works when storage is unavailable. */ }
  };

  /* ── queries ── */
  const { data: caseData, isLoading: caseLoading, error: caseError, refetch: refetchCase } =
    trpc.cases.byId.useQuery(caseId, { enabled: open && !!caseId });

  const { data: officialMatches, isFetching: matchingLoading, error: matchingError, refetch: refetchMatches } =
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
        enabled: open && !!caseId && activeTab === "matching" && searchedCaseId === caseId,
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
    if (searchedCaseId === caseId && JSON.stringify(nextFilters) === JSON.stringify(appliedMatchFilters)) {
      void refetchMatches();
      return;
    }
    setSearchedCaseId(caseId);
    setAppliedMatchFilters(nextFilters);
  };

  const { data: outreachHistory, refetch: refetchOutreach } = trpc.outreach.byCaseId.useQuery(caseId, {
    enabled: open && !!caseId,
  });
  const workflowPreferences = trpc.userPreferences.workflow.useQuery(undefined, { enabled: open });

  /* ── mutations ── */
  const initiateOutreachMutation = trpc.workflow.initiateOutreach.useMutation({
    onSuccess: (result) => {
      if (!result.success) {
        toast.error(result.reason || t("case.outreach.noLawyer"));
      } else {
        toast.success(result.created
          ? t("case.outreach.draftsPrepared", { count: result.created })
          : t("case.outreach.upToDate"));
      }
      refetchMatches(); refetchCase(); refetchOutreach();
    },
    onError: (error) => { toast.error(t("case.outreach.initiateFailed", { message: error.message })); },
  });

  const approveDraftMutation = trpc.workflow.approveDraft.useMutation({
    onSuccess: () => { setOutreachReview(null); toast.success(t("case.outreach.draftApproved")); refetchOutreach(); },
    onError: (error) => toast.error(error.message),
  });
  const approveDraftsMutation = trpc.workflow.approveDrafts.useMutation({
    onSuccess: (result) => { setOutreachReview(null); toast.success(t("case.outreach.draftsApproved", { count: result.approved })); refetchOutreach(); },
    onError: (error) => toast.error(error.message),
  });
  const rejectDraftMutation = trpc.workflow.rejectDraft.useMutation({
    onSuccess: () => { toast.success(t("case.outreach.draftRejected")); refetchOutreach(); },
    onError: (error) => toast.error(error.message),
  });
  const sendApprovedMutation = trpc.workflow.sendApproved.useMutation({
    onSuccess: () => { setOutreachReview(null); toast.success(t("case.outreach.sent")); refetchOutreach(); },
    onError: (error) => toast.error(error.message),
  });
  const recordResponseMutation = trpc.workflow.recordResponse.useMutation({
    onSuccess: (result) => { toast.success(t("case.outreach.responseRecorded", { status: result.status })); refetchOutreach(); refetchCase(); },
    onError: (error) => toast.error(error.message),
  });

  const updateCaseMutation = trpc.cases.update.useMutation({
    onSuccess: () => { toast.success(t("case.updated")); setIsEditing(false); setEditedCase(null); refetchCase(); },
    onError: (error) => { toast.error(t("case.updateFailed", { message: error.message })); },
  });

  const handleInitiateOutreach = () => { if (caseId) initiateOutreachMutation.mutate({ caseId }); };
  const handleEdit = () => { if (caseData) { setEditedCase(caseData); setIsEditing(true); handleTabChange("overview"); } };
  const handleCancelEdit = () => { setIsEditing(false); setEditedCase(null); };
  const handleSaveEdit = () => {
    if (!editedCase || !caseId) return;
    updateCaseMutation.mutate({ id: caseId, caseSummary: editedCase.caseSummary, urgency: editedCase.urgency });
  };
  const openOutreachReview = async (
    outreachIds: string[],
    action: "approve" | "approve-batch" | "send",
  ) => {
    setReviewLoading(true);
    try {
      const entries = await Promise.all(outreachIds.map((outreachId) =>
        utils.workflow.preSendReview.fetch({ outreachId })
      ));
      setOutreachReview({ action, entries });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("case.outreach.reviewLoadFailed"));
    } finally {
      setReviewLoading(false);
    }
  };
  const confirmOutreachReview = () => {
    if (!outreachReview) return;
    const outreachIds = outreachReview.entries.map((entry) => entry.outreachId);
    if (outreachReview.action === "approve") {
      approveDraftMutation.mutate({
        outreachId: outreachIds[0],
        approvalHash: outreachReview.entries[0].message.approvalHash,
      });
    } else if (outreachReview.action === "approve-batch") {
      approveDraftsMutation.mutate({
        approvals: outreachReview.entries.map((entry) => ({
          outreachId: entry.outreachId,
          approvalHash: entry.message.approvalHash,
        })),
      });
    } else {
      sendApprovedMutation.mutate({ outreachId: outreachIds[0] });
    }
  };
  const handleRecordResponse = (outreachId: string, response: "Interested" | "Declined") => {
    const notes = window.prompt(t("case.outreach.responseSummary"))?.trim() || undefined;
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
  const statusLabel = (status: string | null | undefined) => {
    const key = status && ({
      Intake: "case.status.Intake",
      Matching: "case.status.Matching",
      Outreach: "case.status.Outreach",
      Matched: "case.status.Matched",
      Closed: "case.status.Closed",
    } as const)[status as "Intake" | "Matching" | "Outreach" | "Matched" | "Closed"];
    return key ? t(key) : status || "-";
  };
  const urgencyLabel = (urgency: string | null | undefined) => {
    const key = urgency && ({
      High: "case.urgency.High",
      Medium: "case.urgency.Medium",
      Low: "case.urgency.Low",
    } as const)[urgency as "High" | "Medium" | "Low"];
    return key ? t(key) : urgency || "-";
  };
  const outreachStatusLabel = (status: string | null | undefined) => {
    const key = status && ({
      PendingApproval: "case.outreach.status.pending",
      Approved: "case.outreach.status.approved",
      Rejected: "case.outreach.status.rejected",
      Dispatching: "case.outreach.status.dispatching",
      Sent: "case.outreach.status.sent",
      Interested: "case.outreach.status.interested",
      Declined: "case.outreach.status.declined",
    } as const)[status as "PendingApproval" | "Approved" | "Rejected" | "Dispatching" | "Sent" | "Interested" | "Declined"];
    return key ? t(key) : status || "-";
  };

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
    <>
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[94dvh] w-[calc(100vw-1rem)] max-w-[1400px] flex-col gap-0 overflow-hidden border-border bg-background p-0 sm:h-[90dvh] sm:max-w-[92vw]"
      >
        {/* ─── top header bar ─── */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <div className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10 sm:flex">
              <Briefcase className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <DialogHeader className="p-0 space-y-0">
                <DialogTitle className="break-words text-base font-semibold text-foreground">
                  {caseLoading ? t("case.details.loading") : caseData?.clientName || t("case.details.title")}
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  {caseData?.caseType || t("case.details.workspace")}
                </DialogDescription>
              </DialogHeader>
            </div>
            {caseData && (
              <div className="ml-2 hidden items-center gap-2 lg:flex">
                <Badge variant="outline" className={`text-[11px] ${statusClass(caseData.status)}`}>
                  {statusLabel(caseData.status)}
                </Badge>
                <Badge variant="outline" className={`text-[11px] ${urgencyClass(caseData.urgency)}`}>
                  {urgencyLabel(caseData.urgency)}
                </Badge>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1 sm:gap-1.5">
            <Button disabled={!caseData || !!caseError || !assistantCaseContext} onClick={() => assistantCaseContext?.selectFromCaseView(caseId)} variant="ghost" size="sm" aria-label={t("case.details.askAssistant")} className="h-8 w-8 px-0 text-xs text-primary sm:w-auto sm:px-2.5">
              <MessageSquare className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">{t("case.details.askAssistantShort")}</span>
            </Button>
            <Button disabled={!caseData || !!caseError} onClick={() => exportCaseSummary(caseData)} variant="ghost" size="sm" title={t("case.details.export")} aria-label={t("case.details.export")} className="h-8 w-8 px-0 text-xs text-muted-foreground hover:text-foreground sm:w-auto sm:px-2.5">
              <Download className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">{t("case.details.exportShort")}</span>
            </Button>
            <Button disabled={!caseData || !!caseError} onClick={() => printCaseSummary(caseData)} variant="ghost" size="sm" title={t("case.details.print")} aria-label={t("case.details.print")} className="h-8 w-8 px-0 text-xs text-muted-foreground hover:text-foreground sm:w-auto sm:px-2.5">
              <Printer className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">{t("case.details.printShort")}</span>
            </Button>
            {!isEditing && (
              <Button disabled={!caseData || !!caseError} onClick={handleEdit} variant="ghost" size="sm" title={t("case.details.edit")} aria-label={t("case.details.edit")} className="h-8 w-8 px-0 text-xs text-primary sm:w-auto sm:px-2.5">
                <Edit className="h-3.5 w-3.5 sm:mr-1.5" /> <span className="hidden sm:inline">{t("case.details.editShort")}</span>
              </Button>
            )}
            <div className="mx-0.5 h-5 w-px bg-border/60 sm:mx-1" />
            <Button onClick={() => handleDialogOpenChange(false)} variant="ghost" size="sm" aria-label={t("case.details.close")} className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* ─── body: sidebar + content ─── */}
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* sidebar nav */}
          <nav aria-label={t("case.details.sections")} className="shrink-0 border-b border-border bg-card/30 p-3 md:w-[190px] md:overflow-y-auto md:border-b-0 md:border-r">
            <label className="block text-sm md:hidden"><span className="sr-only">{t("case.details.section")}</span>
              <select aria-label={t("case.details.section")} value={activeTab} onChange={(event) => handleTabChange(event.target.value)} className="h-10 w-full rounded-md border border-input bg-background px-3">
                {NAV_ITEMS.map((item) => <option key={item.id} value={item.id}>{t(item.labelKey)}</option>)}
              </select>
            </label>
            <div className="hidden space-y-1 md:block">
              {PRIMARY_CASE_TABS.map((id) => {
                const item = NAV_ITEMS.find((entry) => entry.id === id)!;
                const Icon = item.icon;
                return <button key={id} type="button" aria-current={activeTab === id ? "page" : undefined} onClick={() => handleTabChange(id)}
                  className={`flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${activeTab === id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                  <Icon className="h-4 w-4 shrink-0" />{t(item.labelKey)}
                </button>;
              })}
              <details className="border-t border-border pt-3" open={PRIMARY_CASE_TABS.includes(activeTab) ? undefined : true}>
                <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">{t("case.details.more")}</summary>
                <div className="mt-1 space-y-1">
                  {NAV_ITEMS.filter((item) => !PRIMARY_CASE_TABS.includes(item.id)).map((item) => <button key={item.id} type="button"
                    aria-current={activeTab === item.id ? "page" : undefined} onClick={() => handleTabChange(item.id)}
                    className={`flex min-h-10 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${activeTab === item.id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}>
                    <item.icon className="h-4 w-4 shrink-0" />{t(item.labelKey)}
                  </button>)}
                </div>
              </details>
            </div>
          </nav>

          {/* main content area */}
          <section className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6" aria-label={t("case.details.content")}>
            {caseLoading ? (
              <div className="space-y-4">
                <Skeleton className="h-8 w-48 rounded-lg" />
                <Skeleton className="h-40 w-full rounded-xl" />
                <Skeleton className="h-64 w-full rounded-xl" />
              </div>
            ) : caseError ? (
              <QueryNotice error={caseError} retry={refetchCase} />
            ) : !caseData ? (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <XCircle className="w-12 h-12 text-muted-foreground/40 mb-4" />
                <p className="text-muted-foreground">{t("case.details.notFound")}</p>
              </div>
            ) : (
              <>
                {/* ═══ OVERVIEW ═══ */}
                {activeTab === "overview" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Briefcase className="w-5 h-5 text-orange-500" /> {t("case.details.overview")}
                    </h2>
                    <Suspense fallback={<CaseWorkspaceLoading />}><CaseActionManager key={caseId} caseId={caseId} /></Suspense>

                    {isEditing ? (
                      <Card className="border-border/40 bg-card/60 backdrop-blur-sm">
                        <CardContent className="pt-6 space-y-4">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">{t("case.field.clientName")}</Label>
                              <Input value={editedCase?.clientName || ""} onChange={(e) => setEditedCase({ ...editedCase, clientName: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">{t("case.field.email")}</Label>
                              <Input type="email" value={editedCase?.clientEmail || ""} onChange={(e) => setEditedCase({ ...editedCase, clientEmail: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">{t("case.field.phone")}</Label>
                              <Input value={editedCase?.clientPhone || ""} onChange={(e) => setEditedCase({ ...editedCase, clientPhone: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">{t("case.field.type")}</Label>
                              <Input value={editedCase?.caseType || ""} onChange={(e) => setEditedCase({ ...editedCase, caseType: e.target.value })} />
                            </div>
                            <div className="space-y-1.5">
                              <Label className="text-xs text-muted-foreground">{t("case.field.priority")}</Label>
                              <select
                                value={editedCase?.urgency || "Medium"}
                                onChange={(e) => setEditedCase({ ...editedCase, urgency: e.target.value })}
                                className="w-full h-9 px-3 bg-background border border-input rounded-md text-sm"
                              >
                                <option value="Low">{t("case.urgency.Low")}</option>
                                <option value="Medium">{t("case.urgency.Medium")}</option>
                                <option value="High">{t("case.urgency.High")}</option>
                              </select>
                            </div>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{t("case.field.summary")}</Label>
                            <Textarea value={editedCase?.caseSummary || ""} onChange={(e) => setEditedCase({ ...editedCase, caseSummary: e.target.value })} rows={5} />
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs text-muted-foreground">{t("case.field.legalAreas")}</Label>
                            <LegalAreasSelect
                              value={editedCase?.legalAreas ? JSON.parse(editedCase.legalAreas as string) : []}
                              onChange={(areas) => setEditedCase({ ...editedCase, legalAreas: JSON.stringify(areas) })}
                            />
                            <p className="text-[11px] text-muted-foreground/70">{t("case.field.adjustLegalAreas")}</p>
                          </div>
                          <div className="flex gap-2 pt-2">
                            <Button onClick={handleSaveEdit} size="sm" className="bg-orange-500 hover:bg-orange-600 text-white">
                              <Save className="w-3.5 h-3.5 mr-1.5" /> {t("case.field.saveChanges")}
                            </Button>
                            <Button onClick={handleCancelEdit} size="sm" variant="outline" className="border-border/60">
                              <X className="w-3.5 h-3.5 mr-1.5" /> {t("common.cancel")}
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    ) : (
                      <>
                        {/* info grid */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          {[
                            { label: t("case.field.clientName"), value: caseData.clientName, icon: <Briefcase className="w-3.5 h-3.5" /> },
                            { label: t("case.field.email"), value: caseData.clientEmail, icon: <Mail className="w-3.5 h-3.5" /> },
                            { label: t("case.field.phone"), value: caseData.clientPhone || "-", icon: <Phone className="w-3.5 h-3.5" /> },
                            { label: t("case.field.address"), value: caseData.clientAddress || t("case.field.noAddress"), icon: <MapPin className="w-3.5 h-3.5" /> },
                          ].map((item, i) => (
                            <div key={i} className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                              <div className="flex items-center gap-1.5 mb-1.5">
                                <span className="text-muted-foreground/50">{item.icon}</span>
                                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{item.label}</span>
                              </div>
                              <p className="text-sm font-medium text-foreground truncate" title={item.value ?? ""}>{item.value ?? "-"}</p>
                            </div>
                          ))}
                        </div>

                        {/* case type + status + priority + created */}
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                          <div className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t("case.field.type")}</span>
                            <p className="text-sm font-medium text-foreground mt-1">{caseData.caseType}</p>
                          </div>
                          <div className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t("case.field.status")}</span>
                            <div className="mt-1.5">
                              <Badge variant="outline" className={`text-xs ${statusClass(caseData.status)}`}>{statusLabel(caseData.status)}</Badge>
                            </div>
                          </div>
                          <div className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t("case.field.priority")}</span>
                            <div className="mt-1.5">
                              <Badge variant="outline" className={`text-xs ${urgencyClass(caseData.urgency)}`}>{urgencyLabel(caseData.urgency)}</Badge>
                            </div>
                          </div>
                          <div className="rounded-xl border border-border/30 bg-card/40 p-3.5">
                            <div className="flex items-center gap-1.5 mb-1">
                              <Calendar className="w-3.5 h-3.5 text-muted-foreground/50" />
                              <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t("case.field.created")}</span>
                            </div>
                            <p className="text-sm font-medium text-foreground">{caseData.createdAt ? formatDate(caseData.createdAt) : "-"}</p>
                          </div>
                        </div>

                        {/* summary */}
                        <div className="rounded-xl border border-border/30 bg-card/40 p-4">
                          <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t("case.field.summary")}</span>
                          <p className="text-sm text-foreground/80 mt-2 leading-relaxed">{caseData.caseSummary}</p>
                        </div>

                        {/* legal areas */}
                        <div className="rounded-xl border border-border/30 bg-card/40 p-4">
                          <div className="flex items-center gap-2 mb-3">
                            <Scale className="w-4 h-4 text-muted-foreground/50" />
                            <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{t("case.field.legalAreas")}</span>
                            {parseLegalAreas(caseData).length > 0 && (
                              <span className="text-[10px] text-muted-foreground/50 ml-1">{t("case.field.aiDetected")}</span>
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
                              <p className="text-sm text-muted-foreground/60 italic">{t("case.field.noLegalAreas")}</p>
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
                      <Activity className="w-5 h-5 text-orange-500" /> {t("case.status.title")}
                    </h2>
                    <Suspense fallback={<CaseWorkspaceLoading />}>
                      <CaseStatusWorkflow
                        currentStatus={caseData.status || "Matching"}
                        onStatusChange={(newStatus) => {
                          updateCaseMutation.mutate(
                            { id: caseId, status: newStatus as any },
                            {
                              onSuccess: () => { toast.success(t("case.status.updated")); refetchCase(); },
                              onError: () => { toast.error(t("case.status.updateFailed")); },
                            }
                          );
                        }}
                        canEdit={true}
                      />
                    </Suspense>
                  </div>
                )}

                {/* ═══ PROGRESS ═══ */}
                {activeTab === "progress" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <TrendingUp className="w-5 h-5 text-orange-500" /> {t("case.progress.title")}
                    </h2>
                    <Suspense fallback={<CaseWorkspaceLoading />}><ProgressTrackingDashboard caseId={caseId} onNavigateTab={handleTabChange} /></Suspense>
                  </div>
                )}

                {/* ═══ MESSAGES ═══ */}
                {activeTab === "messages" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <MessageSquare className="w-5 h-5 text-orange-500" /> {t("case.messages.title")}
                    </h2>
                    <Suspense fallback={<CaseWorkspaceLoading />}><CommunicationHub caseId={caseId} /></Suspense>
                  </div>
                )}

                {/* ═══ EVIDENCE ═══ */}
                {activeTab === "evidence" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <FileText className="w-5 h-5 text-orange-500" /> {t("case.evidence.title")}
                    </h2>
                    <KeywordEvidencePull caseId={caseId} />
                    <Tabs defaultValue="upload" className="w-full">
                      <TabsList className="w-full justify-start gap-1 h-auto bg-card/40 border border-border/30 rounded-xl p-1">
                        <TabsTrigger value="upload" className="text-xs rounded-lg">{t("case.evidence.upload")}</TabsTrigger>
                        <TabsTrigger value="google-drive" className="text-xs rounded-lg">Google Drive</TabsTrigger>
                        <TabsTrigger value="monitoring" className="text-xs rounded-lg">{t("case.evidence.monitoring")}</TabsTrigger>
                      </TabsList>
                      <TabsContent value="upload" className="mt-4 space-y-4">
                        <Suspense fallback={<CaseWorkspaceLoading />}><EnhancedEvidenceUpload caseId={caseId} /></Suspense>
                        <div className="mt-6">
                          <h3 className="text-base font-semibold mb-4 text-foreground/80">{t("case.evidence.existing")}</h3>
                          <Suspense fallback={<CaseWorkspaceLoading />}><EvidenceCollection caseId={caseId} /></Suspense>
                        </div>
                      </TabsContent>
                      <TabsContent value="google-drive" className="mt-4">
                        <Card className="border-border/30 bg-card/40">
                          <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-base"><CloudDownload className="w-5 h-5" /> {t("case.evidence.browseDrive")}</CardTitle>
                            <CardDescription>{t("case.evidence.browseDriveHint")}</CardDescription>
                          </CardHeader>
                          <CardContent>
                            <div className="text-center py-8 text-muted-foreground">
                              <p>{t("case.evidence.connectDriveHint")}</p>
                            </div>
                          </CardContent>
                        </Card>
                      </TabsContent>
                      <TabsContent value="monitoring" className="mt-4">
                        <Suspense fallback={<CaseWorkspaceLoading />}><CollectionMonitoringDashboard caseId={caseId} /></Suspense>
                      </TabsContent>
                    </Tabs>
                  </div>
                )}

                {/* ═══ EVIDENCE TIMELINE ═══ */}
                {activeTab === "analysis" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-orange-500" /> {t("case.analysis.title")}
                    </h2>
                    <Suspense fallback={<CaseWorkspaceLoading />}><AutomatedDocumentAnalysis caseId={caseId} /></Suspense>
                  </div>
                )}

                {activeTab === "evidence-timeline" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <GitBranch className="w-5 h-5 text-orange-500" /> {t("case.timeline.title")}
                    </h2>
                      <Tabs defaultValue="reconstruction" className="w-full">
                      <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto border border-border/30 bg-card/40 p-1">
                        <TabsTrigger value="reconstruction" className="text-xs">{t("case.timeline.documentMap")}</TabsTrigger>
                        <TabsTrigger value="events" className="text-xs">{t("case.timeline.legalEvents")}</TabsTrigger>
                        <TabsTrigger value="sources" className="text-xs">{t("case.timeline.sources")}</TabsTrigger>
                        <TabsTrigger value="activity" className="text-xs">{t("case.timeline.activity")}</TabsTrigger>
                      </TabsList>
                      <TabsContent value="reconstruction" className="mt-4">
                        <Suspense fallback={<CaseWorkspaceLoading />}><CaseReconstruction caseId={caseId} /></Suspense>
                      </TabsContent>
                      <TabsContent value="events" className="mt-4">
                        <Suspense fallback={<CaseWorkspaceLoading />}><CaseTimeline caseId={caseId} /></Suspense>
                      </TabsContent>
                      <TabsContent value="sources" className="mt-4">
                        <Suspense fallback={<CaseWorkspaceLoading />}><EvidenceTimelineView caseId={caseId} /></Suspense>
                      </TabsContent>
                      <TabsContent value="activity" className="mt-4">
                        <Suspense fallback={<CaseWorkspaceLoading />}>
                          <TimelineView
                            events={[
                            {
                              id: "case-created",
                              date: caseData.createdAt ? new Date(caseData.createdAt) : new Date(),
                              type: "case_created",
                              title: t("case.timeline.createdTitle"),
                              description: t("case.timeline.createdDescription", {
                                client: caseData.clientName || caseId,
                                priority: urgencyLabel(caseData.urgency),
                              }),
                              metadata: { urgency: caseData.urgency, caseType: caseData.caseType },
                            },
                            ...(outreachHistory?.map((outreach: any) => ({
                              id: `outreach-${outreach.id}`,
                              date: new Date(outreach.initialContact),
                              type: "lawyer_contacted" as const,
                              title: t("case.timeline.lawyerContacted"),
                              description: t("case.timeline.reachedOut", {
                                lawyer: outreach.lawyerName || t("case.outreach.unknownLawyer"),
                              }),
                              metadata: { lawyer: outreach.lawyerName, status: outreach.status, distance: `${outreach.distanceKm} km` },
                            })) || []),
                            ...(outreachHistory?.filter((outreach: any) => outreach.response).map((outreach: any) => ({
                              id: `response-${outreach.id}`,
                              date: outreach.lastContact ? new Date(outreach.lastContact) : new Date(outreach.initialContact),
                              type: "response_received" as const,
                              title: t("case.timeline.responseReceived"),
                              description: outreach.response || t("case.timeline.lawyerResponded"),
                              metadata: { lawyer: outreach.lawyerName },
                            })) || []),
                            ]}
                          />
                        </Suspense>
                      </TabsContent>
                    </Tabs>
                  </div>
                )}

                {/* ═══ GAP ANALYSIS ═══ */}
                {activeTab === "gap-analysis" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Shield className="w-5 h-5 text-orange-500" /> {t("case.gaps.title")}
                    </h2>
                    <Suspense fallback={<CaseWorkspaceLoading />}><EvidenceGapAnalysisDashboard caseId={caseId} /></Suspense>
                  </div>
                )}

                {/* ═══ MATCHING ═══ */}
                {activeTab === "matching" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Users className="w-5 h-5 text-orange-500" /> {t("case.match.title")}
                    </h2>

                    {/* Official directory controls */}
                    <div className="space-y-4 rounded-xl border border-border/30 bg-card/40 p-4">
                      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)_auto] md:items-end">
                      <div>
                        <label htmlFor="nova-search-radius" className="text-xs font-medium text-muted-foreground block mb-2">
                          {t("case.match.radius")} <span className="text-orange-400 font-semibold">{formatNumber(selectedDistance)} km</span>
                        </label>
                        <input
                          id="nova-search-radius"
                          type="range" min="10" max="200" step="10"
                          value={selectedDistance}
                          onChange={(e) => setSelectedDistance(parseInt(e.target.value))}
                          className="w-full accent-orange-500"
                        />
                      </div>
                      <div>
                        <Label htmlFor="nova-match-location" className="mb-2 block text-xs text-muted-foreground">
                          {t("case.match.location")}
                        </Label>
                        <Input
                          id="nova-match-location"
                          value={matchLocation}
                          onChange={(event) => setMatchLocation(event.target.value)}
                          placeholder={t("case.match.locationHint")}
                        />
                      </div>
                      <Button
                        onClick={handleOfficialDirectorySearch}
                        disabled={matchingLoading}
                        variant="outline"
                        size="sm"
                        className="border-border/50 hover:bg-card/60"
                      >
                        <Target className="w-3.5 h-3.5 mr-1.5" /> {matchingLoading ? t("case.match.searching") : t("case.match.searchNova")}
                      </Button>
                      </div>
                      <div className="flex flex-wrap gap-x-5 gap-y-3 text-xs text-muted-foreground">
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={requireSpecializationAssociation}
                            onCheckedChange={(checked) => setRequireSpecializationAssociation(checked === true)}
                          />
                          {t("case.match.requireAssociation")}
                        </label>
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={requiresFinancedLegalAid}
                            onCheckedChange={(checked) => setRequiresFinancedLegalAid(checked === true)}
                          />
                          {t("case.match.financedAid")}
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
                            {directoryReport.status === "complete" ? t("case.match.directoryComplete") :
                              directoryReport.status === "partial" ? t("case.match.directoryPartial") :
                              directoryReport.status === "unavailable" ? t("case.match.directoryUnavailable") :
                              t("case.match.directoryNotRequired")}
                          </span>
                          <Badge variant="outline">{t("case.match.fetched", { count: formatNumber(directoryReport.fetchedCandidates) })}</Badge>
                          {directoryReport.reportedTotal !== null && <Badge variant="outline">{t("case.match.reported", { count: formatNumber(directoryReport.reportedTotal) })}</Badge>}
                          {directoryReport.errors[0] && <span className="text-amber-500">{directoryReport.errors[0]}</span>}
                        </div>
                      )}
                    </div>

                    {/* header + outreach button */}
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-medium text-muted-foreground">
                        {t("case.match.matches")} <span className="text-foreground">({formatNumber(matchedLawyers?.length || 0)})</span>
                      </h3>
                      {matchedLawyers && matchedLawyers.length > 0 && (
                        <Button
                          onClick={handleInitiateOutreach}
                          disabled={initiateOutreachMutation.isPending}
                          size="sm"
                          className="bg-orange-700 text-white hover:bg-orange-800"
                        >
                          <Send className="w-3.5 h-3.5 mr-1.5" />
                          {initiateOutreachMutation.isPending ? t("case.match.starting") : t("case.match.startOutreach")}
                        </Button>
                      )}
                    </div>

                    {matchingError ? <p role="alert" className="break-words text-sm text-destructive">{matchingError.message}</p> : searchedCaseId !== caseId ? (
                      <p className="text-sm text-muted-foreground">{t("case.match.notStarted")}</p>
                    ) : matchingLoading ? (
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
                                      <MapPin className="w-3 h-3" /> {lawyer.distanceKnown
                                        ? t("case.match.distanceAway", { distance: formatNumber(lawyer.distance) })
                                        : t("case.match.distanceUnavailable")}
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
                                      <ExternalLink className="h-3 w-3" /> {t("case.match.officialProfile")}
                                    </a>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {lawyer.legalAreas?.map((area: any, i: number) => (
                                    <Badge key={i} variant="secondary" className="bg-blue-500/10 text-blue-300 border-blue-500/25 text-[11px]">
                                      {typeof area === "string" ? area : area.area || area.areaEn || t("case.match.unknown")}
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
                                <p className="text-[10px] text-muted-foreground mb-2">{t("case.match.score", { max: MATCH_SCORE_MAX })}</p>
                                <div className="text-[11px] space-y-0.5">
                                  {lawyer.caseLoadScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">{t("case.match.load")}</span><span className="text-emerald-400">{lawyer.caseLoadScore}/50</span></div>}
                                  {lawyer.responseTimeScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">{t("case.match.response")}</span><span className="text-blue-400">{lawyer.responseTimeScore}/50</span></div>}
                                  {lawyer.acceptanceRateScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">{t("case.match.accept")}</span><span className="text-purple-400">{lawyer.acceptanceRateScore}/50</span></div>}
                                  {lawyer.capacityScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">{t("case.match.capacity")}</span><span className="text-yellow-400">{lawyer.capacityScore}/20</span></div>}
                                  {lawyer.distanceScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">{t("case.match.distance")}</span><span className="text-cyan-400">{lawyer.distanceScore}/10</span></div>}
                                  {lawyer.experienceScore !== undefined && <div className="flex justify-between gap-1"><span className="text-muted-foreground/70">{t("case.match.experience")}</span><span className="text-orange-400">{lawyer.experienceScore}/10</span></div>}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-border/30 bg-card/40 p-8 text-center">
                        <Search className="w-10 h-10 mx-auto mb-3 text-muted-foreground/30" />
                        <p className="text-muted-foreground text-sm">{t("case.match.none", { distance: formatNumber(appliedMatchFilters.maxDistance) })}</p>
                        <p className="text-xs text-muted-foreground/60 mt-1">{t("case.match.increaseRadius")}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* ═══ OUTREACH ═══ */}
                {activeTab === "outreach" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <Send className="w-5 h-5 text-orange-500" /> {t("case.outreach.history")}
                    </h2>
                    <OutreachProgressVisualization caseId={caseId} />
                    <Card className="border-border/30 bg-card/40">
                      <CardHeader className="pb-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <CardTitle className="flex items-center gap-2 text-base">
                            <MessageSquare className="w-4 h-4 text-muted-foreground/60" /> {t("case.outreach.lawyerOutreach")}
                          </CardTitle>
                          {workflowPreferences.data?.messageApprovalMode === "batch" && pendingOutreachIds.length > 1 ? (
                            <Button size="sm" variant="outline" disabled={approveDraftsMutation.isPending || reviewLoading} onClick={() => void openOutreachReview(pendingOutreachIds, "approve-batch")}>
                              {reviewLoading ? t("common.loading") : t("case.outreach.reviewDrafts", { count: pendingOutreachIds.length })}
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
                                  <p className="font-medium text-sm">{outreach.lawyerName || t("case.outreach.unknownLawyer")}</p>
                                  <Badge variant={outreach.status === "Interested" ? "default" : outreach.status === "Declined" ? "destructive" : "secondary"} className="text-[11px]">
                                    {outreachStatusLabel(outreach.status)}
                                  </Badge>
                                </div>
                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                  {outreach.distanceKm !== null && outreach.distanceKm !== undefined ? <span>{t("case.outreach.distance", { distance: formatNumber(outreach.distanceKm) })}</span> : null}
                                  {outreach.initialContact ? <span>{t("case.outreach.contact", { date: formatDate(outreach.initialContact) })}</span> : outreach.status === "Dispatching" ? <span>{t("case.outreach.awaitingDelivery")}</span> : <span>{t("case.outreach.notSent")}</span>}
                                  <span>{t("case.outreach.followUps", { count: outreach.followUpsSent })}</span>
                                </div>
                                {outreach.response && (
                                  <p className="text-xs mt-2 bg-background/60 p-2 rounded border border-border/20 text-foreground/70">{outreach.response}</p>
                                )}
                                <div className="mt-3 flex flex-wrap justify-end gap-2">
                                  {outreach.status === "PendingApproval" && (
                                    <>
                                      <Button size="sm" variant="outline" onClick={() => rejectDraftMutation.mutate({ outreachId: outreach.id })}>{t("case.outreach.reject")}</Button>
                                      <Button size="sm" disabled={reviewLoading} onClick={() => void openOutreachReview([outreach.id], "approve")}>{t("case.outreach.reviewApprove")}</Button>
                                    </>
                                  )}
                                  {outreach.status === "Approved" && (
                                    <Button size="sm" onClick={() => void openOutreachReview([outreach.id], "send")} disabled={sendApprovedMutation.isPending || reviewLoading}>{t("case.outreach.reviewSend")}</Button>
                                  )}
                                  {outreach.status === "Dispatching" && (
                                    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                                      <Loader2 className="h-4 w-4 animate-spin" /> {t("case.outreach.verifying")}
                                    </span>
                                  )}
                                  {outreach.status === "Sent" && (
                                    <>
                                      <Button size="sm" variant="outline" onClick={() => handleRecordResponse(outreach.id, "Declined")}>{t("case.outreach.declined")}</Button>
                                      <Button size="sm" onClick={() => handleRecordResponse(outreach.id, "Interested")}>{t("case.outreach.interested")}</Button>
                                    </>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-center text-muted-foreground/60 py-6 text-sm">{t("case.outreach.none")}</p>
                        )}
                      </CardContent>
                    </Card>
                  </div>
                )}

                {/* ═══ OUTREACH ANALYTICS ═══ */}
                {activeTab === "outreach-analytics" && (
                  <div className="space-y-5 animate-in fade-in-0 duration-200">
                    <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
                      <BarChart3 className="w-5 h-5 text-orange-500" /> {t("case.outreach.analytics")}
                    </h2>
                    <Suspense fallback={<CaseWorkspaceLoading />}><OutreachAnalyticsView caseId={caseId} /></Suspense>
                  </div>
                )}

              </>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(outreachReview)} onOpenChange={(nextOpen) => { if (!nextOpen) setOutreachReview(null); }}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {outreachReview?.action === "send" ? t("case.outreach.confirmEmail") : t("case.outreach.reviewMessage")}
          </DialogTitle>
          <DialogDescription>
            {t("case.outreach.reviewWarning")}
          </DialogDescription>
        </DialogHeader>
        <div className="divide-y divide-border/50">
          {outreachReview?.entries.map((entry) => (
            <section key={entry.outreachId} className="space-y-3 py-4 first:pt-0 last:pb-0">
              <div className="grid gap-3 text-sm sm:grid-cols-[7rem_1fr]">
                <span className="font-medium text-muted-foreground">{t("case.outreach.recipient")}</span>
                <span className="break-all">{entry.message.to}</span>
                <span className="font-medium text-muted-foreground">{t("case.outreach.subject")}</span>
                <span className="break-words">{entry.message.subject}</span>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium text-muted-foreground">{t("case.outreach.message")}</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/50 bg-muted/30 p-3 font-sans text-sm leading-6">
                  {entry.message.text}
                </pre>
              </div>
            </section>
          ))}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 pt-4">
          <Button variant="outline" onClick={() => setOutreachReview(null)}>{t("common.cancel")}</Button>
          <Button
            onClick={confirmOutreachReview}
            disabled={approveDraftMutation.isPending || approveDraftsMutation.isPending || sendApprovedMutation.isPending}
          >
            {outreachReview?.action === "send" ? t("case.outreach.sendEmail") : outreachReview?.action === "approve-batch" ? t("case.outreach.approveBatch") : t("case.outreach.approveMessage")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}

function CaseWorkspaceLoading() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {t("case.workspace.loading")}
    </div>
  );
}
