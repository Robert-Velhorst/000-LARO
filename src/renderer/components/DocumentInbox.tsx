import { useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Download, FolderOpen, Loader2, Play, Settings, Upload, X } from "lucide-react";
import { useLocation } from "wouter";
import { useI18n } from "@/contexts/I18nContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import DocumentSources from "./DocumentSources";
import InboxAssignmentControls from "./InboxAssignmentControls";
import { MAX_EVIDENCE_FILE_BYTES, isSupportedDocumentAnalysisMimeType } from "../../../shared/evidenceFiles";
import { EVIDENCE_INGESTION_LIMITS } from "../../../shared/evidenceIngestion";
import type { TranslationKey } from "../../../shared/i18n";

const MIME: Record<string, string> = { txt: "text/plain", csv: "text/csv", html: "text/html", htm: "text/html", eml: "message/rfc822",
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const PROVIDER_STATUS_KEYS: Record<string, TranslationKey> = {
  not_requested: "inbox.provider.not_requested",
  unavailable: "inbox.provider.unavailable",
  complete: "inbox.provider.complete",
  partial: "inbox.provider.partial",
  invalid_response: "inbox.provider.invalid_response",
  failed: "inbox.provider.failed",
};

async function base64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(text);
}

function InboxDetails({ id, refresh }: { id: string; refresh: () => Promise<void> }) {
  const [, setLocation] = useLocation();
  const { t, formatNumber } = useI18n();
  const query = trpc.documentInbox.get.useQuery({ id });
  const assign = trpc.documentInbox.assign.useMutation();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState("");
  const [passages, setPassages] = useState(5);
  const choices = trpc.cases.list.useQuery({ page, limit: 10, search }, { enabled: !query.data?.evidenceId });
  if (query.isLoading) return <p role="status">{t("inbox.loadingAnalysis")}</p>;
  if (query.error) return <p role="alert">{query.error.message}</p>;
  const item = query.data;
  if (!item) return null;
  const accept = async (caseId: string) => {
    try { await assign.mutateAsync({ id, caseId }); await refresh(); } catch { /* Mutation error remains visible. */ }
  };
  return <div className="space-y-4 border-t pt-4 text-sm">
    <p className="break-words">{item.reason || t("inbox.notAnalyzed")}</p>
    {!item.evidenceId && <Button variant="outline" onClick={() => setLocation("/settings")}>
      <Settings className="mr-2 h-4 w-4" />{t("inbox.analysisSettings")}
    </Button>}
    {item.discovery && <details>
      <summary className="cursor-pointer py-2">{t(item.decision === "corrected" ? "inbox.decision.initial" : "inbox.decision.current")}</summary>
      <p className="mb-3 text-xs text-muted-foreground">{t(item.discovery.action === "review" ? "inbox.discovery.review" : item.discovery.action === "create" ? "inbox.discovery.create" : "inbox.discovery.add")} | {item.discovery.provider || t("inbox.discovery.noModel")}</p>
      <ol className="space-y-4">
        {item.discovery.basis.map((basis, index) => <li key={index} className="space-y-2 border-l-2 border-emerald-600 pl-3">
          <p className="font-medium">{t(basis.kind === "participant" ? "inbox.basis.participant" : basis.kind === "situation" ? "inbox.basis.situation" : "inbox.basis.continuity")}</p>
          <p className="text-xs text-muted-foreground">{t("inbox.documentPassage")}</p>
          <blockquote className="whitespace-pre-wrap break-words">{basis.quote}</blockquote>
          {basis.caseQuote && <><p className="text-xs text-muted-foreground">{t("inbox.caseContext")}</p>
            <blockquote className="whitespace-pre-wrap break-words">{basis.caseQuote}</blockquote></>}
        </li>)}
      </ol>
    </details>}
    {item.analysis && <>
      <p className="break-words">{item.analysis.summary}</p>
      <p className="text-xs text-muted-foreground">{t("inbox.analysisMeta", {
        provider: item.analysis.analysisProvider || t("inbox.provider.local"),
        status: PROVIDER_STATUS_KEYS[item.analysis.providerStatus] ? t(PROVIDER_STATUS_KEYS[item.analysis.providerStatus]) : item.analysis.providerStatus.replaceAll("_", " "),
        coverage: t(item.analysis.coverage.complete ? "inbox.coverage.full" : "inbox.coverage.partial"),
      })}</p>
      {item.analysis.providerMessage && <p role="status">{item.analysis.providerMessage}</p>}
      <details>
        <summary className="cursor-pointer py-2">{t("inbox.sourcePassages")}</summary>
        <ol className="space-y-3">
          {item.analysis.citations.slice(0, passages).map((citation) => <li key={citation.id} className="border-l-2 border-emerald-600 pl-3">
            <p className="text-xs text-muted-foreground">{t("inbox.lines", { start: formatNumber(citation.lineStart), end: formatNumber(citation.lineEnd) })}</p>
            <blockquote className="whitespace-pre-wrap break-words">{citation.quote}</blockquote>
          </li>)}
        </ol>
        {item.analysis.citations.length > passages && <Button variant="ghost" onClick={() => setPassages((n) => n + 10)}><ChevronDown className="mr-2 h-4 w-4" />{t("inbox.morePassages")}</Button>}
      </details>
    </>}
    {!item.evidenceId && <div className="space-y-3">
      {item.suggestions.map((suggestion) => <div key={suggestion.caseId} className="flex flex-wrap items-start justify-between gap-2 border-b pb-2">
        <div className="min-w-0 flex-1"><p className="break-words font-medium">{suggestion.title}</p><p className="break-words text-xs text-muted-foreground">{suggestion.reasons.join("; ")}</p></div>
        <Button size="sm" disabled={assign.isPending} onClick={() => void accept(suggestion.caseId)}><FolderOpen className="mr-2 h-4 w-4" />{t("inbox.assign")}</Button>
      </div>)}
      <label className="block">{t("inbox.findCase")}<input className="mt-1 w-full rounded border bg-background p-2" value={search}
        onChange={(event) => { setSearch(event.target.value); setPage(1); setSelected(""); }} /></label>
      {choices.error && <p role="alert">{choices.error.message}</p>}
      <label className="block">{t("inbox.case")}<select className="mt-1 w-full min-w-0 rounded border bg-background p-2" value={selected} onChange={(event) => setSelected(event.target.value)}>
        <option value="">{t("inbox.selectCase")}</option>{choices.data?.cases.map((row) => <option key={row.id} value={row.id}>{row.clientName || row.caseType || row.id}</option>)}
      </select></label>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="icon" variant="outline" aria-label={t("inbox.previousCases")} title={t("inbox.previousCases")} disabled={page === 1} onClick={() => { setPage(page - 1); setSelected(""); }}><ChevronLeft className="h-4 w-4" /></Button>
        <span>{t("inbox.page", { page: formatNumber(page), total: formatNumber(Math.max(1, choices.data?.pagination.totalPages || 0)) })}</span>
        <Button size="icon" variant="outline" aria-label={t("inbox.nextCases")} title={t("inbox.nextCases")} disabled={page >= (choices.data?.pagination.totalPages || 0)} onClick={() => { setPage(page + 1); setSelected(""); }}><ChevronRight className="h-4 w-4" /></Button>
        <Button disabled={!selected || assign.isPending} onClick={() => void accept(selected)}><FolderOpen className="mr-2 h-4 w-4" />{t("inbox.assignToCase")}</Button>
      </div>
      {assign.error && <p role="alert">{assign.error.message}</p>}
    </div>}
    <InboxAssignmentControls id={id} assignment={item.assignment} refresh={refresh} />
    <details><summary className="cursor-pointer">{t("inbox.sourceIdentity")}</summary><p className="mt-2 break-all">{item.sourcePath}</p><p className="mt-2 break-all font-mono text-xs">{t("inbox.sha256", { hash: item.contentHash })}</p></details>
  </div>;
}

