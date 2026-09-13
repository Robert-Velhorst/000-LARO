import { useId, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, Link2, RotateCcw, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { getElectronAPI } from "@/lib/electronApiShim";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

function Pages({ label, offset, step, more, disabled, change }: {
  label: string; offset: number; step: number; more?: boolean; disabled: boolean; change: (offset: number) => void;
}) {
  if (!offset && !more) return null;
  return <nav aria-label={`${label} pages`} className="flex items-center gap-2">
    <Button type="button" size="icon" variant="ghost" title={`Previous ${label}`} aria-label={`Previous ${label}`} disabled={!offset || disabled} onClick={() => change(Math.max(0, offset - step))}><ChevronLeft className="h-4 w-4" /></Button>
    <span className="text-xs">Page {1 + offset / step}</span>
    <Button type="button" size="icon" variant="ghost" title={`Next ${label}`} aria-label={`Next ${label}`} disabled={!more || disabled} onClick={() => change(offset + step)}><ChevronRight className="h-4 w-4" /></Button>
  </nav>;
}

export default function ActionExecutionEvidence({ actionId }: { actionId: string }) {
  const id = useId(); const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [offset, setOffset] = useState(0);
  const [sourceOffset, setSourceOffset] = useState(0);
  const [passageOffset, setPassageOffset] = useState(0);
  const [evidenceId, setEvidenceId] = useState("");
  const [citationIds, setCitationIds] = useState<string[]>([]);
  const [version, setVersion] = useState<{ analysisId: string; contentHash: string; analysisFingerprint: string } | null>(null);
  const [relation, setRelation] = useState<"supports" | "contradicts">("supports");
  const [note, setNote] = useState(""); const [error, setError] = useState("");
  const links = trpc.actionEvidence.list.useQuery({ actionId, offset }, { enabled: expanded, refetchInterval: expanded ? 10000 : false });
  const sources = trpc.actionEvidence.sources.useQuery({ actionId, offset: sourceOffset }, { enabled: expanded && adding });
  const passages = trpc.actionEvidence.passages.useQuery({ actionId, evidenceId, offset: passageOffset }, { enabled: expanded && adding && !!evidenceId });
  const link = trpc.actionEvidence.link.useMutation(); const state = trpc.actionEvidence.setState.useMutation();
  const download = trpc.evidenceFiles.getDownloadUrl.useMutation(); const opened = trpc.evidenceFiles.recordSourceOpened.useMutation();
  const clearSelection = () => { setCitationIds([]); setVersion(null); };
  const changed = !!version && version.analysisFingerprint !== passages.data?.analysisFingerprint;
  const failure = error || link.error?.message || state.error?.message || links.error?.message || (adding && (sources.error?.message || passages.error?.message));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!version || changed) return;
    try {
      await link.mutateAsync({ actionId, evidenceId, ...version, citationIds, relation, note: note.trim() });
      setAdding(false); setNote(""); clearSelection(); setOffset(0);
      await utils.actionEvidence.list.invalidate();
    } catch { /* Mutation error is rendered below. */ }
  };
  const setState = async (id: string, next: "active" | "withdrawn") => {
    try { await state.mutateAsync({ id, state: next }); await utils.actionEvidence.list.invalidate(); }
    catch { /* Mutation error is rendered below. */ }
  };
  const openSource = async (id: string) => {
    setError("");
    try {
      const result = await download.mutateAsync({ id });
      if (!result.url) throw new Error(result.message || "Source is unavailable");
      await getElectronAPI().openExternal(result.url);
      await opened.mutateAsync({ id });
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Source could not be opened"); }
  };
  const selectClass = "min-w-0 w-full rounded-md border border-input bg-background p-2 text-sm";

  return <details className="min-w-0 text-sm" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer py-1">Execution evidence</summary>
    {expanded && <section aria-label="Execution evidence links" className="min-w-0 space-y-3 py-2">
      <Button size="sm" variant="outline" aria-expanded={adding} onClick={() => { setAdding(!adding); setError(""); }}><Link2 className="mr-2 h-4 w-4" />Link evidence</Button>
      {failure && <p role="alert" className="break-words text-destructive">{failure}</p>}
      {adding && <form onSubmit={(event) => void submit(event)} className="min-w-0 space-y-3 border-y py-3">
        <div className="space-y-1"><Label htmlFor={`${id}-source`}>Evidence document</Label>
          <select id={`${id}-source`} className={selectClass} value={evidenceId} disabled={sources.isFetching || link.isPending}
            onChange={(event) => { setEvidenceId(event.target.value); setPassageOffset(0); clearSelection(); }}>
            <option value="">{sources.isFetching ? "Loading documents..." : "Select document"}</option>
            {sources.data?.items.map((source) => <option key={source.evidenceId} value={source.evidenceId}>{source.title}</option>)}
          </select>
        </div>
        {sources.data?.items.length === 0 && <p>No analyzed documents in this case.</p>}
        <Pages label="documents" offset={sourceOffset} step={10} more={sources.data?.hasMore} disabled={sources.isFetching || link.isPending}
          change={(next) => { setSourceOffset(next); setEvidenceId(""); setPassageOffset(0); clearSelection(); }} />
        {evidenceId && <fieldset disabled={link.isPending} className="min-w-0 space-y-2">
          <legend className="mb-2 font-medium">Source passages ({citationIds.length}/10)</legend>
          {passages.isFetching && <p role="status">Loading passages...</p>}
          {passages.data?.items.length === 0 && <p>No source passages in this analysis.</p>}
          {passages.data?.items.map((quote) => <label key={quote.id} className="flex min-w-0 items-start gap-2">
            <input type="checkbox" className="mt-1 shrink-0" checked={citationIds.includes(quote.id)} disabled={!citationIds.includes(quote.id) && citationIds.length >= 10}
              onChange={(event) => {
                if (!passages.data) return;
                const ids = event.target.checked ? [...citationIds, quote.id] : citationIds.filter((id) => id !== quote.id);
                setCitationIds(ids);
                if (!ids.length) setVersion(null);
                else if (!version) setVersion({ analysisId: passages.data.analysisId, contentHash: passages.data.contentHash, analysisFingerprint: passages.data.analysisFingerprint });
              }} />
            <span className="min-w-0 whitespace-pre-wrap break-words"><span className="text-xs text-muted-foreground">Lines {quote.lineStart}-{quote.lineEnd}: </span>{quote.quote}</span>
          </label>)}
          <Pages label="passages" offset={passageOffset} step={30} more={passages.data?.hasMore} disabled={passages.isFetching || link.isPending}
            change={(next) => { setPassageOffset(next); clearSelection(); }} />
        </fieldset>}
        {changed && <p role="alert">Analysis changed. <button type="button" className="underline" onClick={clearSelection}>Clear selection</button></p>}
        <div className="space-y-1"><Label htmlFor={`${id}-relation`}>Relationship</Label>
          <select id={`${id}-relation`} className={selectClass} value={relation} onChange={(event) => setRelation(event.target.value as typeof relation)} disabled={link.isPending}>
            <option value="supports">Supports execution</option><option value="contradicts">Contradicts execution</option>
          </select>
        </div>
        <div className="space-y-1"><Label htmlFor={`${id}-note`}>Assessment</Label><Textarea id={`${id}-note`} required maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} disabled={link.isPending} /></div>
        <Button type="submit" size="sm" disabled={link.isPending || !citationIds.length || !note.trim() || changed || passages.isFetching || !!passages.error}>Save evidence link</Button>
      </form>}
      {links.isLoading && <p role="status">Loading linked evidence...</p>}
      {links.data?.items.length === 0 && <p className="text-muted-foreground">No execution evidence linked.</p>}
      <ul className="min-w-0 divide-y">{links.data?.items.map((item) => <li key={item.id} className="min-w-0 space-y-2 py-3">
        <div className="flex items-start justify-between gap-2"><div className="min-w-0">
          <p className="font-medium">{item.relation === "supports" ? "Supports execution" : "Contradicts execution"}</p>
          <p className="break-words">{item.snapshot.title}</p>
        </div><div className="flex shrink-0 gap-1">
          <Button size="icon" variant="ghost" title="Open linked document" aria-label="Open execution source" disabled={!item.sourceAvailable || download.isPending} onClick={() => void openSource(item.snapshot.evidenceId)}><CircleHelp className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" title={item.state === "active" ? "Withdraw evidence link" : "Restore evidence link"}
            aria-label={item.state === "active" ? "Withdraw evidence link" : "Restore evidence link"} disabled={state.isPending}
            onClick={() => void setState(item.id, item.state === "active" ? "withdrawn" : "active")}>
            {item.state === "active" ? <X className="h-4 w-4" /> : <RotateCcw className="h-4 w-4" />}
          </Button>
        </div></div>
        {item.state === "withdrawn" && <p className="font-medium">Withdrawn</p>}
        <p className="text-xs text-muted-foreground">User assessment; not independently verified</p>
        <p className="whitespace-pre-wrap break-words">{item.note}</p>
        <details><summary className="cursor-pointer">Source passages</summary>
          {item.snapshot.quotes.map((quote) => <blockquote key={quote.id} className="my-2 whitespace-pre-wrap break-words border-l-2 pl-3"><span className="text-xs text-muted-foreground">Lines {quote.lineStart}-{quote.lineEnd}: </span>{quote.quote}</blockquote>)}
          <p className="break-all font-mono text-xs">SHA-256: {item.snapshot.contentHash}</p>
        </details>
        {!item.sourceAvailable && <p role="status">Original document is no longer available in this case.</p>}
        <p className="text-xs text-muted-foreground">Recorded: {new Date(item.createdAt).toLocaleString()}</p>
      </li>)}</ul>
      <Pages label="evidence links" offset={offset} step={25} more={links.data?.hasMore} disabled={links.isFetching} change={setOffset} />
    </section>}
  </details>;
}
