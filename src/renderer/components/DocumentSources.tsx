import { useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronLeft, ChevronRight, FolderOpen, Loader2, Pause, Play, Plus, RotateCcw, ShieldCheck, Settings } from "lucide-react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import SourceJobProgress from "@/components/SourceJobProgress";

const STATUS: Record<string, string> = { running: "Running", paused: "Paused", completed: "Completed", completed_with_errors: "Completed with errors", completed_with_attention: "Processing needs attention" };
const KIND: Record<string, string> = { local: "Local folder", gmail: "Gmail", drive: "Google Drive" };
function sourceScope(raw: string): string {
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (config.kind === "local") return String(config.root || "Unknown folder");
    if (config.kind === "drive") return config.folderId ? `Folder: ${config.folderId}` : "All accessible Drive files";
    return `${config.query || "All Gmail messages"}${config.includeSpamTrash ? " (including spam and trash)" : " (excluding spam and trash)"}`;
  } catch { return "Source scope unavailable"; }
}

function SourceJob({ id }: { id: string }) {
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState<"all" | "exceptions" | "failed" | "deferred">("all");
  const query = trpc.documentSources.get.useQuery({ id, offset, filter }, { refetchInterval: 5000 });
  const pause = trpc.documentSources.pause.useMutation();
  const resume = trpc.documentSources.resume.useMutation();
  const rescan = trpc.documentSources.rescan.useMutation();
  const recheck = trpc.documentSources.recheck.useMutation({ onSuccess: () => utils.documentSources.invalidate() });
  const utils = trpc.useUtils();
  const last = useRef("");
  const signature = query.data ? JSON.stringify([query.data.job.updatedAt, query.data.counts]) : "";
  useEffect(() => {
    if (!signature || last.current === signature) return;
    last.current = signature;
    void Promise.all([utils.documentInbox.invalidate(), utils.cases.invalidate(), utils.evidenceFiles.invalidate()]);
  }, [signature, utils]);
  const control = async (action: "pause" | "resume" | "rescan") => {
    try {
      await (action === "pause" ? pause : action === "resume" ? resume : rescan).mutateAsync({ id });
      await utils.documentSources.invalidate();
    } catch { /* The mutation error stays visible. */ }
  };
  if (query.error) return <p role="alert">{query.error.message}</p>;
  if (!query.data) return <p role="status">Loading source...</p>;
  const { job, counts, items, total, itemTotal, latestFailures } = query.data;
  const busy = pause.isPending || resume.isPending || rescan.isPending || recheck.isPending;
  const screening = (query.data.screening || []).reduce((sum, row) => ({ files: sum.files + row.count, fileBytes: sum.fileBytes + row.fileBytes,
    readBytes: sum.readBytes + row.sampledBytes, sampledFiles: sum.sampledFiles + row.sampledFiles, priority: sum.priority + (row.tier === "priority" ? row.count : 0),
    low: sum.low + (row.tier === "low" ? row.count : 0) }), { files: 0, fileBytes: 0, readBytes: 0, sampledFiles: 0, priority: 0, low: 0 });
  return <article className="min-w-0 space-y-3 border-b py-4" aria-label={`${KIND[job.kind]} source`}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><h3 className="text-sm font-semibold">{KIND[job.kind]}</h3>
        <p className="text-xs text-muted-foreground">{job.createdAt.toLocaleString()}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm" role="status">{STATUS[job.status] || job.status}</span>
        {job.status.startsWith("completed") && <Button size="icon" variant="outline" title="Check source for new or changed files" aria-label="Check source for new or changed files" disabled={busy} onClick={() => void control("rescan")}><FolderOpen className="h-4 w-4" /></Button>}
        {job.status === "running" && <Button size="icon" variant="outline" title="Pause after current document" aria-label="Pause source" disabled={busy} onClick={() => void control("pause")}><Pause className="h-4 w-4" /></Button>}
        {["paused", "completed_with_errors", "completed_with_attention"].includes(job.status) && <Button size="icon" variant="outline" title={job.status === "paused" ? "Resume source" : "Retry unfinished processing"}
          aria-label={job.status === "paused" ? "Resume source" : "Retry unfinished processing"} disabled={busy} onClick={() => void control("resume")}>{job.status === "paused" ? <Play className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}</Button>}
        <Button size="icon" variant="ghost" title="Source details" aria-label="Source details" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><ChevronDown className="h-4 w-4" /></Button>
      </div>
    </div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
      <div><dt className="text-muted-foreground">Discovered</dt><dd className="font-semibold tabular-nums">{counts.discovered}</dd></div>
      <div><dt className="text-muted-foreground">Originals saved</dt><dd className="font-semibold tabular-nums">{counts.imported}</dd></div>
      <div><dt className="text-muted-foreground">Analyzed</dt><dd className="font-semibold tabular-nums">{counts.analyzed}</dd></div>
      <div><dt className="text-muted-foreground">Filed in dossiers</dt><dd className="font-semibold tabular-nums">{counts.organized}</dd></div>
    </dl>
    <p className="text-xs text-muted-foreground">{counts.analysisPending} awaiting analysis | {counts.attention} need a dossier decision | {counts.deferred} deferred | {counts.skipped} skipped | {counts.failed} failed</p>
    {(counts.skipped > 0 || counts.intakeAttention > 0) && <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>{counts.intakeAttention} source items need review</span>
      <Button size="sm" variant="ghost" onClick={() => { setExpanded(true); setFilter("exceptions"); setOffset(0); }}><ShieldCheck className="mr-2 h-4 w-4" />Review exclusions</Button>
    </div>}
    <SourceJobProgress sample={{ at: query.dataUpdatedAt, total, pending: counts.pending,
      inventoryPending: counts.inventoryPending, analysisPending: counts.analysisPending, status: job.status }} />
    {screening.files > 0 && <section aria-label="Quick source screening" className="space-y-2 border-t pt-3 text-xs">
      <h4 className="text-sm font-medium">Quick screening</h4>
      <p>{screening.files.toLocaleString()} items checked · {screening.sampledFiles.toLocaleString()} text-sampled · {screening.priority.toLocaleString()} priority candidates</p>
      <p className="text-muted-foreground">File sizes represented: {(screening.fileBytes / 1024 ** 3).toFixed(2)} GiB · Bytes actually sampled: {(screening.readBytes / 1024 ** 2).toFixed(2)} MiB. Partial samples, not full analysis or OCR.</p>
      {counts.intakeDeferred > 0 && <Button size="sm" variant="outline" onClick={() => { setExpanded(true); setFilter("deferred"); setOffset(0); }}>Review {counts.intakeDeferred.toLocaleString()} deferred items</Button>}
    </section>}
    {counts.failed > 0 && <section aria-label="Source failures" className="min-w-0 space-y-3 border-l-2 border-destructive pl-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="flex items-center gap-2 font-medium"><AlertCircle className="h-4 w-4 shrink-0" />{counts.failed} processing failures</p>
        <Button size="sm" variant="outline" onClick={() => { setExpanded(true); setFilter("failed"); setOffset(0); }}>View all failures</Button>
      </div>
      {latestFailures?.map(item => <div key={item.id} className="min-w-0 space-y-1">
        <p className="break-all font-medium">{item.label}</p>
        <p className="text-xs text-muted-foreground">{item.kind === "inbox_analysis" ? "Analysis / dossier assignment" : "Source discovery / import"} · {item.updatedAt.toLocaleString()} · {item.inboxId ? "Original saved" : "Import not confirmed"}</p>
        <p>{item.failure.cause}</p><p className="text-xs text-muted-foreground">{item.failure.nextStep}</p>
      </div>)}
    </section>}
    {(pause.error || resume.error || rescan.error || recheck.error) && <p role="alert" className="break-words text-sm">{(pause.error || resume.error || rescan.error || recheck.error)?.message}</p>}
    {recheck.data && <p role="status" className="text-xs">{recheck.data.paused ? "Check queued. Resume the paused source to process it." : "Check queued. The result will update automatically."}</p>}
    {expanded && <div className="min-w-0 space-y-3 text-sm">
      <dl className="space-y-1"><dt className="font-medium">Source scope</dt><dd className="whitespace-pre-wrap break-all text-sm">{sourceScope(job.config)}</dd></dl>
      <div role="group" aria-label="Source item filter" className="flex flex-wrap gap-1">
        {(["all", "exceptions", "failed", "deferred"] as const).map(value => <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value}
          onClick={() => { setFilter(value); setOffset(0); }}>{value === "all" ? "All items" : value === "failed" ? "Failures" : value === "deferred" ? "Deferred" : "Exclusions and review"}</Button>)}
      </div>
      <ul className="space-y-3">{items.map((item) => <li key={item.id} className="min-w-0 border-l-2 pl-3">
        <p className="break-all font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{item.status}</p>
        {item.failure ? <div className="space-y-1"><p>{item.failure.cause}</p><p className="text-xs text-muted-foreground">{item.failure.nextStep}</p><p className="text-xs text-muted-foreground">Failure code: {item.failure.code}</p></div>
          : item.error && <p className="break-words">{item.error}</p>}
        {item.screening && <details className="mt-1 text-xs"><summary className="cursor-pointer">Quick screening: {item.screening.tier}</summary>
          <p>{item.screening.reasons.join(". ")}</p><p>{item.screening.sampledBytes.toLocaleString()} bytes sampled of {item.screening.fileBytes.toLocaleString()} bytes · {new Date(item.screening.checkedAt).toLocaleString()}</p></details>}
        {item.check && <details className="mt-1 text-xs">
          <summary className="cursor-pointer">{item.check.outcome === "excluded" ? "Safety rule checked" : "Import limitation checked"} · {new Date(item.check.checkedAt).toLocaleString()}</summary>
          <p className="mt-1 text-muted-foreground">Contents and legal relevance were not assessed. {item.check.basis === "path_policy" ? "This is a path-based safety rule, not a content verdict." : "This check does not establish that the original is irrelevant."}</p>
          <dl className="mt-2 space-y-1">{Object.entries(item.check.facts).map(([key, value]) => <div key={key} className="break-all"><dt className="inline font-medium">{key}: </dt><dd className="inline">{value === null ? "Unknown" : String(value)}</dd></div>)}</dl>
        </details>}
        {item.status === "skipped" && !item.check && <p className="text-xs text-amber-500">Previous skip has no recorded verification. Check it again.</p>}
        {item.kind !== "inbox_analysis" && ["skipped", "needs_review", "failed"].includes(item.status) && <Button size="icon" variant="ghost" disabled={busy}
          title="Check this source item again" aria-label={`Recheck ${item.label}`} onClick={() => recheck.mutate({ id, workId: item.id })}><RotateCcw className="h-4 w-4" /></Button>}
        {item.kind !== "inbox_analysis" && item.status === "deferred" && <Button size="sm" variant="outline" disabled={busy} onClick={() => recheck.mutate({ id, workId: item.id })}><Play className="mr-2 h-4 w-4" />Analyze anyway</Button>}
      </li>)}</ul>
      {!items.length && <p className="text-xs text-muted-foreground">No items in this view.</p>}
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" title="Previous source items" aria-label="Previous source items" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}><ChevronLeft className="h-4 w-4" /></Button>
        <span>{itemTotal ? offset + 1 : 0}-{Math.min(offset + 20, itemTotal)} / {itemTotal}</span>
        <Button size="icon" variant="outline" title="Next source items" aria-label="Next source items" disabled={offset + 20 >= itemTotal} onClick={() => setOffset(offset + 20)}><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>}
  </article>;
}

