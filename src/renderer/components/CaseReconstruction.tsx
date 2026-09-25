import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleHelp,
  CalendarDays,
  Columns3,
  FileQuestion,
  Focus,
  GanttChart,
  GitBranch,
  List,
  Loader2,
  Map as MapIcon,
  Minus,
  Plus,
  Rows3,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { TimelineEvents } from "./TimelineEvents";
import { trpc } from "@/lib/trpc";
import { getElectronAPI } from "@/lib/electronApiShim";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { useI18n } from "@/contexts/I18nContext";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { TranslationKey } from "../../../shared/i18n";

type RouteId = "employment" | "termination" | "communication" | "legal" | "financial" | "other";
type Relationship = "attachment_of" | "references" | "responds_to" | "related";

type ReconstructionNode = {
  id: string;
  title: string;
  date: string;
  route: RouteId;
  summary: string;
  actor: string | null;
  documentType: string;
  source: string | null;
  eventCount: number;
  analysisStatus: "complete" | "missing";
  confidence: number | null;
  participants: string[];
  topics: string[];
  actions: Array<{ date: string; title: string; description: string; actor: string | null }>;
};

type ReconstructionEdge = {
  id: string;
  from: string;
  to: string;
  relationship: Relationship;
  evidence: "explicit" | "inferred";
  confidence: number;
  basis: string[];
};

type Reconstruction = {
  schemaVersion: 2;
  nodes: ReconstructionNode[];
  edges: ReconstructionEdge[];
  routes: Array<{ id: RouteId; label: string; documentCount: number; eventCount: number }>;
  phases: Array<{
    id: string;
    label: string;
    startDate: string;
    endDate: string;
    documentIds: string[];
    documentCount: number;
    eventCount: number;
    summary: string;
  }>;
  chains: Array<{
    id: string;
    documentIds: string[];
    edgeIds: string[];
    startDate: string;
    endDate: string;
    explicitLinkCount: number;
    inferredLinkCount: number;
    confidence: number;
  }>;
  keyMoments: Array<{
    documentId: string;
    date: string;
    title: string;
    reason: string;
    verifiedLinkCount: number;
    eventCount: number;
  }>;
  warnings: string[];
};

type CorrectionEvent = {
  date: string;
  title: string;
  description: string;
  actor: string | null;
  category: RouteId;
  evidenceId: string;
};

type CorrectionProposal = {
  id: string;
  status: "pending";
  operation: "add" | "update" | "remove";
  before: (CorrectionEvent & { evidenceTitle?: string }) | null;
  after: CorrectionEvent | null;
  reason: string;
  instruction: string;
  sourceBasis: {
    evidenceId: string;
    evidenceTitle: string;
    fields: Array<{
      field: "date" | "title" | "description" | "actor" | "category" | "removal";
      basis: "evidence" | "owner_instruction";
      citationIds: string[];
      evidenceQuotes: string[];
    }>;
  };
};

const ROUTE_COLORS: Record<RouteId, string> = {
  communication: "#38bdf8",
  legal: "#f97316",
  financial: "#22c55e",
  employment: "#a78bfa",
  termination: "#ef4444",
  other: "#94a3b8",
};

const RELATIONSHIP_KEYS: Record<Relationship, TranslationKey> = {
  attachment_of: "reconstruction.relationship.attachment",
  references: "reconstruction.relationship.reference",
  responds_to: "reconstruction.relationship.response",
  related: "reconstruction.relationship.related",
};

const ROUTE_KEYS: Record<RouteId, TranslationKey> = {
  communication: "reconstruction.route.communication",
  legal: "reconstruction.route.legal",
  financial: "reconstruction.route.financial",
  employment: "reconstruction.route.employment",
  termination: "reconstruction.route.termination",
  other: "reconstruction.route.other",
};

const CORRECTION_OPERATION_KEYS: Record<CorrectionProposal["operation"], TranslationKey> = {
  add: "reconstruction.operation.add",
  update: "reconstruction.operation.update",
  remove: "reconstruction.operation.remove",
};