export default function DocumentInbox({ onOpenCase }: { onOpenCase: (caseId: string) => void }) {
  const { t, formatNumber } = useI18n();
  const [view, setView] = useState<"unassigned" | "assigned" | "all">("all");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const stop = useRef(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const preferences = trpc.userPreferences.workflow.useQuery();
  const query = trpc.documentInbox.list.useQuery({ view, offset, limit: 20 });
  const upload = trpc.documentInbox.upload.useMutation();
  const process = trpc.documentInbox.process.useMutation();
  const download = trpc.documentInbox.download.useMutation();
  const refresh = async () => {
    await Promise.all([utils.documentInbox.invalidate(), utils.cases.invalidate(), utils.evidenceFiles.invalidate(), utils.documentAnalysis.invalidate(),
      utils.actionProposals.invalidate(), utils.actionEvidence.invalidate(), utils.caseManagement.invalidate()]);
  };
  const report = (message: string) => setErrors((previous) => [...previous, message]);
  const handleFiles = async (selected: FileList | null) => {
    if (!selected?.length || busy || !preferences.data) return;
    setBusy(true); stop.current = false; setErrors([]); setView("all"); setOffset(0);
    const queue: File[] = [];
    let queuedBytes = 0;
    let deferred = 0;
    for (const file of Array.from(selected)) {
      if (
        queue.length >= EVIDENCE_INGESTION_LIMITS.maxJobItems ||
        queuedBytes + file.size > EVIDENCE_INGESTION_LIMITS.maxJobBytes
      ) {
        deferred += 1;
        continue;
      }
      queue.push(file);
      queuedBytes += file.size;
    }
    if (deferred) report(t(deferred === 1 ? "inbox.deferredOne" : "inbox.deferredMany", { count: formatNumber(deferred) }));
    const ingestionJobId = crypto.randomUUID();
    setProgress({ done: 0, total: queue.length });
    try {
      for (const [index, file] of queue.entries()) {
        if (stop.current) break;
        let stored = false;
        try {
          const mimeType = file.type || MIME[file.name.split(".").pop()?.toLowerCase() || ""] || "";
          if (!file.size || file.size > MAX_EVIDENCE_FILE_BYTES || !isSupportedDocumentAnalysisMimeType(mimeType)) throw new Error(t("inbox.unsupported"));
          setCurrent(t("inbox.saving", { name: file.name }));
          const item = await upload.mutateAsync({
            fileName: file.name,
            sourcePath: file.webkitRelativePath || file.name,
            mimeType,
            base64: await base64(file),
            ingestionJobId,
            ingestionItemId: `${index}-${file.name}`.slice(0, 200),
          });
          stored = true;
          if (preferences.data.autoAnalyzeImports && item.analysisEligible) {
            setCurrent(t("inbox.analyzing", { name: file.name }));
            await process.mutateAsync({ id: item.id });
          } else if (preferences.data.autoAnalyzeImports && !item.analysisEligible) {
            report(t("inbox.analysisDeferred", { name: file.name }));
          }
        } catch (error) {
          report(t("inbox.fileError", {
            name: file.name,
            message: error instanceof Error ? error.message : t("inbox.processingFailed"),
            saved: stored ? t("inbox.originalSavedSuffix") : "",
          }));
        }
        setProgress({ done: index + 1, total: queue.length });
        await refresh();
      }
    } finally { setBusy(false); setCurrent(""); if (files.current) files.current.value = ""; if (folder.current) folder.current.value = ""; }
  };
  const processOne = async (id: string) => {
    setBusy(true);
    try { await process.mutateAsync({ id, force: true }); await refresh(); } catch (error) { report(error instanceof Error ? error.message : t("inbox.processingFailed")); await refresh(); }
    finally { setBusy(false); }
  };
  const saveOriginal = async (id: string) => {
    try {
      const result = await download.mutateAsync({ id });
      const bytes = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = result.fileName; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) { report(error instanceof Error ? error.message : t("inbox.downloadFailed")); }
  };
  return <section aria-label={t("inbox.title")} className="min-w-0 space-y-5">
    <DocumentSources />
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-semibold">{t("inbox.title")}</h2>
      <div className="flex flex-wrap gap-2">
        <input ref={files} type="file" multiple className="hidden" aria-label={t("inbox.uploadDocuments")} onChange={(event) => void handleFiles(event.target.files)} />
        <input ref={folder} type="file" multiple {...{ webkitdirectory: "" }} className="hidden" aria-label={t("inbox.uploadFolder")} onChange={(event) => void handleFiles(event.target.files)} />
        <Button disabled={busy || !preferences.data} onClick={() => files.current?.click()}><Upload className="mr-2 h-4 w-4" />{t("inbox.documents")}</Button>
        <Button variant="outline" disabled={busy || !preferences.data} onClick={() => folder.current?.click()}><FolderOpen className="mr-2 h-4 w-4" />{t("inbox.folder")}</Button>
      </div>
    </header>
    {preferences.error && <p role="alert">{preferences.error.message}</p>}
    <div className="flex flex-wrap gap-2" role="group" aria-label={t("inbox.filter")}>
      {([ ["all", "inbox.filter.all"], ["unassigned", "inbox.filter.attention"], ["assigned", "inbox.filter.filed"] ] as const).map(([value, labelKey]) =>
        <Button key={value} size="sm" variant={view === value ? "secondary" : "ghost"} aria-pressed={view === value} onClick={() => { setView(value); setOffset(0); }}>{t(labelKey)}</Button>)}
    </div>
    {progress.total > 0 && <div role="status" className="space-y-2">
      <div className="flex items-center justify-between gap-2"><span>{t("inbox.progress", { done: formatNumber(progress.done), total: formatNumber(progress.total) })}</span>
        {busy && <Button size="icon" variant="ghost" aria-label={t("inbox.stopAfterCurrent")} title={t("inbox.stopAfterCurrent")} onClick={() => { stop.current = true; }}><X className="h-4 w-4" /></Button>}</div>
      <Progress value={100 * progress.done / progress.total} aria-label={t("inbox.processingProgress")} />
      <p className="break-words text-sm">{current}</p>
    </div>}
    {errors.length > 0 && <div role="alert" className="space-y-1 border-l-2 border-destructive pl-3 text-sm">{errors.map((error, index) => <p className="break-words" key={index}>{error}</p>)}</div>}
    {query.isLoading && <p role="status">{t("inbox.loadingDocuments")}</p>}
    {query.error && <p role="alert">{query.error.message}</p>}
    {query.data?.items.length === 0 && <p className="py-8 text-muted-foreground">{t("inbox.empty")}</p>}
    <div className="divide-y">
      {query.data?.items.map((item) => <article key={item.id} className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1"><h3 className="break-all font-medium">{item.fileName}</h3>
            <p className="mt-1 break-words text-sm text-muted-foreground">{item.evidenceId ? item.caseTitle : t(item.error ? "inbox.status.analysisFailed" : item.analyzed ? "inbox.status.needsAttention" : "inbox.status.awaiting")}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="icon" variant="ghost" title={t("inbox.downloadOriginal")} aria-label={t("inbox.downloadNamed", { name: item.fileName })} disabled={download.isPending} onClick={() => void saveOriginal(item.id)}><Download className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" title={t("inbox.details")} aria-label={t("inbox.detailsNamed", { name: item.fileName })} aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? null : item.id)}><ChevronDown className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" title={t(item.analyzed ? "inbox.reanalyze" : "inbox.analyzeOrganize")} aria-label={t("inbox.processNamed", { name: item.fileName })} disabled={busy} onClick={() => void processOne(item.id)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}</Button>
            {item.caseId && <Button size="icon" variant="ghost" title={t("inbox.openTimeline")} aria-label={t("inbox.openCaseNamed", { name: item.fileName })} onClick={() => onOpenCase(item.caseId!)}><FolderOpen className="h-4 w-4" /></Button>}
          </div>
        </div>
        {item.error && <p className="break-words text-sm" role="alert">{item.error}</p>}
        {expanded === item.id && <InboxDetails id={item.id} refresh={refresh} />}
      </article>)}
    </div>
    {(query.data?.total || 0) > 20 && <div className="flex items-center gap-3">
      <Button size="icon" variant="outline" aria-label={t("inbox.previousDocuments")} title={t("inbox.previousDocuments")} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}><ChevronLeft className="h-4 w-4" /></Button>
      <span>{t("inbox.range", { start: formatNumber(offset + 1), end: formatNumber(Math.min(offset + 20, query.data?.total || 0)), total: formatNumber(query.data?.total || 0) })}</span>
      <Button size="icon" variant="outline" aria-label={t("inbox.nextDocuments")} title={t("inbox.nextDocuments")} disabled={offset + 20 >= (query.data?.total || 0)} onClick={() => setOffset(offset + 20)}><ChevronRight className="h-4 w-4" /></Button>
    </div>}
  </section>;
}
