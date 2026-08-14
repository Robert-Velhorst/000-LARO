import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleHelp,
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
import { trpc } from "@/lib/trpc";
import { getElectronAPI } from "@/lib/electronApiShim";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

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

const ROUTE_COLORS: Record<RouteId, string> = {
  communication: "#38bdf8",
  legal: "#f97316",
  financial: "#22c55e",
  employment: "#a78bfa",
  termination: "#ef4444",
  other: "#94a3b8",
};

const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  attachment_of: "Attachment to",
  references: "Referenced by",
  responds_to: "Responded to by",
  related: "Potentially related to",
};

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;
}

function formatDate(value: string): string {
  if (value === "Undated") return value;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" });
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
  const [reconstruction, setReconstruction] = useState<Reconstruction | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<"horizontal" | "vertical">("horizontal");
  const [view, setView] = useState<"map" | "list" | "gantt">("map");
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
  const timelineQuery = trpc.documentAnalysis.generateCaseTimeline.useQuery(
    { caseId },
    { refetchInterval: isConnected ? false : 60_000, refetchOnWindowFocus: true },
  );
  const sourceMutation = trpc.evidenceFiles.getDownloadUrl.useMutation();
  const sourceOpenedMutation = trpc.evidenceFiles.recordSourceOpened.useMutation();
  const correctionMutation = trpc.documentAnalysis.correctCaseTimeline.useMutation({
    onSuccess: async (result) => {
      setCorrectionInstruction("");
      setCorrectionMessage(`${result.operation === "remove" ? "Removed" : result.operation === "add" ? "Added" : "Updated"} timeline event. ${result.reason}`);
      await timelineQuery.refetch();
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
    setSelectedId((current) => current && next.nodes.some((node) => node.id === current)
      ? current
      : next.nodes[0]?.id ?? null);
  }, [timelineQuery.data]);

  const openSource = async (evidenceId: string) => {
    try {
      setErrorMessage(null);
      const source = await sourceMutation.mutateAsync({ id: evidenceId });
      if (!source.url) throw new Error(source.message || "The source file is not available.");
      await getElectronAPI().openExternal(source.url);
      await sourceOpenedMutation.mutateAsync({ id: evidenceId });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The source file could not be opened.");
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
        <Loader2 className="h-5 w-5 animate-spin" /> Reconstructing the document history…
      </div>
    );
  }

  if (!reconstruction) {
    return (
      <div className="space-y-4">
        {timelineQuery.error ? (
          <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Reconstruction failed</AlertTitle><AlertDescription>{timelineQuery.error.message}</AlertDescription></Alert>
        ) : null}
        <Button onClick={() => void timelineQuery.refetch()} disabled={timelineQuery.isFetching}>
          <RotateCcw className="mr-2 h-4 w-4" /> Retry reconstruction
        </Button>
      </div>
    );
  }

  if (!reconstruction.nodes.length) {
    return (
      <div className="border border-dashed border-border p-8 text-center">
        <FileQuestion className="mx-auto h-8 w-8 text-muted-foreground" />
        <h3 className="mt-3 font-medium">No documents to reconstruct</h3>
        <p className="mt-1 text-sm text-muted-foreground">Pull or upload evidence for this case. It will appear here automatically.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {errorMessage ? (
        <Alert variant="destructive"><AlertCircle className="h-4 w-4" /><AlertTitle>Document action failed</AlertTitle><AlertDescription>{errorMessage}</AlertDescription></Alert>
      ) : null}

      <section className="border-y border-border/60 py-4" aria-labelledby="timeline-correction-title">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <label id="timeline-correction-title" htmlFor="timeline-correction" className="text-sm font-medium">Correct the timeline with AI</label>
            <Textarea
              id="timeline-correction"
              className="mt-2 min-h-20 resize-y"
              value={correctionInstruction}
              onChange={(event) => setCorrectionInstruction(event.target.value)}
              placeholder="For example: change the dismissal meeting to 14 March 2024 and keep the meeting notes as its source."
            />
          </div>
          <Button
            type="button"
            disabled={correctionInstruction.trim().length < 5 || correctionMutation.isPending}
            onClick={() => {
              setErrorMessage(null);
              setCorrectionMessage(null);
              correctionMutation.mutate({ caseId, instruction: correctionInstruction.trim() });
            }}
          >
            {correctionMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
            Apply correction
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-live="polite">
          <span>{timelineQuery.data?.corrections.length || 0} audited correction{timelineQuery.data?.corrections.length === 1 ? "" : "s"}</span>
          {correctionMessage ? <span className="text-foreground">{correctionMessage}</span> : null}
        </div>
      </section>

      <div className="grid gap-3 border-b border-border/60 pb-4 sm:grid-cols-3">
        <div><div className="text-xs text-muted-foreground">Documents</div><div className="text-2xl font-semibold">{reconstruction.nodes.length}</div></div>
        <div><div className="text-xs text-muted-foreground">Verified links</div><div className="text-2xl font-semibold">{reconstruction.edges.filter((edge) => edge.evidence === "explicit").length}</div></div>
        <div><div className="text-xs text-muted-foreground">Suggested links</div><div className="text-2xl font-semibold">{reconstruction.edges.filter((edge) => edge.evidence === "inferred").length}</div></div>
      </div>

      <div className="flex flex-wrap items-end gap-3 border-b border-border/60 pb-4">
        <div className="inline-flex rounded-md border border-border bg-background p-1" role="group" aria-label="Reconstruction view">
          <Button type="button" variant={view === "map" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title="Document map" aria-label="Show document map" aria-pressed={view === "map"} onClick={() => setView("map")}><MapIcon className="h-4 w-4" /></Button>
          <Button type="button" variant={view === "list" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title="Accessible document list" aria-label="Show document list" aria-pressed={view === "list"} onClick={() => setView("list")}><List className="h-4 w-4" /></Button>
          <Button type="button" variant={view === "gantt" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title="Gantt timeline" aria-label="Show Gantt timeline" aria-pressed={view === "gantt"} onClick={() => setView("gantt")}><GanttChart className="h-4 w-4" /></Button>
        </div>
        {view === "map" ? (
          <>
            <div className="inline-flex rounded-md border border-border bg-background p-1" role="group" aria-label="Map orientation">
              <Button type="button" variant={orientation === "horizontal" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title="Horizontal map" aria-label="Show horizontal map" aria-pressed={orientation === "horizontal"} onClick={() => setOrientation("horizontal")}><Columns3 className="h-4 w-4" /></Button>
              <Button type="button" variant={orientation === "vertical" ? "secondary" : "ghost"} size="icon" className="h-8 w-8" title="Vertical map" aria-label="Show vertical map" aria-pressed={orientation === "vertical"} onClick={() => setOrientation("vertical")}><Rows3 className="h-4 w-4" /></Button>
            </div>
            <div className="inline-flex rounded-md border border-border bg-background p-1" role="group" aria-label="Map zoom">
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Zoom out" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.65, Number((value - 0.15).toFixed(2))))}><Minus className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Reset zoom" aria-label="Reset zoom" onClick={() => setZoom(1)}><Focus className="h-4 w-4" /></Button>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8" title="Zoom in" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.6, Number((value + 0.15).toFixed(2))))}><Plus className="h-4 w-4" /></Button>
            </div>
          </>
        ) : null}
        <label className="min-w-44 text-xs text-muted-foreground">
          Route
          <select className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" value={routeFilter} onChange={(event) => setRouteFilter(event.target.value as RouteId | "all")}>
            <option value="all">All routes</option>
            {reconstruction.routes.map((route) => <option key={route.id} value={route.id}>{route.label} ({route.documentCount})</option>)}
          </select>
        </label>
        <label className="min-w-52 text-xs text-muted-foreground">
          Focus
          <select className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" value={focusFilter} onChange={(event) => setFocusFilter(event.target.value)}>
            <option value="all">All participants and topics</option>
            {focusOptions.filter((option) => option.group === "Participant").length ? (
              <optgroup label="Participants">
                {focusOptions.filter((option) => option.group === "Participant").map((option) => <option key={option.id} value={option.id}>{option.label} ({option.count})</option>)}
              </optgroup>
            ) : null}
            {focusOptions.filter((option) => option.group === "Topic").length ? (
              <optgroup label="Legal topics">
                {focusOptions.filter((option) => option.group === "Topic").map((option) => <option key={option.id} value={option.id}>{option.label} ({option.count})</option>)}
              </optgroup>
            ) : null}
          </select>
        </label>
        <label className="min-w-44 text-xs text-muted-foreground">
          Minimum link confidence: {minimumConfidence}%
          <input className="mt-2 block w-full accent-orange-500" type="range" min="50" max="95" step="1" value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))} />
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={showInferred} onCheckedChange={setShowInferred} aria-label="Show inferred links" /> Suggested links
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <Switch checked={traceSelected} onCheckedChange={setTraceSelected} aria-label="Trace selected document chain" /> Trace selection
        </label>
        <span className="ml-auto flex h-9 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          {timelineQuery.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {timelineQuery.isFetching ? "Updating evidence" : "Updates automatically"}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground" aria-label="Route legend">
        {reconstruction.routes.map((route) => (
          <button key={route.id} type="button" className="flex items-center gap-2 hover:text-foreground" onClick={() => setRouteFilter((value) => value === route.id ? "all" : route.id)}>
            <span className="h-2.5 w-6 rounded-full" style={{ backgroundColor: ROUTE_COLORS[route.id] }} />
            {route.label} ({route.documentCount})
          </button>
        ))}
        <span className="flex items-center gap-2"><span className="w-6 border-t-2 border-dashed border-slate-500" /> Suggested relationship</span>
      </div>

      {reconstruction.phases?.length ? (
        <section className="border-y border-border/60 py-4" aria-labelledby="reconstruction-story-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h3 id="reconstruction-story-title" className="text-sm font-semibold">Documented story</h3>
              <p className="mt-1 text-xs text-muted-foreground">Neutral phases derived from document order. Select a phase or key moment to focus the source map.</p>
            </div>
            <span className="text-xs text-muted-foreground">{reconstruction.chains?.length ?? 0} connected chain{reconstruction.chains?.length === 1 ? "" : "s"}</span>
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
                <span className="block text-xs text-muted-foreground">{formatDate(phase.startDate)}{phase.endDate !== phase.startDate ? ` - ${formatDate(phase.endDate)}` : ""}</span>
                <span className="mt-1 block text-sm font-medium">{phase.label}</span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">{phase.summary}</span>
              </button>
            ))}
          </div>
          {reconstruction.chains?.length ? (
            <div className="mt-4">
              <h4 className="text-xs font-medium uppercase text-muted-foreground">Connected document chains</h4>
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
                      <span>Chain {index + 1} - {chain.documentIds.length} documents</span>
                      <Badge variant="outline">{Math.round(chain.confidence * 100)}% average confidence</Badge>
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {formatDate(chain.startDate)}{chain.endDate !== chain.startDate ? ` - ${formatDate(chain.endDate)}` : ""}
                      {" - "}{chain.explicitLinkCount} verified, {chain.inferredLinkCount} suggested
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          {visibleKeyMoments.length ? (
            <div className="mt-4">
              <h4 className="text-xs font-medium uppercase text-muted-foreground">Source-backed key moments</h4>
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
                    <span className="block text-[11px] text-muted-foreground">{formatDate(moment.date)} - {moment.reason}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {!visibleNodes.length ? (
        <div className="border border-dashed border-border p-8 text-center">
          <Focus className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 font-medium">No documents match this focus</h3>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => {
            setRouteFilter("all");
            setFocusFilter("all");
            setPhaseFilter("all");
            setChainFilter("all");
          }}>Clear filters</Button>
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
              <div><div className="text-sm font-medium">{formatDate(node.date)}</div><div className="mt-1 text-xs" style={{ color: ROUTE_COLORS[node.route] }}>{reconstruction.routes.find((route) => route.id === node.route)?.label}</div></div>
              <button type="button" className="min-w-0 text-left" onClick={() => setSelectedId(node.id)}><div className="font-medium">{node.title}</div><p className="mt-1 text-sm leading-6 text-muted-foreground">{node.summary}</p></button>
              <Button type="button" variant="ghost" size="icon" title="Open source document" aria-label={`Open source document ${node.title}`} onClick={() => void openSource(node.id)}><CircleHelp className="h-4 w-4" /></Button>
            </article>
          ))}
        </div>
      )}

      {selectedNode ? (
        <section className="border-t border-border pt-4" aria-live="polite">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="h-3 w-3 rounded-full" style={{ backgroundColor: ROUTE_COLORS[selectedNode.route] }} />
                <h3 className="font-semibold">{selectedNode.title}</h3>
                <Badge variant="outline">{formatDate(selectedNode.date)}</Badge>
                {selectedNode.analysisStatus === "missing" ? <Badge variant="destructive">Analysis needed</Badge> : null}
              </div>
              <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">{selectedNode.summary}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{selectedNode.documentType}</span>
                {selectedNode.actor ? <span>Actor: {selectedNode.actor}</span> : null}
                <span>{selectedNode.eventCount} dated event{selectedNode.eventCount === 1 ? "" : "s"}</span>
                {selectedNode.confidence !== null ? <span>Analysis confidence: {selectedNode.confidence}%</span> : null}
              </div>
              {selectedNode.participants.length || selectedNode.topics.length ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedNode.participants.map((participant) => <Badge key={`participant:${participant}`} variant="secondary">{participant}</Badge>)}
                  {selectedNode.topics.map((topic) => <Badge key={`topic:${topic}`} variant="outline">{topic}</Badge>)}
                </div>
              ) : null}
            </div>
            <Button type="button" variant="outline" size="sm" title="Open source document" onClick={() => void openSource(selectedNode.id)}><CircleHelp className="mr-2 h-4 w-4" /> Source</Button>
          </div>
          {selectedEdges.length ? (
            <div className="mt-4 grid gap-2 lg:grid-cols-2">
              {selectedEdges.map((edge) => {
                const incoming = edge.to === selectedNode.id;
                const other = reconstruction.nodes.find((node) => node.id === (incoming ? edge.from : edge.to));
                return (
                  <button key={edge.id} type="button" className="flex items-start gap-3 border border-border/70 p-3 text-left hover:bg-muted/40" onClick={() => setSelectedId(other?.id ?? null)}>
                    {incoming ? <ArrowDownToLine className="mt-0.5 h-4 w-4 shrink-0" /> : <ArrowUpFromLine className="mt-0.5 h-4 w-4 shrink-0" />}
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{RELATIONSHIP_LABELS[edge.relationship]} {other?.title}</span><span className="mt-1 block text-xs text-muted-foreground">{edge.basis.join(" ")}</span></span>
                    <Badge variant={edge.evidence === "explicit" ? "default" : "outline"}>{Math.round(edge.confidence * 100)}%</Badge>
                  </button>
                );
              })}
            </div>
          ) : <p className="mt-3 text-sm text-muted-foreground">No relationship survives the current filters for this document.</p>}
          {selectedNode.actions.length ? (
            <div className="mt-4 border-t border-border/60 pt-4">
              <h4 className="text-sm font-medium">Dated actions in this document</h4>
              <div className="mt-2 grid gap-2 lg:grid-cols-2">
                {selectedNode.actions.map((action, index) => (
                  <div key={`${action.date}:${action.title}:${index}`} className="border-l-2 border-border pl-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{action.title}</span><Badge variant="outline">{formatDate(action.date)}</Badge></div>
                    <p className="mt-1 leading-5 text-muted-foreground">{action.description}</p>
                    {action.actor ? <p className="mt-1 text-xs text-muted-foreground">Actor: {action.actor}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {reconstruction.warnings.map((warning) => (
        <Alert key={warning}><GitBranch className="h-4 w-4" /><AlertTitle>Interpretation note</AlertTitle><AlertDescription>{warning}</AlertDescription></Alert>
      ))}
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
  const dated = nodes.map((node) => ({ node, time: Date.parse(`${node.date}T00:00:00Z`) }))
    .filter((item) => Number.isFinite(item.time));
  if (!dated.length) return <div className="border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No dated documents are available for a Gantt view.</div>;
  const min = Math.min(...dated.map((item) => item.time));
  const max = Math.max(...dated.map((item) => item.time));
  const span = Math.max(86_400_000, max - min);
  const left = (time: number) => Math.min(98, Math.max(1, ((time - min) / span) * 96 + 1));
  const visibleIds = new Set(nodes.map((node) => node.id));
  const visiblePhases = phases.filter((phase) => phase.documentIds.some((id) => visibleIds.has(id)));

  return (
    <div className="overflow-x-auto border-y border-border" aria-label="Evidence Gantt timeline">
      <div className="min-w-[760px] p-4">
        <div className="mb-3 grid grid-cols-[12rem_1fr] gap-4 text-xs text-muted-foreground">
          <span>Documented phase</span>
          <div className="flex justify-between"><span>{formatDate(new Date(min).toISOString().slice(0, 10))}</span><span>{formatDate(new Date(max).toISOString().slice(0, 10))}</span></div>
        </div>
        <div className="space-y-2">
          {visiblePhases.map((phase) => {
            const phaseNodes = dated.filter((item) => phase.documentIds.includes(item.node.id));
            if (!phaseNodes.length) return null;
            const start = Math.min(...phaseNodes.map((item) => item.time));
            const end = Math.max(...phaseNodes.map((item) => item.time));
            return (
              <div key={phase.id} className="grid min-h-14 grid-cols-[12rem_1fr] items-center gap-4 border-b border-border/50 py-2">
                <div className="min-w-0"><div className="truncate text-sm font-medium">{phase.label}</div><div className="text-xs text-muted-foreground">{phaseNodes.length} document{phaseNodes.length === 1 ? "" : "s"}</div></div>
                <div className="relative h-9 bg-muted/35">
                  <div className="absolute top-3 h-3 bg-orange-500/35" style={{ left: `${left(start)}%`, width: `${Math.max(1.5, left(end) - left(start))}%` }} />
                  {phaseNodes.map(({ node, time }) => (
                    <button
                      key={node.id}
                      type="button"
                      className={`absolute top-2 h-5 w-5 -translate-x-1/2 rounded-full border-2 ${selectedId === node.id ? "border-white ring-2 ring-orange-500" : "border-slate-950"}`}
                      style={{ left: `${left(time)}%`, backgroundColor: ROUTE_COLORS[node.route] }}
                      title={`${formatDate(node.date)} - ${node.title}`}
                      aria-label={`Select ${node.title}, ${formatDate(node.date)}`}
                      onClick={() => onSelect(node.id)}
                      onDoubleClick={() => onOpenSource(node.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Select a station for details. Double-click a station to open its source document.</p>
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
  const routeIndex = new Map(routes.map((route, index) => [route.id, index]));
  const width = orientation === "horizontal" ? Math.max(940, nodes.length * 230 + 220) : Math.max(760, routes.length * 250 + 230);
  const height = orientation === "horizontal" ? Math.max(400, routes.length * 155 + 150) : Math.max(560, nodes.length * 150 + 160);
  const positions = new Map(nodes.map((node, index) => [node.id, orientation === "horizontal"
    ? { x: 150 + index * 230, y: 90 + (routeIndex.get(node.route) ?? 0) * 155 }
    : { x: 145 + (routeIndex.get(node.route) ?? 0) * 250, y: 95 + index * 150 }]));

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
    <div className="overflow-auto border-y border-border bg-slate-950/40" style={{ maxHeight: "70vh" }} tabIndex={0} aria-label="Scrollable document reconstruction map">
      <svg width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="reconstruction-map-title reconstruction-map-description">
        <title id="reconstruction-map-title">Document history reconstruction</title>
        <desc id="reconstruction-map-description">Documents are stations ordered by date. Colored lines group event categories. Solid connectors come from provider metadata or document references; dashed connectors are inferred similarities.</desc>
        <defs><marker id="reconstruction-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#cbd5e1" /></marker></defs>
        {routes.map((route) => {
          const extent = routeExtents.get(route.id);
          if (!extent) return null;
          return orientation === "horizontal" ? (
            <g key={route.id}><line x1={extent.min} y1={extent.lane} x2={extent.max} y2={extent.lane} stroke={ROUTE_COLORS[route.id]} strokeWidth="8" strokeLinecap="round" opacity="0.78" /><text x="20" y={extent.lane + 5} fill={ROUTE_COLORS[route.id]} fontSize="12" fontWeight="600">{route.label}</text></g>
          ) : (
            <g key={route.id}><line x1={extent.lane} y1={extent.min} x2={extent.lane} y2={extent.max} stroke={ROUTE_COLORS[route.id]} strokeWidth="8" strokeLinecap="round" opacity="0.78" /><text x={extent.lane} y="30" fill={ROUTE_COLORS[route.id]} fontSize="12" fontWeight="600" textAnchor="middle">{route.label}</text></g>
          );
        })}
        {edges.map((edge) => {
          const from = positions.get(edge.from);
          const to = positions.get(edge.to);
          if (!from || !to) return null;
          const mid = orientation === "horizontal" ? (from.x + to.x) / 2 : (from.y + to.y) / 2;
          const path = orientation === "horizontal"
            ? `M ${from.x} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x} ${to.y}`
            : `M ${from.x} ${from.y} C ${from.x} ${mid}, ${to.x} ${mid}, ${to.x} ${to.y}`;
          const active = !traceSelected || (tracedIds.has(edge.from) && tracedIds.has(edge.to));
          return <path key={edge.id} d={path} fill="none" stroke={edge.evidence === "explicit" ? "#f8fafc" : "#94a3b8"} strokeWidth={edge.evidence === "explicit" ? 2.5 : 2} strokeDasharray={edge.evidence === "inferred" ? "7 6" : undefined} markerEnd="url(#reconstruction-arrow)" opacity={active ? 0.8 : 0.12}><title>{RELATIONSHIP_LABELS[edge.relationship]} · {Math.round(edge.confidence * 100)}% · {edge.basis.join(" ")}</title></path>;
        })}
        {nodes.map((node) => {
          const point = positions.get(node.id)!;
          const selected = node.id === selectedId;
          const active = !traceSelected || tracedIds.has(node.id);
          const box = orientation === "horizontal"
            ? { x: point.x - 92, y: point.y + 18 }
            : { x: point.x + 18, y: point.y - 45 };
          return (
            <g key={node.id} opacity={active ? 1 : 0.2}>
              <circle cx={point.x} cy={point.y} r={selected ? 12 : 9} fill="#0f172a" stroke={ROUTE_COLORS[node.route]} strokeWidth={selected ? 5 : 4} />
              <foreignObject x={box.x} y={box.y} width="185" height="108">
                <div className={`h-[100px] border bg-slate-950/95 p-2 text-slate-100 shadow-lg ${selected ? "border-white" : "border-slate-700"}`}>
                  <button type="button" className="block w-full text-left" onClick={() => onSelect(node.id)} title={`${node.title}. ${node.summary}`}>
                    <span className="block truncate text-xs font-semibold">{node.title}</span>
                    <span className="mt-1 block h-9 overflow-hidden text-[10px] leading-[18px] text-slate-400">{truncate(node.summary, 92)}</span>
                  </button>
                  <span className="mt-1 flex items-center justify-between gap-2 text-[10px] text-slate-400">
                    <span>{formatDate(node.date)}</span>
                    <button type="button" className="grid h-6 w-6 place-items-center text-slate-200 hover:bg-slate-800" title="Open source document" aria-label={`Open source document ${node.title}`} onClick={() => onOpenSource(node.id)}><CircleHelp className="h-4 w-4" /></button>
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