const CORRECTION_FIELD_KEYS: Record<CorrectionProposal["sourceBasis"]["fields"][number]["field"], TranslationKey> = {
  date: "reconstruction.field.date",
  title: "reconstruction.field.title",
  description: "reconstruction.field.description",
  actor: "reconstruction.field.actor",
  category: "reconstruction.field.category",
  removal: "reconstruction.field.removal",
};

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length - 1).trimEnd()}…`;
}

function formatEvidenceDate(
  value: string,
  formatDate: ReturnType<typeof useI18n>["formatDate"],
  undated: string,
): string {
  if (value === "Undated") return undated;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : formatDate(date, { day: "numeric", month: "short", year: "numeric" });
}

function connectedIds(selectedId: string | null, edges: ReconstructionEdge[]): Set<string> {
  if (!selectedId) return new Set();
  const connected = new Set([selectedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (connected.has(edge.from) && !connected.has(edge.to)) {
        connected.add(edge.to);
        changed = true;
      }
      if (connected.has(edge.to) && !connected.has(edge.from)) {
        connected.add(edge.from);
        changed = true;
      }
    }
  }
  return connected;
}

export function CaseReconstruction({ caseId }: { caseId: string }) {
  const { isConnected } = useWebSocket();
  const { t, formatDate, formatNumber } = useI18n();
  const displayDate = (value: string) => formatEvidenceDate(value, formatDate, t("reconstruction.undated"));
  const [reconstruction, setReconstruction] = useState<Reconstruction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<"horizontal" | "vertical">("horizontal");
  const [view, setView] = useState<"events" | "map" | "list" | "gantt">("events");
  const [showInferred, setShowInferred] = useState(true);
  const [minimumConfidence, setMinimumConfidence] = useState(52);
  const [routeFilter, setRouteFilter] = useState<RouteId | "all">("all");
  const [focusFilter, setFocusFilter] = useState("all");
  const [phaseFilter, setPhaseFilter] = useState("all");
  const [chainFilter, setChainFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [traceSelected, setTraceSelected] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [correctionInstruction, setCorrectionInstruction] = useState("");
  const [correctionMessage, setCorrectionMessage] = useState<string | null>(null);
  const [correctionProposal, setCorrectionProposal] = useState<CorrectionProposal | null>(null);
  const timelineQuery = trpc.documentAnalysis.generateCaseTimeline.useQuery(
    { caseId },
    { refetchInterval: isConnected ? false : 60_000, refetchOnWindowFocus: true },
  );
  const sourceMutation = trpc.evidenceFiles.getDownloadUrl.useMutation();
  const sourceOpenedMutation = trpc.evidenceFiles.recordSourceOpened.useMutation();
  const correctionMutation = trpc.documentAnalysis.correctCaseTimeline.useMutation({
    onSuccess: (result) => {
      setCorrectionProposal(result);
      setCorrectionMessage(t("reconstruction.proposalReady"));
    },
    onError: (error) => {
      setCorrectionProposal(null);
      setCorrectionMessage(null);
      setErrorMessage(error.message);
    },
  });
  const reviewCorrectionMutation = trpc.documentAnalysis.reviewTimelineCorrection.useMutation({
    onSuccess: async (result) => {
      await timelineQuery.refetch();
      setCorrectionProposal(null);
      if (result.decision === "confirmed") {
        setCorrectionInstruction("");
        setCorrectionMessage(t("reconstruction.correctionConfirmed"));
      } else {
        setCorrectionMessage(t("reconstruction.proposalRejected"));
      }
    },
    onError: (error) => {
      setCorrectionMessage(null);
      setErrorMessage(error.message);
    },
  });

  useEffect(() => {
    const next = timelineQuery.data?.reconstruction as Reconstruction | undefined;
    if (!next) return;
    setReconstruction(next);
    const pendingProposal = timelineQuery.data?.pendingCorrectionProposals.at(-1);
    if (pendingProposal) setCorrectionProposal((current) => current ?? pendingProposal);
    setSelectedId((current) => current && next.nodes.some((node) => node.id === current)
      ? current
      : next.nodes[0]?.id ?? null);
  }, [timelineQuery.data]);

  const openSource = async (evidenceId: string) => {
    try {
      setErrorMessage(null);
      const source = await sourceMutation.mutateAsync({ id: evidenceId });
      if (!source.url) throw new Error(source.message || t("reconstruction.sourceUnavailable"));
      await getElectronAPI().openExternal(source.url);
      await sourceOpenedMutation.mutateAsync({ id: evidenceId });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t("reconstruction.sourceOpenFailed"));
    }
  };

  const focusOptions = useMemo(() => {
    if (!reconstruction) return [];
    const counts = new Map<string, { label: string; group: "Participant" | "Topic"; count: number }>();
    for (const node of reconstruction.nodes) {
      for (const participant of node.participants) {
        const id = `participant:${participant}`;
        const current = counts.get(id);
        counts.set(id, { label: participant, group: "Participant", count: (current?.count ?? 0) + 1 });
      }
      for (const topic of node.topics) {
        const id = `topic:${topic}`;
        const current = counts.get(id);
        counts.set(id, { label: topic, group: "Topic", count: (current?.count ?? 0) + 1 });
      }
    }
    return [...counts.entries()]
      .map(([id, option]) => ({ id, ...option }))
      .sort((left, right) => left.group.localeCompare(right.group) || right.count - left.count || left.label.localeCompare(right.label));
  }, [reconstruction]);
  const visibleNodes = useMemo(() => reconstruction?.nodes.filter((node) => {
    if (routeFilter !== "all" && node.route !== routeFilter) return false;
    if (phaseFilter !== "all") {
      const phase = reconstruction.phases?.find((item) => item.id === phaseFilter);
      if (phase && !phase.documentIds.includes(node.id)) return false;
    }
    if (chainFilter !== "all") {
      const chain = reconstruction.chains?.find((item) => item.id === chainFilter);
      if (chain && !chain.documentIds.includes(node.id)) return false;
    }
    if (focusFilter === "all") return true;
    const [kind, ...parts] = focusFilter.split(":");
    const value = parts.join(":");
    return kind === "participant" ? node.participants.includes(value) : node.topics.includes(value);
  }) ?? [], [reconstruction, routeFilter, focusFilter, phaseFilter, chainFilter]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(() => reconstruction?.edges.filter((edge) =>
    visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to) &&
    (showInferred || edge.evidence === "explicit") && edge.confidence * 100 >= minimumConfidence) ?? [],
  [reconstruction, visibleNodeIds, showInferred, minimumConfidence]);
  const visibleKeyMoments = useMemo(() => reconstruction?.keyMoments?.filter((moment) =>
    visibleNodeIds.has(moment.documentId)) ?? [], [reconstruction, visibleNodeIds]);
  const tracedIds = useMemo(() => traceSelected ? connectedIds(selectedId, visibleEdges) : new Set<string>(),
    [traceSelected, selectedId, visibleEdges]);
  const selectedNode = reconstruction?.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEdges = visibleEdges.filter((edge) => edge.from === selectedId || edge.to === selectedId);

  useEffect(() => {
    if (selectedId && !visibleNodeIds.has(selectedId)) setSelectedId(visibleNodes[0]?.id ?? null);
  }, [selectedId, visibleNodeIds, visibleNodes]);

  if (!reconstruction && timelineQuery.isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> {t("reconstruction.loading")}
      </div>
    );
  }

  if (!reconstruction) {
    return (
      <div className="space-y-4">
        {timelineQuery.error ? (
          <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>{t("reconstruction.failed")}</AlertTitle><AlertDescription>{timelineQuery.error.message}</AlertDescription></Alert>
        ) : null}
        <Button onClick={() => void timelineQuery.refetch()} disabled={timelineQuery.isFetching}>
          <RotateCcw className="mr-2 h-4 w-4" /> {t("reconstruction.retry")}
        </Button>
      </div>
    );
  }

  if (!reconstruction.nodes.length) {
    return (
      <div className="border border-dashed border-border p-8 text-center">
        <FileQuestion className="mx-auto h-8 w-8 text-muted-foreground" />
        <h3 className="mt-3 font-medium">{t("reconstruction.empty")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{t("reconstruction.emptyHint")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errorMessage ? (
        <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>{t("reconstruction.actionFailed")}</AlertTitle><AlertDescription>{errorMessage}</AlertDescription></Alert>
      ) : null}



      {view !== "events" ? <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border/60 pb-3">
        <div><div className="text-xs text-muted-foreground">{t("reconstruction.documents")}</div><div className="text-sm font-semibold">{formatNumber(reconstruction.nodes.length)}</div></div>
          <div><div className="text-xs text-muted-foreground">{t("reconstruction.verifiedLinks")}</div><div className="text-sm font-semibold">{formatNumber(reconstruction.edges.filter((edge) => edge.evidence === "explicit").length)}</div></div>
          <div><div className="text-xs text-muted-foreground">{t("reconstruction.suggestedLinks")}</div><div className="text-sm font-semibold">{formatNumber(reconstruction.edges.filter((edge) => edge.evidence === "inferred").length)}</div></div>
      </div> : null}

      <div className="flex flex-wrap items-end gap-3 border-b border-border/60 pb-4">
        <div className="inline-flex rounded-md border border-border bg-background p-1" role="group" aria-label={t("reconstruction.view")}>
          <Button type="button" variant={view === "events" ? "secondary" : "ghost"} size="sm" title={t("reconstruction.chronologicalEvents")} aria-label={t("reconstruction.showEvents")} aria-pressed={view === "events"} onClick={() => setView("events")}><CalendarDays className="mr-2 h-4 w-4" />{t("reconstruction.events")}</Button>
          <Button type="button" variant={view === "map" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title={t("reconstruction.documentMap")} aria-label={t("reconstruction.showMap")} aria-pressed={view === "map"} onClick={() => setView("map")}><MapIcon className="h-4 w-4" /></Button>
          <Button type="button" variant={view === "list" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title={t("reconstruction.documentList")} aria-label={t("reconstruction.showList")} aria-pressed={view === "list"} onClick={() => setView("list")}><List className="h-4 w-4" /></Button>
          <Button type="button" variant={view === "gantt" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title={t("reconstruction.gantt")} aria-label={t("reconstruction.showGantt")} aria-pressed={view === "gantt"} onClick={() => setView("gantt")}><GanttChart className="h-4 w-4" /></Button>
        </div>
        {view === "map" ? (
          <>
            <div className="inline-flex rounded-md border border-border bg-background p-1" role="group" aria-label={t("reconstruction.mapOrientation")}>
              <Button type="button" variant={orientation === "horizontal" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title={t("reconstruction.horizontalMap")} aria-label={t("reconstruction.showHorizontalMap")} aria-pressed={orientation === "horizontal"} onClick={() => setOrientation("horizontal")}><Columns3 className="h-4 w-4" /></Button>
              <Button type="button" variant={orientation === "vertical" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title={t("reconstruction.verticalMap")} aria-label={t("reconstruction.showVerticalMap")} aria-pressed={orientation === "vertical"} onClick={() => setOrientation("vertical")}><Rows3 className="h-4 w-4" /></Button>
            </div>
            <div className="inline-flex rounded-md border border-border bg-background p-1" role="group" aria-label={t("reconstruction.mapZoom")}>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title={t("reconstruction.zoomOut")} aria-label={t("reconstruction.zoomOut")} onClick={() => setZoom((value) => Math.max(0.65, Number((value - 0.15).toFixed(2))))}><Minus className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title={t("reconstruction.resetZoom")} aria-label={t("reconstruction.resetZoom")} onClick={() => setZoom(1)}><Focus className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title={t("reconstruction.zoomIn")} aria-label={t("reconstruction.zoomIn")} onClick={() => setZoom((value) => Math.min(1.6, Number((value + 0.15).toFixed(2))))}><Plus className="h-4 w-4" /></Button>
            </div>
          </>
        ) : null}
<details className="order-2 w-full border-t border-border pt-2">
          <summary className="cursor-pointer py-1 text-sm text-muted-foreground">{t("reconstruction.filters")}</summary>
          <div className="flex flex-wrap items-end gap-4 py-3">
        <label className="min-w-44 text-xs text-muted-foreground">
          {t("reconstruction.route")}
          <select className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" value={routeFilter} onChange={(event) => setRouteFilter(event.target.value as RouteId | "all")}>
            <option value="all">{t("reconstruction.allRoutes")}</option>
            {reconstruction.routes.map((route) => <option key={route.id} value={route.id}>{t(ROUTE_KEYS[route.id])} ({formatNumber(route.documentCount)})</option>)}
          </select>
        </label>
        <label className="min-w-52 text-xs text-muted-foreground">
          {t("reconstruction.focus")}
          <select aria-label={t("reconstruction.focus")} className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" value={focusFilter} onChange={(event) => setFocusFilter(event.target.value)}>
            <option value="all">{t("reconstruction.allFocus")}</option>
            {focusOptions.filter((option) => option.group === "Participant").length ? (
              <optgroup label={t("reconstruction.participants")}>
                {focusOptions.filter((option) => option.group === "Participant").map((option) => <option key={option.id} value={option.id}>{option.label} ({formatNumber(option.count)})</option>)}
              </optgroup>
            ) : null}
            {focusOptions.filter((option) => option.group === "Topic").length ? (
              <optgroup label={t("reconstruction.legalTopics")}>
                {focusOptions.filter((option) => option.group === "Topic").map((option) => <option key={option.id} value={option.id}>{option.label} ({formatNumber(option.count)})</option>)}
              </optgroup>
            ) : null}
          </select>
        </label>
        <label className="min-w-44 text-xs text-muted-foreground">
          {t("reconstruction.minimumConfidence", { value: formatNumber(minimumConfidence) })}
          <input className="mt-2 block w-full accent-primary" type="range" min="50" max="95" step="1" value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))} />
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={showInferred} onCheckedChange={setShowInferred} aria-label={t("reconstruction.showInferred")} /> {t("reconstruction.suggestedLinks")}
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={traceSelected} onCheckedChange={setTraceSelected} aria-label={t("reconstruction.traceSelected")} /> {t("reconstruction.traceSelection")}
        </label>
          </div>
        </details>
        <span className="order-1 ml-auto flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          {timelineQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t(timelineQuery.isFetching ? "reconstruction.updating" : "reconstruction.autoUpdates")}
        </span>
      </div>

      {view !== "events" ? <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label={t("reconstruction.routeLegend")}>
        <span className="w-full">{t("reconstruction.positionHint")}</span>
        {reconstruction.routes.map((route) => (
          <button key={route.id} type="button" aria-pressed={routeFilter === route.id} className={`flex items-center gap-2 rounded-sm px-1 py-1 hover:text-foreground ${routeFilter === route.id ? "bg-muted text-foreground" : ""}`} onClick={() => setRouteFilter((value) => value === route.id ? "all" : route.id)}>
            <span className="h-2.5 w-6 rounded-full" style={{ backgroundColor: ROUTE_COLORS[route.id] }} />
            {t(ROUTE_KEYS[route.id])} ({formatNumber(route.documentCount)})
          </button>
        ))}
        <span className="flex items-center gap-2"><span className="w-6 border-t-2 border-dashed border-slate-500" /> {t("reconstruction.suggestedRelationship")}</span>
      </div> : null}

      {view === "events" && timelineQuery.data ? (
        <TimelineEvents key={caseId} caseId={caseId} data={timelineQuery.data} documentIds={visibleNodeIds} onOpenSource={(id) => void openSource(id)} onUpdated={() => timelineQuery.refetch()} />
      ) : !visibleNodes.length ? (
        <div className="border border-dashed border-border p-8 text-center">
          <Focus className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 font-medium">{t("reconstruction.noFocusMatch")}</h3>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => {
            setRouteFilter("all");
            setFocusFilter("all");
            setPhaseFilter("all");
            setChainFilter("all");
          }}>{t("reconstruction.clearFilters")}</Button>
        </div>
      ) : view === "map" ? (
        <ReconstructionMap
          nodes={visibleNodes}
          edges={visibleEdges}
          routes={reconstruction.routes.filter((route) => routeFilter === "all" || route.id === routeFilter)}
          orientation={orientation}
          zoom={zoom}
          selectedId={selectedId}
          tracedIds={tracedIds}
          traceSelected={traceSelected}
          onSelect={setSelectedId}
          onOpenSource={(id) => void openSource(id)}
        />
      ) : view === "gantt" ? (
        <ReconstructionGantt
          nodes={visibleNodes}
          phases={reconstruction.phases}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onOpenSource={(id) => void openSource(id)}
        />
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {visibleNodes.map((node) => (
            <article key={node.id} className={`grid gap-3 py-4 sm:grid-cols-[9rem_1fr_auto] ${selectedId === node.id ? "bg-muted/30" : ""}`}>
              <div><div className="text-sm font-medium">{displayDate(node.date)}</div><div className="mt-1 text-xs" style={{ color: ROUTE_COLORS[node.route] }}>{t(ROUTE_KEYS[node.route])}</div></div>
              <button type="button" className="min-w-0 text-left" onClick={() => setSelectedId(node.id)}><div className="font-medium">{node.title}</div><p className="mt-1 text-sm leading-6 text-muted-foreground">{node.summary}</p></button>
              <Button type="button" variant="ghost" size="icon" title={t("reconstruction.openSource")} aria-label={t("reconstruction.openSourceNamed", { title: node.title })} onClick={() => void openSource(node.id)}><CircleHelp className="h-4 w-4" /></Button>
            </article>
          ))}
        </div>
      )}

      {view !== "events" && reconstruction.phases?.length ? (
        <details className="border-b border-border py-3">
          <summary className="cursor-pointer text-sm font-medium">{t("reconstruction.storyAndMoments")}</summary>
          <section className="pt-3" aria-labelledby="reconstruction-story-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 id="reconstruction-story-title" className="text-sm font-semibold">{t("reconstruction.story")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t("reconstruction.storyHint")}</p>
            </div>
            <span className="text-xs text-muted-foreground">{t((reconstruction.chains?.length ?? 0) === 1 ? "reconstruction.chainCountOne" : "reconstruction.chainCountMany", { count: formatNumber(reconstruction.chains?.length ?? 0) })}</span>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-3">
            {reconstruction.phases.map((phase) => (
              <button
                key={phase.id}
                type="button"
                className={`border p-3 text-left hover:bg-muted/40 ${phaseFilter === phase.id ? "border-foreground bg-muted/40" : "border-border/70"}`}
                aria-pressed={phaseFilter === phase.id}
                onClick={() => {
                  setRouteFilter("all");
                  setFocusFilter("all");
                  setChainFilter("all");
                  setPhaseFilter((current) => current === phase.id ? "all" : phase.id);
                  setSelectedId(phase.documentIds[0] ?? null);
                  setTraceSelected(false);
                }}
              >
                <span className="block text-xs text-muted-foreground">
                  {displayDate(phase.startDate)}
                  {phase.endDate !== phase.startDate && <> - {displayDate(phase.endDate)}</>}
                </span>
                <span className="mt-1 block text-sm font-medium">{phase.label}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{phase.summary}</span>
              </button>
            ))}
          </div>
          {reconstruction.chains?.length ? (
            <div className="mt-4">
              <h4 className="text-xs font-medium uppercase text-muted-foreground">{t("reconstruction.connectedChains")}</h4>
              <div className="mt-2 grid gap-2 lg:grid-cols-2">
                {reconstruction.chains.map((chain, index) => (
                  <button
                    key={chain.id}
                    type="button"
                    className={`border p-3 text-left hover:bg-muted/40 ${chainFilter === chain.id ? "border-foreground bg-muted/40" : "border-border/70"}`}
                    aria-pressed={chainFilter === chain.id}
                    onClick={() => {
                      setRouteFilter("all");
                      setFocusFilter("all");
                      setPhaseFilter("all");
                      setChainFilter((current) => current === chain.id ? "all" : chain.id);
                      setSelectedId(chain.documentIds[0] ?? null);
                      setTraceSelected(false);
                    }}
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
                      <span>{t(chain.documentIds.length === 1 ? "reconstruction.chainTitleOne" : "reconstruction.chainTitleMany", { index: formatNumber(index + 1), count: formatNumber(chain.documentIds.length) })}</span>
                      <Badge variant="outline">{t("reconstruction.averageConfidence", { value: formatNumber(Math.round(chain.confidence * 100)) })}</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {displayDate(chain.startDate)}
                      {chain.endDate !== chain.startDate && <> - {displayDate(chain.endDate)}</>}
                      {" - "}{t("reconstruction.chainLinks", { verified: formatNumber(chain.explicitLinkCount), suggested: formatNumber(chain.inferredLinkCount) })}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {visibleKeyMoments.length ? (
            <div className="mt-4">
              <h4 className="text-xs font-medium uppercase text-muted-foreground">{t("reconstruction.keyMoments")}</h4>
              <div className="mt-2 flex flex-wrap gap-2">
                {visibleKeyMoments.map((moment) => (
                  <button
                    key={moment.documentId}
                    type="button"
                    className="border border-border/70 px-3 py-2 text-left hover:bg-muted/40"
                    title={moment.reason}
                    onClick={() => {
                      setRouteFilter("all");
                      setFocusFilter("all");
                      setPhaseFilter("all");
                      setChainFilter("all");
                      setSelectedId(moment.documentId);
                    }}
                  >
                    <span className="block text-xs font-medium">{moment.title}</span>
                    <span className="block text-[11px] text-muted-foreground">{displayDate(moment.date)} - {moment.reason}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          </section>
        </details>
      ) : null}


      <details className="border-b border-border py-3">
        <summary className="cursor-pointer text-sm font-medium">{t("reconstruction.advancedCorrection")}</summary>
        <div className="pt-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <label id="timeline-correction-title" htmlFor="timeline-correction" className="text-sm font-medium">{t("reconstruction.proposeCorrection")}</label>
            <Textarea
              id="timeline-correction"
              className="mt-2 min-h-20 resize-y"
              value={correctionInstruction}
              onChange={(event) => setCorrectionInstruction(event.target.value)}
              placeholder={t("reconstruction.correctionPlaceholder")}
            />
          </div>
          <Button
            type="button"
            disabled={correctionInstruction.trim().length < 5 || correctionMutation.isPending || reviewCorrectionMutation.isPending}
            onClick={() => {
              setErrorMessage(null);
              setCorrectionMessage(null);
              setCorrectionProposal(null);
              correctionMutation.mutate({ caseId, instruction: correctionInstruction.trim() });
            }}
          >
            {correctionMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            {t("reconstruction.generateProposal")}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t("reconstruction.correctionGuard")}</p>
        {correctionProposal ? (
          <section className="mt-4 border border-amber-500/50 bg-amber-500/5 p-4" aria-labelledby="correction-review-title">
            <div className="flex flex-wrap items-center gap-2">
              <h4 id="correction-review-title" className="text-sm font-semibold">{t("reconstruction.reviewProposal")}</h4>
              <Badge variant="outline">{t("reconstruction.notApplied")}</Badge>
              <Badge variant="secondary">{t(CORRECTION_OPERATION_KEYS[correctionProposal.operation])}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">{correctionProposal.reason}</p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <div className="border border-border/70 bg-background/70 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">{t("reconstruction.before")}</p>
                {correctionProposal.before ? (
                  <>
                    <p className="mt-1 text-sm font-medium">{correctionProposal.before.date} — {correctionProposal.before.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{correctionProposal.before.description}</p>
                  </>
                ) : <p className="mt-1 text-sm text-muted-foreground">{t("reconstruction.noExistingEvent")}</p>}
              </div>
              <div className="border border-border/70 bg-background/70 p-3">
                <p className="text-xs font-medium uppercase text-muted-foreground">{t("reconstruction.after")}</p>
                {correctionProposal.after ? (
                  <>
                    <p className="mt-1 text-sm font-medium">{correctionProposal.after.date} — {correctionProposal.after.title}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{correctionProposal.after.description}</p>
                  </>
                ) : <p className="mt-1 text-sm font-medium text-destructive">{t("reconstruction.eventRemoved")}</p>}
              </div>
            </div>
            <div className="mt-3 border border-border/70 bg-background/70 p-3">
              <p className="text-xs font-medium uppercase text-muted-foreground">{t("reconstruction.sourceBasis")}</p>
              <p className="mt-1 text-sm font-medium">{correctionProposal.sourceBasis.evidenceTitle}</p>
              <ul className="mt-2 space-y-2 text-xs text-muted-foreground">
                {correctionProposal.sourceBasis.fields.map((support) => (
                  <li key={support.field}>
                    <span className="font-medium text-foreground">{t(CORRECTION_FIELD_KEYS[support.field])}</span>
                    {t("reconstruction.supportLine", {
                      basis: t(support.basis === "evidence" ? "reconstruction.basis.evidence" : "reconstruction.basis.instruction"),
                      quotes: support.evidenceQuotes.join("” / “"),
                    })}
                  </li>
                ))}
              </ul>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={reviewCorrectionMutation.isPending}
                onClick={() => {
                  setErrorMessage(null);
                  reviewCorrectionMutation.mutate({ caseId, proposalId: correctionProposal.id, decision: "confirm" });
                }}
              >
                {reviewCorrectionMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {t("reconstruction.confirmApply")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={reviewCorrectionMutation.isPending}
                onClick={() => {
                  setErrorMessage(null);
                  reviewCorrectionMutation.mutate({ caseId, proposalId: correctionProposal.id, decision: "reject" });
                }}
              >
                {t("reconstruction.rejectProposal")}
              </Button>
            </div>
          </section>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-live="polite">
          <span>{t((timelineQuery.data?.corrections.length || 0) === 1 ? "reconstruction.correctionCountOne" : "reconstruction.correctionCountMany", { count: formatNumber(timelineQuery.data?.corrections.length || 0) })}</span>
          {correctionMessage ? <span className="text-foreground">{correctionMessage}</span> : null}
        </div>
        </div>
      </details>

      {view !== "events" && selectedNode ? (
        <details className="border-t border-border pt-4"><summary className="cursor-pointer text-sm font-medium">{t("reconstruction.selectedDetails")}</summary><section className="pt-3" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: ROUTE_COLORS[selectedNode.route] }} />
                <h3 className="font-semibold">{selectedNode.title}</h3>
                <Badge variant="outline">{displayDate(selectedNode.date)}</Badge>
                {selectedNode.analysisStatus === "missing" ? <Badge variant="destructive">{t("reconstruction.analysisNeeded")}</Badge> : null}
              </div>
              <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">{selectedNode.summary}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{selectedNode.documentType}</span>
                {selectedNode.actor ? <span>{t("reconstruction.actor", { name: selectedNode.actor })}</span> : null}
                <span>{t(selectedNode.eventCount === 1 ? "reconstruction.eventCountOne" : "reconstruction.eventCountMany", { count: formatNumber(selectedNode.eventCount) })}</span>
                {selectedNode.confidence !== null ? <span>{t("reconstruction.analysisConfidence", { value: formatNumber(selectedNode.confidence) })}</span> : null}
              </div>
              {selectedNode.participants.length || selectedNode.topics.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedNode.participants.map((participant) => <Badge key={`participant:${participant}`} variant="secondary">{participant}</Badge>)}
                  {selectedNode.topics.map((topic) => <Badge key={`topic:${topic}`} variant="outline">{topic}</Badge>)}
                </div>
              ) : null}
            </div>
            <Button type="button" variant="outline" size="sm" title={t("reconstruction.openSource")} onClick={() => void openSource(selectedNode.id)}><CircleHelp className="mr-2 h-4 w-4" /> {t("reconstruction.source")}</Button>
          </div>
          {selectedEdges.length ? (
            <div className="mt-4 grid gap-2 lg:grid-cols-2">
              {selectedEdges.map((edge) => {
                const incoming = edge.to === selectedNode.id;
                const other = reconstruction.nodes.find((node) => node.id === (incoming ? edge.from : edge.to));
                return (
                  <button key={edge.id} type="button" className="flex items-start gap-3 border border-border/70 p-3 text-left hover:bg-muted/40" onClick={() => setSelectedId(other?.id ?? null)}>
                    {incoming ? <ArrowDownToLine className="mt-0.5 h-4 w-4 shrink-0" /> : <ArrowUpFromLine className="mt-0.5 h-4 w-4 shrink-0" />}
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{t(RELATIONSHIP_KEYS[edge.relationship])} {other?.title}</span><span className="mt-1 block text-xs text-muted-foreground">{edge.basis.join(" ")}</span></span>
                    <Badge variant={edge.evidence === "explicit" ? "default" : "outline"}>{formatNumber(Math.round(edge.confidence * 100))}%</Badge>
                  </button>
                );
              })}
            </div>
          ) : <p className="mt-3 text-sm text-muted-foreground">{t("reconstruction.noRelationship")}</p>}
          {selectedNode.actions.length ? (
            <div className="mt-4 border-t border-border/60 pt-4">
              <h4 className="text-sm font-medium">{t("reconstruction.datedActions")}</h4>
              <div className="mt-2 grid gap-2 lg:grid-cols-2">
                {selectedNode.actions.map((action, index) => (
                  <div key={`${action.date}:${action.title}:${index}`} className="border-l-2 border-border pl-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{action.title}</span><Badge variant="outline">{displayDate(action.date)}</Badge></div>
                    <p className="mt-1 leading-5 text-muted-foreground">{action.description}</p>
                    {action.actor ? <p className="mt-1 text-xs text-muted-foreground">{t("reconstruction.actor", { name: action.actor })}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section></details>
      ) : null}

      {reconstruction.warnings.length ? <details className="border-b border-border py-3"><summary className="cursor-pointer text-sm text-muted-foreground">{t("reconstruction.interpretationNotes", { count: formatNumber(reconstruction.warnings.length) })}</summary><div className="space-y-2 pt-3">{reconstruction.warnings.map((warning) => (
        <Alert key={warning}><GitBranch className="h-4 w-4" /><AlertTitle>{t("reconstruction.interpretationNote")}</AlertTitle><AlertDescription>{warning}</AlertDescription></Alert>
      ))}</div></details> : null}
    </div>
  );
}

function ReconstructionGantt({
  nodes,
  phases,
  selectedId,
  onSelect,
  onOpenSource,
}: {
  nodes: ReconstructionNode[];
  phases: Reconstruction["phases"];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSource: (id: string) => void;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const displayDate = (value: string) => formatEvidenceDate(value, formatDate, t("reconstruction.undated"));
  const dated = nodes.map((node) => ({ node, time: Date.parse(`${node.date}T00:00:00Z`) }))
    .filter((item) => Number.isFinite(item.time));
  if (!dated.length) return <div className="border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t("reconstruction.noGanttDates")}</div>;
  const min = Math.min(...dated.map((item) => item.time));
  const max = Math.max(...dated.map((item) => item.time));
  const span = Math.max(86_400_000, max - min);
  const left = (time: number) => Math.min(98, Math.max(1, ((time - min) / span) * 96 + 1));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const visiblePhases = phases.filter((phase) => phase.documentIds.some((id) => visibleIds.has(id)));

  return (
    <div className="overflow-x-auto border-y border-border" aria-label={t("reconstruction.ganttLabel")}>
      <div className="min-w-[760px] p-4">
        <div className="mb-3 grid grid-cols-[12rem_1fr] gap-4 text-xs text-muted-foreground">
          <span>{t("reconstruction.documentedPhase")}</span>
          <div className="flex justify-between"><span>{displayDate(new Date(min).toISOString().slice(0, 10))}</span><span>{displayDate(new Date(max).toISOString().slice(0, 10))}</span></div>
        </div>
        <div className="space-y-2">
          {visiblePhases.map((phase) => {
            const phaseNodes = dated.filter((item) => phase.documentIds.includes(item.node.id));
            if (!phaseNodes.length) return null;
            const start = Math.min(...phaseNodes.map((item) => item.time));
            const end = Math.max(...phaseNodes.map((item) => item.time));
            return (
              <div key={phase.id} className="grid min-h-14 grid-cols-[12rem_1fr] items-center gap-4 border-b border-border/50 py-2">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{phase.label}</div><div className="text-xs text-muted-foreground">{t(phaseNodes.length === 1 ? "reconstruction.documentCountOne" : "reconstruction.documentCountMany", { count: formatNumber(phaseNodes.length) })}</div></div>
                <div className="relative h-9 bg-muted/35">
                  <div className="absolute top-3 h-3 bg-orange-500/35" style={{ left: `${left(start)}%`, width: `${Math.max(1.5, left(end) - left(start))}%` }} />
                  {phaseNodes.map(({ node, time }) => (
                    <button
                      key={node.id}
                      type="button"
                      className={`absolute top-2 h-5 w-5 -translate-x-1/2 rounded-full border-2 ${selectedId === node.id ? "border-white ring-2 ring-orange-500" : "border-slate-950"}`}
                      style={{ left: `${left(time)}%`, backgroundColor: ROUTE_COLORS[node.route] }}
                      title={`${displayDate(node.date)} - ${node.title}`}
                      aria-label={t("reconstruction.selectDocument", { title: node.title, date: displayDate(node.date) })}
                      onClick={() => onSelect(node.id)}
                      onDoubleClick={() => onOpenSource(node.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("reconstruction.ganttHint")}</p>
      </div>
    </div>
  );
}

function ReconstructionMap({
  nodes,
  edges,
  routes,
  orientation,
  zoom,
  selectedId,
  tracedIds,
  traceSelected,
  onSelect,
  onOpenSource,
}: {
  nodes: ReconstructionNode[];
  edges: ReconstructionEdge[];
  routes: Array<{ id: RouteId; label: string }>;
  orientation: "horizontal" | "vertical";
  zoom: number;
  selectedId: string | null;
  tracedIds: Set<string>;
  traceSelected: boolean;
  onSelect: (id: string) => void;
  onOpenSource: (id: string) => void;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const displayDate = (value: string) => formatEvidenceDate(value, formatDate, t("reconstruction.undated"));
  const routeIndex = new Map(routes.map((route, index) => [route.id, index]));
  const width = orientation === "horizontal" ? Math.max(760, nodes.length * 270 + 220) : Math.max(360, routes.length * 300 + 40);
  const height = orientation === "horizontal" ? Math.max(300, routes.length * 190 + 100) : Math.max(360, nodes.length * 190 + 110);
  const positions = new Map(nodes.map((node, index) => [node.id, orientation === "horizontal"
    ? { x: 180 + index * 270, y: 90 + (routeIndex.get(node.route) ?? 0) * 190 }
    : { x: 40 + (routeIndex.get(node.route) ?? 0) * 300, y: 95 + index * 190 }]));

  const routeExtents = new Map<RouteId, { min: number; max: number; lane: number }>();
  for (const node of nodes) {
    const point = positions.get(node.id)!;
    const value = orientation === "horizontal" ? point.x : point.y;
    const lane = orientation === "horizontal" ? point.y : point.x;
    const current = routeExtents.get(node.route);
    routeExtents.set(node.route, current
      ? { min: Math.min(current.min, value), max: Math.max(current.max, value), lane }
      : { min: value - 35, max: value + 35, lane });
  }

  return (
    <div className="overflow-auto border-y border-border bg-card/40" style={{ maxHeight: "70vh" }} tabIndex={0} aria-label={t("reconstruction.scrollableMap")}>
      <svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="reconstruction-map-title reconstruction-map-description">
        <title id="reconstruction-map-title">{t("reconstruction.mapTitle")}</title>
        <desc id="reconstruction-map-description">{t("reconstruction.mapDescription")}</desc>
        <defs><marker id="reconstruction-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#cbd5e1" /></marker></defs>
        {routes.map((route) => {
          const extent = routeExtents.get(route.id);
          if (!extent) return null;
          return orientation === "horizontal" ? (
            <g key={route.id}><line x1={extent.min} y1={extent.lane} x2={extent.max} y2={extent.lane} stroke={ROUTE_COLORS[route.id]} strokeWidth="8" strokeLinecap="round" opacity="0.78" /><text x="20" y={extent.lane - 28} fill={ROUTE_COLORS[route.id]} fontSize="12" fontWeight="600">{t(ROUTE_KEYS[route.id])}</text></g>
          ) : (
            <g key={route.id}><line x1={extent.lane} y1={extent.min} x2={extent.lane} y2={extent.max} stroke={ROUTE_COLORS[route.id]} strokeWidth="8" strokeLinecap="round" opacity="0.78" /><text x={extent.lane - 20} y="30" fill={ROUTE_COLORS[route.id]} fontSize="12" fontWeight="600">{t(ROUTE_KEYS[route.id])}</text></g>
          );
        })}
        {edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const mid = orientation === "horizontal" ? (from.x + to.x) / 2 : (from.y + to.y) / 2;
          let path: string;
          if (orientation === "horizontal") {
            path = `M ${from.x} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x} ${to.y}`;
          } else {
            path = `M ${from.x} ${from.y} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${to.y}`;
          }
          const active = !traceSelected || (tracedIds.has(edge.from) && tracedIds.has(edge.to));
          return <path key={edge.id} d={path} fill="none" stroke={edge.evidence === "explicit" ? "#f8fafc" : "#94a3b8"} strokeWidth={edge.evidence === "explicit" ? 2.5 : 2} strokeDasharray={edge.evidence === "inferred" ? "7 6" : undefined} markerEnd="url(#reconstruction-arrow)" opacity={active ? 0.8 : 0.12}><title>{t(RELATIONSHIP_KEYS[edge.relationship])} · {formatNumber(Math.round(edge.confidence * 100))}% · {edge.basis.join(" ")}</title></path>;
        })}
        {nodes.map((node) => {
          const point = positions.get(node.id)!;
          const selected = node.id === selectedId;
          const active = !traceSelected || tracedIds.has(node.id);
          const box = orientation === "horizontal"
            ? { x: point.x - 112, y: point.y + 18 }
            : { x: point.x + 18, y: point.y - 45 };
          return (
            <g key={node.id} opacity={active ? 1 : 0.2}>
              <circle cx={point.x} cy={point.y} r={selected ? 12 : 9} fill="#0f172a" stroke={ROUTE_COLORS[node.route]} strokeWidth={selected ? 5 : 4} />
              <foreignObject x={box.x} y={box.y} width="225" height="146">
                <div className={`flex h-[140px] flex-col justify-between rounded-md border bg-card p-3 text-foreground ${selected ? "border-primary" : "border-border"}`}>
                  <button type="button" className="block w-full text-left" onClick={() => onSelect(node.id)} title={`${node.title}. ${node.summary}`}>
                    <span className="block truncate text-sm font-semibold">{node.title}</span>
                    <span className="mt-1 block h-10 overflow-hidden text-xs leading-5 text-muted-foreground">{truncate(node.summary, 120)}</span>
                  </button>
                  <span className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{displayDate(node.date)}</span>
                    <button type="button" className="grid h-8 w-8 place-items-center rounded-md text-foreground hover:bg-muted" title={t("reconstruction.openSource")} aria-label={t("reconstruction.openSourceNamed", { title: node.title })} onClick={() => onOpenSource(node.id)}><CircleHelp className="h-4 w-4" /></button>
                  </span>
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
