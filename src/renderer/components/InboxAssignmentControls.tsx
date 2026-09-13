import { useState } from "react";
import { ArrowRightLeft, ChevronLeft, ChevronRight, History } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

export default function InboxAssignmentControls({ id, assignment, refresh }: {
  id: string; assignment: { caseId: string; title: string | null; version: string } | null; refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const correction = trpc.documentInbox.reassign.useMutation();
  const choices = trpc.cases.list.useQuery({ page, limit: 10, search }, { enabled: open && Boolean(assignment) });
  const history = trpc.documentInbox.assignmentHistory.useQuery({ id, offset: historyOffset }, { enabled: historyOpen });
  const save = async () => {
    if (!assignment || !target || !reason.trim()) return;
    try {
      await correction.mutateAsync({ id, caseId: target, expectedVersion: assignment.version, reason });
      await refresh();
      setTarget(""); setReason(""); setHistoryOffset(0); setHistoryOpen(true); setOpen(false);
    } catch { /* The mutation keeps a visible error and does not discard the draft. */ }
  };
  return <section aria-label="Dossier assignment" className="space-y-3">
    {assignment && <>
      <p className="break-words font-medium">Current dossier: {assignment.title || assignment.caseId}</p>
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}><ArrowRightLeft className="mr-2 h-4 w-4" />Correct dossier</Button>
      {open && <div className="space-y-3 border-l-2 pl-3">
        <label className="block">Find target dossier<input value={search} className="mt-1 w-full rounded border bg-background p-2"
          onChange={(event) => { setSearch(event.target.value); setPage(1); setTarget(""); }} /></label>
        {choices.isLoading && <p role="status">Loading dossiers...</p>}
        {choices.error && <p role="alert">{choices.error.message}</p>}
        <label className="block">Target dossier<select value={target} className="mt-1 w-full min-w-0 rounded border bg-background p-2"
          onChange={(event) => setTarget(event.target.value)}>
          <option value="">Select a dossier</option>
          {choices.data?.cases.filter((row) => row.id !== assignment.caseId).map((row) => <option key={row.id} value={row.id}>{row.clientName || row.caseType || row.id}</option>)}
        </select></label>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="icon" variant="outline" title="Previous target dossiers" aria-label="Previous target dossiers" disabled={page === 1}
            onClick={() => { setPage(page - 1); setTarget(""); }}><ChevronLeft className="h-4 w-4" /></Button>
          <span>{page} / {Math.max(1, choices.data?.pagination.totalPages || 0)}</span>
          <Button size="icon" variant="outline" title="Next target dossiers" aria-label="Next target dossiers" disabled={page >= (choices.data?.pagination.totalPages || 0)}
            onClick={() => { setPage(page + 1); setTarget(""); }}><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <label className="block">Correction reason<textarea value={reason} maxLength={1500} rows={3}
          className="mt-1 w-full rounded border bg-background p-2" onChange={(event) => setReason(event.target.value)} /></label>
        <Button disabled={!target || !reason.trim() || correction.isPending} onClick={() => void save()}><ArrowRightLeft className="mr-2 h-4 w-4" />Move document</Button>
        {correction.error && <p role="alert">{correction.error.message}</p>}
      </div>}
    </>}
    <div>
      <Button size="sm" variant="ghost" aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}><History className="mr-2 h-4 w-4" />Correction history</Button>
      {historyOpen && <div className="mt-2 space-y-3">
        {history.isLoading && <p role="status">Loading corrections...</p>}
        {history.error && <p role="alert">{history.error.message}</p>}
        {history.data?.items.length === 0 && <p>No recorded corrections.</p>}
        <ol className="space-y-3">{history.data?.items.map((item) => <li key={item.id} className="space-y-1 border-l-2 pl-3">
          <p className="break-words">{item.from?.title || item.from?.caseId || "Unknown dossier"} to {item.to?.title || item.to?.caseId || "Unknown dossier"}</p>
          <p className="whitespace-pre-wrap break-words">{item.reason}</p>
          <p className="text-xs text-muted-foreground">{item.recordedAt ? new Date(item.recordedAt).toLocaleString() : "Unknown date"} | Owner correction</p>
        </li>)}</ol>
        <div className="flex items-center gap-2">
          <Button size="icon" variant="outline" title="Previous corrections" aria-label="Previous corrections" disabled={historyOffset === 0}
            onClick={() => setHistoryOffset(Math.max(0, historyOffset - 10))}><ChevronLeft className="h-4 w-4" /></Button>
          <span>{historyOffset / 10 + 1}</span>
          <Button size="icon" variant="outline" title="Next corrections" aria-label="Next corrections" disabled={!history.data?.hasMore}
            onClick={() => setHistoryOffset(historyOffset + 10)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      </div>}
    </div>
  </section>;
}