export default function DocumentSources() {
  const [, setLocation] = useLocation();
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<"gmail" | "drive">("gmail");
  const [accountId, setAccountId] = useState("");
  const [query, setQuery] = useState("");
  const [folderId, setFolderId] = useState("");
  const [includeSpamTrash, setIncludeSpamTrash] = useState(false);
  const [offset, setOffset] = useState(0);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [nativeError, setNativeError] = useState("");
  const [localSourcesAvailable, setLocalSourcesAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    if (window.electronAPI?.startLocalSource) {
      void window.electronAPI.getConfig().then((config) => {
        if (active) setLocalSourcesAvailable((config as { localSourcesAvailable?: boolean }).localSourcesAvailable !== false);
      }).catch(() => { /* Leave native source selection unavailable if its mode cannot be verified. */ });
    }
    return () => { active = false; };
  }, []);
  const accounts = trpc.documentSources.accounts.useQuery(undefined, { enabled: adding, refetchInterval: 5000 });
  const sources = trpc.documentSources.list.useQuery({ offset, limit: 5 }, { refetchInterval: 5000 });
  const start = trpc.documentSources.start.useMutation();
  const checkConnection = trpc.documentSources.checkConnection.useMutation();
  const utils = trpc.useUtils();
  const connected = accounts.data?.filter((account) => account.status === "connected") || [];
  const selectedAccount = accountId || (connected.length === 1 ? connected[0].id : "");
  const checkedSelection = checkConnection.variables?.accountId === selectedAccount && checkConnection.variables?.kind === kind;
  const startGoogle = async () => {
    try {
      await start.mutateAsync(kind === "gmail" ? { kind, accountId: selectedAccount, query, includeSpamTrash } : { kind, accountId: selectedAccount, folderId: folderId.trim() || undefined });
      setOffset(0); setAdding(false); await utils.documentSources.invalidate();
    } catch { /* The mutation error stays visible. */ }
  };
  const startLocal = async () => {
    setNativeBusy(true); setNativeError("");
    try { await window.electronAPI?.startLocalSource?.(); setOffset(0); await utils.documentSources.invalidate(); }
    catch (error) { setNativeError(error instanceof Error ? error.message : "Local source could not be started"); }
    finally { setNativeBusy(false); }
  };
  return <section aria-label="Document sources" className="min-w-0 space-y-3 border-b pb-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">Document sources</h2>
      <Button size="sm" variant="outline" aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus className="mr-2 h-4 w-4" />Add source</Button></div>
    {adding && <div className="min-w-0 space-y-4 border-y py-4">
      <div role="group" aria-label="Source type" className="flex flex-wrap gap-1">{(["gmail", "drive"] as const).map((value) => <Button key={value} size="sm" variant={kind === value ? "secondary" : "ghost"} aria-pressed={kind === value} onClick={() => setKind(value)}>{KIND[value]}</Button>)}
        {localSourcesAvailable && <Button size="sm" variant="outline" aria-label="Select local source" disabled={nativeBusy} onClick={() => void startLocal()}>{nativeBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderOpen className="mr-2 h-4 w-4" />}Local folder</Button>}
      </div>
      {!localSourcesAvailable && <p className="text-sm text-muted-foreground">To copy a folder from this computer, use Folder in the Document inbox below. Background local sources require the local desktop workspace.</p>}
      <label className="block text-sm">Google account<select aria-label="Google account" className="mt-1 w-full min-w-0 rounded border bg-background p-2" value={selectedAccount} onChange={(event) => setAccountId(event.target.value)}>
        <option value="">{accounts.isLoading ? "Loading accounts..." : connected.length ? "Select account" : "No connected Google account"}</option>
        {connected.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
      </select></label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!selectedAccount || checkConnection.isPending} onClick={() => checkConnection.mutate({ accountId: selectedAccount, kind })}>
          {checkConnection.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}Check Google access
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setLocation("/settings?section=sources")}><Settings className="mr-2 h-4 w-4" />Google connection</Button>
      </div>
      {checkedSelection && checkConnection.data && <p role={checkConnection.data.accessible ? "status" : "alert"} className="break-words text-sm">
        {checkConnection.data.accessible ? `${KIND[kind]} access verified at ${checkConnection.data.checkedAt.toLocaleTimeString()}` : checkConnection.data.message}
      </p>}
      {checkedSelection && checkConnection.error && <p role="alert" className="text-sm">{checkConnection.error.message}</p>}
      <details><summary className="cursor-pointer text-sm">Source filters</summary><div className="mt-3 space-y-3 text-sm">
        {kind === "gmail" ? <><label className="block">Gmail query<input aria-label="Gmail query" className="mt-1 w-full rounded border bg-background p-2" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={includeSpamTrash} onChange={(event) => setIncludeSpamTrash(event.target.checked)} />Include spam and trash</label></>
          : <label className="block">Drive folder ID (optional)<input aria-label="Drive folder ID" className="mt-1 w-full rounded border bg-background p-2" value={folderId} onChange={(event) => setFolderId(event.target.value)} /></label>}
      </div></details>
      <p className="break-words text-sm text-muted-foreground">{sourceScope(JSON.stringify({ kind, query, folderId: folderId.trim(), includeSpamTrash }))}</p>
      <Button size="sm" disabled={start.isPending || !connected.some((account) => account.id === selectedAccount)} onClick={() => void startGoogle()}>{start.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Start source</Button>
      {(accounts.error || start.error || nativeError) && <p role="alert" className="break-words text-sm">{nativeError || accounts.error?.message || start.error?.message}</p>}
    </div>}
    {sources.error && <p role="alert">{sources.error.message}</p>}
    {sources.isLoading && <p role="status">Loading sources...</p>}
    {sources.data?.total === 0 && <p className="text-sm text-muted-foreground">No source imports yet.</p>}
    {sources.data?.items.map((job) => <SourceJob key={job.id} id={job.id} />)}
    {(sources.data?.total || 0) > 5 && <div className="flex items-center gap-2 text-sm">
      <Button size="icon" variant="outline" title="Previous sources" aria-label="Previous sources" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 5))}><ChevronLeft className="h-4 w-4" /></Button>
      <span>{offset + 1}-{Math.min(offset + 5, sources.data!.total)} / {sources.data!.total}</span>
      <Button size="icon" variant="outline" title="Next sources" aria-label="Next sources" disabled={offset + 5 >= sources.data!.total} onClick={() => setOffset(offset + 5)}><ChevronRight className="h-4 w-4" /></Button>
    </div>}
  </section>;
}
