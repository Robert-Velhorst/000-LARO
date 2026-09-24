import { useEffect, useRef, useState } from "react";
import { AlertCircle, ChevronDown, ChevronLeft, ChevronRight, FolderOpen, Loader2, Pause, Play, Plus, RotateCcw, ShieldCheck, Settings } from "lucide-react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import SourceJobProgress from "@/components/SourceJobProgress";
import { useI18n } from "@/contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

type Translate = ReturnType<typeof useI18n>["t"];

const STATUS_KEYS: Record<string, TranslationKey> = {
  running: "sources.status.running",
  paused: "sources.status.paused",
  completed: "sources.status.completed",
  completed_with_errors: "sources.status.completedErrors",
  completed_with_attention: "sources.status.attention",
};
const KIND_KEYS: Record<string, TranslationKey> = {
  local: "sources.kind.local",
  gmail: "sources.kind.gmail",
  drive: "sources.kind.drive",
};
const WORK_STATUS_KEYS: Record<string, TranslationKey> = {
  queued: "sources.work.queued",
  running: "sources.work.running",
  done: "sources.work.done",
  failed: "sources.work.failed",
  skipped: "sources.work.skipped",
  needs_review: "sources.work.needsReview",
  deferred: "sources.work.deferred",
};
const TIER_KEYS: Record<string, TranslationKey> = {
  priority: "sources.tier.priority",
  normal: "sources.tier.normal",
  low: "sources.tier.low",
  unavailable: "sources.tier.unavailable",
};
const SCREEN_REASON_KEYS: Record<string, TranslationKey> = {
  "Legal/document signal in a sampled text fragment": "sources.reason.legalSignal",
  "Software directory context": "sources.reason.softwareDirectory",
  "Conventional application asset name": "sources.reason.assetName",
  "Source-code syntax in sampled text": "sources.reason.sourceCode",
  "No legal signal in sampled text; relevance remains unconfirmed": "sources.reason.noLegalSignal",
  "Image content has not been read or OCRed; relevance remains unconfirmed": "sources.reason.imageUnread",
  "No decisive signal in partial text; retain for analysis": "sources.reason.partialUnclear",
  "Content requires extraction or OCR; retain for analysis": "sources.reason.extractionNeeded",
};
const FAILURE_KEYS: Record<string, { cause: TranslationKey; step: TranslationKey }> = Object.fromEntries([
  "file_access", "file_missing", "storage_full", "file_changed", "inventory_incomplete", "provider_error",
  "timeout", "connection", "google_access", "rate_limit", "protected_document", "unreadable",
  "resource_limit", "model_unconfigured", "unsupported_findings", "incomplete_analysis", "unknown",
].map((code) => [code, {
  cause: `sources.failure.${code}.cause` as TranslationKey,
  step: `sources.failure.${code}.step` as TranslationKey,
}])) as Record<string, { cause: TranslationKey; step: TranslationKey }>;

function translatedLabel(value: string, keys: Record<string, TranslationKey>, t: Translate): string {
  return keys[value] ? t(keys[value]) : value;
}

function sourceScope(raw: string, t: Translate): string {
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    if (config.kind === "local") return String(config.root || t("sources.scope.unknownFolder"));
    if (config.kind === "drive") return config.folderId
      ? t("sources.scope.folder", { folder: String(config.folderId) })
      : t("sources.scope.allDrive");
    return `${config.query || t("sources.scope.allGmail")} ${t(config.includeSpamTrash ? "sources.scope.includeSpam" : "sources.scope.excludeSpam")}`;
  } catch { return t("sources.scope.unavailable"); }
}

