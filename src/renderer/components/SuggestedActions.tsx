import { useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, RotateCcw, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { getElectronAPI } from "@/lib/electronApiShim";
import type { ActionProposal } from "../../../server/actionProposals";

function SourceProof({ proposal }: { proposal: ActionProposal & { sourceAvailable?: boolean } }) {
  const download = trpc.evidenceFiles.getDownloadUrl.useMutation();
  const opened = trpc.evidenceFiles.recordSourceOpened.useMutation();
  const [error, setError] = useState("");
  const open = async () => {
    setError("");
    try {
      const result = await download.mutateAsync({ id: proposal.source.evidenceId });
      if (!result.url) throw new Error(result.message || "Source is unavailable");
      await getElectronAPI().openExternal(result.url);
      await opened.mutateAsync({ id: proposal.source.evidenceId });
    } catch (error) { setError(error instanceof Error ? error.message : "Source could not be opened"); }
  };
  return <div className="min-w-0 space-y-3 py-3 text-sm">
    <div className="flex items-start justify-between gap-2"><p className="min-w-0 break-words font-medium">{proposal.source.title}</p>
      <Button size="icon" variant="outline" className="shrink-0" title="Open source document" aria-label="Open action source" disabled={proposal.sourceAvailable === false || download.isPending} onClick={() => void open()}><CircleHelp className="h-4 w-4" /></Button></div>
    {proposal.sourceAvailable === false && <p role="status">Original document is no longer available in this case.</p>}
    <ul className="space-y-2">{proposal.uncertainty.map((message) => <li key={message} className="break-words text-muted-foreground">{message}</li>)}</ul>
    {proposal.mentionedParties.length > 0 && <p className="break-words">Mentioned parties: {proposal.mentionedParties.join(", ")}</p>}
    {proposal.dateMentions.length > 0 && <p className="break-words">Dates mentioned: {proposal.dateMentions.join(", ")}</p>}
    {proposal.quotes.map((quote) => <blockquote key={quote.id} className="whitespace-pre-wrap break-words border-l-2 pl-3"><p className="text-xs text-muted-foreground">Lines {quote.lineStart}-{quote.lineEnd}</p>{quote.quote}</blockquote>)}
    <p className="break-all font-mono text-xs text-muted-foreground">SHA-256: {proposal.source.contentHash}</p>
    {error && <p role="alert" className="break-words">{error}</p>}
  </div>;
}

export function ActionSource({ actionId }: { actionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const query = trpc.actionProposals.forAction.useQuery({ actionId }, { enabled: expanded });
  return <details className="text-sm" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary className="cursor-pointer py-1">Action source</summary>
    {query.isLoading ? <p role="status">Loading source...</p> : query.error ? <p role="alert">{query.error.message}</p>
      : query.data ? <SourceProof proposal={query.data} /> : <p>No imported source linked.</p>}
  </details>;
}

export default function SuggestedActions({ caseId }: { caseId: string }) {
  const [offset, setOffset] = useState(0);
  const [visible, setVisible] = useState(5);
  const query = trpc.actionProposals.list.useQuery({ caseId, offset }, { refetchInterval: 10000 });
  const decision = trpc.actionProposals.decide.useMutation();
  const utils = trpc.useUtils();
  const decide = async (proposal: ActionProposal, action: "accept" | "dismiss" | "restore") => {
    try {
      await decision.mutateAsync({ caseId, evidenceId: proposal.source.evidenceId, proposalId: proposal.id, decision: action });
      await Promise.all([utils.actionProposals.invalidate(), utils.caseManagement.getUpcomingDeadlines.invalidate()]);
    } catch { /* The mutation error remains visible. */ }
  };
  return <section aria-label="Suggested actions" className="min-w-0 space-y-3 border-t pt-4">
    <h4 className="text-sm font-semibold">Suggested actions</h4>
    {(query.error || decision.error) && <p role="alert" className="break-words text-sm">{query.error?.message || decision.error?.message}</p>}
    {query.isLoading && <p role="status">Loading proposals...</p>}
    {query.data?.warnings.map((warning) => <p key={warning} role="status" className="break-words text-sm">{warning}</p>)}
    {query.data?.items.length === 0 && <p className="text-sm text-muted-foreground">No cited action proposals in these document analyses.</p>}
    <ul className="min-w-0 divide-y">{query.data?.items.slice(0, visible).map((proposal) => <li key={proposal.id} className="min-w-0 space-y-2 py-3">
      <div className="flex items-start justify-between gap-3"><p className="min-w-0 break-words text-sm font-medium">{proposal.title}</p>
        <div className="flex shrink-0 gap-1">{proposal.state === "proposed" ? <>
          <Button size="icon" variant="outline" title="Accept proposal as an open action" aria-label="Accept proposal" disabled={decision.isPending} onClick={() => void decide(proposal, "accept")}><Check className="h-4 w-4" /></Button>
          <Button size="icon" variant="ghost" title="Dismiss proposal" aria-label="Dismiss proposal" disabled={decision.isPending} onClick={() => void decide(proposal, "dismiss")}><X className="h-4 w-4" /></Button>
        </> : proposal.state === "dismissed" && <Button size="icon" variant="outline" title="Restore proposal" aria-label="Restore proposal" disabled={decision.isPending} onClick={() => void decide(proposal, "restore")}><RotateCcw className="h-4 w-4" /></Button>}</div>
      </div>
      <p className="text-xs text-muted-foreground">{proposal.state === "accepted" ? "Accepted" : proposal.state === "dismissed" ? "Dismissed" : "Proposal; not an established obligation"}</p>
      <details><summary className="cursor-pointer text-sm">Supporting passages</summary><SourceProof proposal={proposal} /></details>
    </li>)}</ul>
    {(query.data?.items.length || 0) > visible && <Button size="sm" variant="ghost" onClick={() => setVisible(visible + 10)}><ChevronDown className="mr-2 h-4 w-4" />More proposals</Button>}
    {(offset > 0 || query.data?.hasMore) && <nav aria-label="Proposal document pages" className="flex flex-wrap items-center gap-2 text-sm">
      <Button size="icon" variant="outline" title="Previous document analyses" aria-label="Previous proposal documents" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - 10)); setVisible(5); }}><ChevronLeft className="h-4 w-4" /></Button>
      <span>Document analyses {offset + 1}-{offset + (query.data?.documentsReviewed || 0)}</span>
      <Button size="icon" variant="outline" title="Next document analyses" aria-label="Next proposal documents" disabled={!query.data?.hasMore} onClick={() => { setOffset(offset + 10); setVisible(5); }}><ChevronRight className="h-4 w-4" /></Button>
    </nav>}
  </section>;
}