function SourceJob({ id }: { id: string }) {
  const { t, formatDate, formatNumber } = useI18n();
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
  if (!query.data) return <p role="status">{t("sources.loadingSource")}</p>;
  const { job, counts, items, total, itemTotal, latestFailures } = query.data;
  const busy = pause.isPending || resume.isPending || rescan.isPending || recheck.isPending;
  const screening = (query.data.screening || []).reduce((sum, row) => ({ files: sum.files + row.count, fileBytes: sum.fileBytes + row.fileBytes,
    readBytes: sum.readBytes + row.sampledBytes, sampledFiles: sum.sampledFiles + row.sampledFiles, priority: sum.priority + (row.tier === "priority" ? row.count : 0),
    low: sum.low + (row.tier === "low" ? row.count : 0) }), { files: 0, fileBytes: 0, readBytes: 0, sampledFiles: 0, priority: 0, low: 0 });
  const kindLabel = translatedLabel(job.kind, KIND_KEYS, t);
  return <article className="min-w-0 space-y-3 border-b py-4" aria-label={t("sources.sourceLabel", { kind: kindLabel })}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0"><h3 className="text-sm font-semibold">{kindLabel}</h3>
        <p className="text-xs text-muted-foreground">{formatDate(job.createdAt, { dateStyle: "medium", timeStyle: "short" })}</p></div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm" role="status">{translatedLabel(job.status, STATUS_KEYS, t)}</span>
        {job.status.startsWith("completed") && <Button size="icon" variant="outline" title={t("sources.checkChanges")} aria-label={t("sources.checkChanges")} disabled={busy} onClick={() => void control("rescan")}><FolderOpen className="h-4 w-4" /></Button>}
        {job.status === "running" && <Button size="icon" variant="outline" title={t("sources.pauseAfterCurrent")} aria-label={t("sources.pause")} disabled={busy} onClick={() => void control("pause")}><Pause className="h-4 w-4" /></Button>}
        {["paused", "completed_with_errors", "completed_with_attention"].includes(job.status) && <Button size="icon" variant="outline" title={t(job.status === "paused" ? "sources.resume" : "sources.retryUnfinished")}
          aria-label={t(job.status === "paused" ? "sources.resume" : "sources.retryUnfinished")} disabled={busy} onClick={() => void control("resume")}>{job.status === "paused" ? <Play className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}</Button>}
        <Button size="icon" variant="ghost" title={t("sources.details")} aria-label={t("sources.details")} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><ChevronDown className="h-4 w-4" /></Button>
      </div>
    </div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
      <div><dt className="text-muted-foreground">{t("sources.discovered")}</dt><dd className="font-semibold tabular-nums">{formatNumber(counts.discovered)}</dd></div>
      <div><dt className="text-muted-foreground">{t("sources.originalsSaved")}</dt><dd className="font-semibold tabular-nums">{formatNumber(counts.imported)}</dd></div>
      <div><dt className="text-muted-foreground">{t("sources.analyzed")}</dt><dd className="font-semibold tabular-nums">{formatNumber(counts.analyzed)}</dd></div>
      <div><dt className="text-muted-foreground">{t("sources.filed")}</dt><dd className="font-semibold tabular-nums">{formatNumber(counts.organized)}</dd></div>
    </dl>
    <p className="text-xs text-muted-foreground">{t("sources.countSummary", {
      analysis: formatNumber(counts.analysisPending), attention: formatNumber(counts.attention),
      deferred: formatNumber(counts.deferred), skipped: formatNumber(counts.skipped), failed: formatNumber(counts.failed),
    })}</p>
    {(counts.skipped > 0 || counts.intakeAttention > 0) && <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>{t(counts.intakeAttention === 1 ? "sources.reviewCountOne" : "sources.reviewCountMany", { count: formatNumber(counts.intakeAttention) })}</span>
      <Button size="sm" variant="ghost" onClick={() => { setExpanded(true); setFilter("exceptions"); setOffset(0); }}><ShieldCheck className="mr-2 h-4 w-4" />{t("sources.reviewExclusions")}</Button>
    </div>}
    <SourceJobProgress sample={{ at: query.dataUpdatedAt, total, pending: counts.pending,
      inventoryPending: counts.inventoryPending, analysisPending: counts.analysisPending, status: job.status }} />
    {screening.files > 0 && <section aria-label={t("sources.quick.label")} className="space-y-2 border-t pt-3 text-xs">
      <h4 className="text-sm font-medium">{t("sources.quick.title")}</h4>
      <p>{t("sources.quick.summary", { files: formatNumber(screening.files), sampled: formatNumber(screening.sampledFiles), priority: formatNumber(screening.priority) })}</p>
      <p className="text-muted-foreground">{t("sources.quick.metrics", {
        fileSize: formatNumber(screening.fileBytes / 1024 ** 3, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        sampleSize: formatNumber(screening.readBytes / 1024 ** 2, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      })}</p>
      {counts.intakeDeferred > 0 && <Button size="sm" variant="outline" onClick={() => { setExpanded(true); setFilter("deferred"); setOffset(0); }}>{t(counts.intakeDeferred === 1 ? "sources.quick.reviewDeferredOne" : "sources.quick.reviewDeferredMany", { count: formatNumber(counts.intakeDeferred) })}</Button>}
    </section>}
    {counts.failed > 0 && <section aria-label={t("sources.failures.label")} className="min-w-0 space-y-3 border-l-2 border-destructive pl-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="flex items-center gap-2 font-medium"><AlertCircle className="h-4 w-4 shrink-0" />{t(counts.failed === 1 ? "sources.failures.countOne" : "sources.failures.countMany", { count: formatNumber(counts.failed) })}</p>
        <Button size="sm" variant="outline" onClick={() => { setExpanded(true); setFilter("failed"); setOffset(0); }}>{t("sources.failures.viewAll")}</Button>
      </div>
      {latestFailures?.map(item => {
        const failureKeys = FAILURE_KEYS[item.failure.code] ?? FAILURE_KEYS.unknown;
        return <div key={item.id} className="min-w-0 space-y-1">
          <p className="break-all font-medium">{item.label}</p>
          <p className="text-xs text-muted-foreground">{t(item.kind === "inbox_analysis" ? "sources.failures.analysis" : "sources.failures.import")} · {formatDate(item.updatedAt, { dateStyle: "medium", timeStyle: "short" })} · {t(item.inboxId ? "sources.failures.originalSaved" : "sources.failures.importUnconfirmed")}</p>
          <p>{t(failureKeys.cause)}</p><p className="text-xs text-muted-foreground">{t(failureKeys.step)}</p>
        </div>;
      })}
    </section>}
    {(pause.error || resume.error || rescan.error || recheck.error) && <p role="alert" className="break-words text-sm">{(pause.error || resume.error || rescan.error || recheck.error)?.message}</p>}
    {recheck.data && <p role="status" className="text-xs">{t(recheck.data.paused ? "sources.checkQueuedPaused" : "sources.checkQueued")}</p>}
    {expanded && <div className="min-w-0 space-y-3 text-sm">
      <dl className="space-y-1"><dt className="font-medium">{t("sources.scope.title")}</dt><dd className="whitespace-pre-wrap break-all text-sm">{sourceScope(job.config, t)}</dd></dl>
      <div role="group" aria-label={t("sources.filter.label")} className="flex flex-wrap gap-1">
        {(["all", "exceptions", "failed", "deferred"] as const).map(value => <Button key={value} size="sm" variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value}
          onClick={() => { setFilter(value); setOffset(0); }}>{t(value === "all" ? "sources.filter.all" : value === "failed" ? "sources.filter.failures" : value === "deferred" ? "sources.filter.deferred" : "sources.filter.review")}</Button>)}
      </div>
      <ul className="space-y-3">{items.map((item) => <li key={item.id} className="min-w-0 border-l-2 pl-3">
        <p className="break-all font-medium">{item.label}</p><p className="text-xs text-muted-foreground">{translatedLabel(item.status, WORK_STATUS_KEYS, t)}</p>
        {item.failure ? <div className="space-y-1"><p>{t((FAILURE_KEYS[item.failure.code] ?? FAILURE_KEYS.unknown).cause)}</p><p className="text-xs text-muted-foreground">{t((FAILURE_KEYS[item.failure.code] ?? FAILURE_KEYS.unknown).step)}</p><p className="text-xs text-muted-foreground">{t("sources.failureCode", { code: item.failure.code })}</p></div>
          : item.error && <p className="break-words">{item.error}</p>}
        {item.screening && <details className="mt-1 text-xs"><summary className="cursor-pointer">{t("sources.quick.item", { tier: translatedLabel(item.screening.tier, TIER_KEYS, t) })}</summary>
          <p>{item.screening.reasons.map(reason => translatedLabel(reason, SCREEN_REASON_KEYS, t)).join(". ")}</p><p>{t("sources.quick.itemMetrics", {
            sampled: formatNumber(item.screening.sampledBytes), total: formatNumber(item.screening.fileBytes),
            date: formatDate(item.screening.checkedAt, { dateStyle: "medium", timeStyle: "short" }),
          })}</p></details>}
        {item.check && <details className="mt-1 text-xs">
          <summary className="cursor-pointer">{t(item.check.outcome === "excluded" ? "sources.check.safety" : "sources.check.limitation")} · {formatDate(item.check.checkedAt, { dateStyle: "medium", timeStyle: "short" })}</summary>
          <p className="mt-1 text-muted-foreground">{t("sources.check.notAssessed")} {t(item.check.basis === "path_policy" ? "sources.check.pathRule" : "sources.check.notIrrelevant")}</p>
          <dl className="mt-2 space-y-1">{Object.entries(item.check.facts).map(([key, value]) => <div key={key} className="break-all"><dt className="inline font-medium">{key}: </dt><dd className="inline">{value === null ? t("sources.unknown") : String(value)}</dd></div>)}</dl>
        </details>}
        {item.status === "skipped" && !item.check && <p className="text-xs text-amber-500">{t("sources.unverifiedSkip")}</p>}
        {item.kind !== "inbox_analysis" && ["skipped", "needs_review", "failed"].includes(item.status) && <Button size="icon" variant="ghost" disabled={busy}
          title={t("sources.recheckItem", { label: item.label })} aria-label={t("sources.recheckItem", { label: item.label })} onClick={() => recheck.mutate({ id, workId: item.id })}><RotateCcw className="h-4 w-4" /></Button>}
        {item.kind !== "inbox_analysis" && item.status === "deferred" && <Button size="sm" variant="outline" disabled={busy} onClick={() => recheck.mutate({ id, workId: item.id })}><Play className="mr-2 h-4 w-4" />{t("sources.analyzeAnyway")}</Button>}
      </li>)}</ul>
      {!items.length && <p className="text-xs text-muted-foreground">{t("sources.noItems")}</p>}
      <div className="flex items-center gap-2">
        <Button size="icon" variant="outline" title={t("sources.previousItems")} aria-label={t("sources.previousItems")} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}><ChevronLeft className="h-4 w-4" /></Button>
        <span>{formatNumber(itemTotal ? offset + 1 : 0)}-{formatNumber(Math.min(offset + 20, itemTotal))} / {formatNumber(itemTotal)}</span>
        <Button size="icon" variant="outline" title={t("sources.nextItems")} aria-label={t("sources.nextItems")} disabled={offset + 20 >= itemTotal} onClick={() => setOffset(offset + 20)}><ChevronRight className="h-4 w-4" /></Button>
      </div>
    </div>}
  </article>;
}

export default function DocumentSources() {
  const { t, formatDate, formatNumber } = useI18n();
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
    catch (error) { setNativeError(error instanceof Error ? error.message : t("sources.localStartFailed")); }
    finally { setNativeBusy(false); }
  };
  return <section aria-label={t("sources.title")} className="min-w-0 space-y-3 border-b pb-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold">{t("sources.title")}</h2>
      <Button size="sm" variant="outline" aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus className="mr-2 h-4 w-4" />{t("sources.add")}</Button></div>
    {adding && <div className="min-w-0 space-y-4 border-y py-4">
      <div role="group" aria-label={t("sources.type")} className="flex flex-wrap gap-1">{(["gmail", "drive"] as const).map((value) => <Button key={value} size="sm" variant={kind === value ? "secondary" : "ghost"} aria-pressed={kind === value} onClick={() => setKind(value)}>{t(KIND_KEYS[value])}</Button>)}
        {localSourcesAvailable && <Button size="sm" variant="outline" aria-label={t("sources.selectLocal")} disabled={nativeBusy} onClick={() => void startLocal()}>{nativeBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FolderOpen className="mr-2 h-4 w-4" />}{t("sources.kind.local")}</Button>}
      </div>
      {!localSourcesAvailable && <p className="text-sm text-muted-foreground">{t("sources.localHint")}</p>}
      <label className="block text-sm">{t("sources.googleAccount")}<select aria-label={t("sources.googleAccount")} className="mt-1 w-full min-w-0 rounded border bg-background p-2" value={selectedAccount} onChange={(event) => setAccountId(event.target.value)}>
        <option value="">{t(accounts.isLoading ? "sources.accountsLoading" : connected.length ? "sources.accountSelect" : "sources.noGoogleAccount")}</option>
        {connected.map((account) => <option key={account.id} value={account.id}>{account.email}</option>)}
      </select></label>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!selectedAccount || checkConnection.isPending} onClick={() => checkConnection.mutate({ accountId: selectedAccount, kind })}>
          {checkConnection.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}{t("sources.checkGoogle")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setLocation("/settings?section=sources")}><Settings className="mr-2 h-4 w-4" />{t("sources.googleConnection")}</Button>
      </div>
      {checkedSelection && checkConnection.data && <p role={checkConnection.data.accessible ? "status" : "alert"} className="break-words text-sm">
        {checkConnection.data.accessible ? t("sources.accessVerified", { kind: t(KIND_KEYS[kind]), time: formatDate(checkConnection.data.checkedAt, { timeStyle: "medium" }) }) : checkConnection.data.message}
      </p>}
      {checkedSelection && checkConnection.error && <p role="alert" className="text-sm">{checkConnection.error.message}</p>}
      <details><summary className="cursor-pointer text-sm">{t("sources.filters")}</summary><div className="mt-3 space-y-3 text-sm">
        {kind === "gmail" ? <><label className="block">{t("sources.gmailQuery")}<input aria-label={t("sources.gmailQuery")} className="mt-1 w-full rounded border bg-background p-2" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={includeSpamTrash} onChange={(event) => setIncludeSpamTrash(event.target.checked)} />{t("sources.includeSpam")}</label></>
          : <label className="block">{t("sources.driveFolder")}<input aria-label={t("sources.driveFolderInput")} className="mt-1 w-full rounded border bg-background p-2" value={folderId} onChange={(event) => setFolderId(event.target.value)} /></label>}
      </div></details>
      <p className="break-words text-sm text-muted-foreground">{sourceScope(JSON.stringify({ kind, query, folderId: folderId.trim(), includeSpamTrash }), t)}</p>
      <Button size="sm" disabled={start.isPending || !connected.some((account) => account.id === selectedAccount)} onClick={() => void startGoogle()}>{start.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}{t("sources.start")}</Button>
      {(accounts.error || start.error || nativeError) && <p role="alert" className="break-words text-sm">{nativeError || accounts.error?.message || start.error?.message}</p>}
    </div>}
    {sources.error && <p role="alert">{sources.error.message}</p>}
    {sources.isLoading && <p role="status">{t("sources.loading")}</p>}
    {sources.data?.total === 0 && <p className="text-sm text-muted-foreground">{t("sources.empty")}</p>}
    {sources.data?.items.map((job) => <SourceJob key={job.id} id={job.id} />)}
    {(sources.data?.total || 0) > 5 && <div className="flex items-center gap-2 text-sm">
      <Button size="icon" variant="outline" title={t("sources.previous")} aria-label={t("sources.previous")} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 5))}><ChevronLeft className="h-4 w-4" /></Button>
      <span>{formatNumber(offset + 1)}-{formatNumber(Math.min(offset + 5, sources.data!.total))} / {formatNumber(sources.data!.total)}</span>
      <Button size="icon" variant="outline" title={t("sources.next")} aria-label={t("sources.next")} disabled={offset + 5 >= sources.data!.total} onClick={() => setOffset(offset + 5)}><ChevronRight className="h-4 w-4" /></Button>
    </div>}
  </section>;
}
