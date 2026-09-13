import { useMemo, useState } from "react";
import { CircleHelp, History, Loader2, Pencil, Search } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Event = {
  eventKey: string; date: string; title: string; description: string; actor: string | null;
  source: { evidenceId: string; title: string; citation: { quote: string } | null };
};
type Correction = Record<string, unknown> & { id: string; createdAt: Date | null };
type Snapshot = { events: Event[]; corrections: Correction[]; revision: string };

function dateLabel(value: string) {
  const date = new Date(value + "T12:00:00");
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("nl-NL", { day: "numeric", month: "long", year: "numeric" });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function HistoryEntry({ item }: { item: Correction }) {
  const before = record(item.before);
  const after = record(item.after);
  return <details className="border-b border-border py-3 text-sm">
    <summary className="cursor-pointer break-words font-medium">{String(after.title || before.title || "Timeline correction")} <span className="font-normal text-muted-foreground">{item.createdAt ? new Date(item.createdAt).toLocaleString("nl-NL") : ""}</span></summary>
    <p className="mt-2 break-words">{String(item.reason || item.instruction || "")}</p>
    <div className="mt-3 grid gap-4 sm:grid-cols-2">
      {[{ label: "Before", value: before }, { label: "After", value: after }].map(({ label, value }) => <div key={label} className="min-w-0 space-y-1 break-words">
        <h4 className="font-medium">{label}</h4>
        <p>{String(value.date || "No event")} {String(value.actor || "")}</p>
        <p>{String(value.title || "")}</p><p className="text-muted-foreground">{String(value.description || "")}</p>
      </div>)}
    </div>
    <p className="mt-2 text-xs text-muted-foreground">{item.provider === "manual" ? "Edited by owner" : "Assistant-assisted correction"}</p>
  </details>;
}

export function TimelineEvents({ caseId, data, documentIds, onOpenSource, onUpdated }: {
  caseId: string; data: Snapshot; documentIds: Set<string>;
  onOpenSource: (id: string) => void; onUpdated: () => Promise<unknown>;
}) {
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(50);
  const [editing, setEditing] = useState<{ event: Event; revision: string } | null>(null);
  const [draft, setDraft] = useState({ date: "", actor: "", title: "", description: "", reason: "" });
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const update = trpc.documentAnalysis.updateTimelineEvent.useMutation();
  const events = useMemo(() => data.events.filter((event) => documentIds.has(event.source.evidenceId)
    && `${event.title} ${event.description} ${event.actor || ""} ${event.source.title} ${event.date}`.toLowerCase().includes(search.toLowerCase())), [data.events, documentIds, search]);
  const correctedKeys = new Set(data.corrections.map((item) => {
    const after = record(item.after);
    return `${after.date}|${String(after.title || "").trim().toLowerCase()}|${after.evidenceId}`;
  }));
  const edit = (event: Event) => {
    setEditing({ event, revision: data.revision });
    setDraft({ date: event.date, actor: event.actor || "", title: event.title, description: event.description, reason: "" });
    setSaveError("");
    setNotice("");
  };
  return <section className="min-w-0 space-y-4" aria-label="Chronological events">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">Events</h3><p className="text-xs text-muted-foreground">{events.length} source-linked events</p></div>
      <label className="relative w-full sm:w-72"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label="Search timeline events" className="pl-9" value={search} onChange={(event) => { setSearch(event.target.value); setLimit(50); }} placeholder="Search events, people or sources" /></label>
    </div>
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    {!events.length ? <p className="py-6 text-sm text-muted-foreground">{data.events.length ? "No events match these filters." : "No dated events yet. Documents remain available in the document views."}</p> : null}
    <ol className="divide-y divide-border border-y border-border">
      {events.slice(0, limit).map((event) => <li key={event.eventKey} className="grid min-w-0 gap-3 py-5 sm:grid-cols-[10rem_minmax(0,1fr)_auto]">
        <div><time className="text-sm font-semibold" dateTime={event.date}>{dateLabel(event.date)}</time><p className="mt-1 text-xs text-muted-foreground">{correctedKeys.has(event.eventKey) ? "Owner corrected" : "Source-linked"}</p></div>
        <div className="min-w-0 break-words">
          {event.actor ? <p className="mb-1 text-xs font-medium text-muted-foreground">{event.actor}</p> : null}
          <h4 className="text-sm font-semibold">{event.title}</h4>
          {event.description.trim() !== event.title.trim() ? <p className="mt-1 line-clamp-3 whitespace-pre-line text-sm leading-6 text-muted-foreground">{event.description}</p> : null}
          <details className="mt-2 text-xs text-muted-foreground"><summary className="cursor-pointer break-words">Details and source: {event.source.title}</summary>
            <p className="mt-2 whitespace-pre-line text-sm leading-6">{event.description}</p>
            {event.source.citation ? <blockquote className="mt-2 border-l-2 border-border pl-3 whitespace-pre-line">{event.source.citation.quote}</blockquote> : null}
          </details>
        </div>
        <div className="flex shrink-0 items-start gap-1">
          <Button size="icon" variant="outline" title="Open source document" aria-label={`Open source document for ${event.title}`} onClick={() => onOpenSource(event.source.evidenceId)}><CircleHelp className="h-4 w-4" /></Button>
          <Button size="sm" variant="outline" onClick={() => edit(event)} aria-label={`Correct event ${event.title}`}><Pencil className="mr-2 h-4 w-4" />Correct</Button>
        </div>
      </li>)}
    </ol>
    {events.length > limit ? <Button variant="outline" onClick={() => setLimit((value) => value + 50)}>Show more ({events.length - limit} remaining)</Button> : null}
    <details className="border-b border-border py-3">
      <summary className="cursor-pointer text-sm font-medium"><History className="mr-2 inline h-4 w-4" />Correction history ({data.corrections.length})</summary>
      {data.corrections.length ? [...data.corrections].reverse().map((item) => <HistoryEntry key={item.id} item={item} />) : <p className="py-3 text-sm text-muted-foreground">No corrections recorded.</p>}
    </details>
    <Dialog open={!!editing} onOpenChange={(open) => { if (!open && !update.isPending) setEditing(null); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Correct event</DialogTitle><DialogDescription>The original document stays unchanged. Your correction and reason are recorded in the history.</DialogDescription></DialogHeader>
        {editing ? <form className="min-w-0 space-y-4" onSubmit={async (event) => {
          event.preventDefault(); setSaveError("");
          try {
            await update.mutateAsync({ caseId, eventKey: editing.event.eventKey, revision: editing.revision, ...draft });
            setEditing(null); setNotice("Correction saved. Original source preserved.");
            await onUpdated();
          } catch (error) {
            setSaveError(error instanceof Error ? error.message : "The correction could not be saved.");
            await onUpdated();
          }
        }}>
          <div className="min-w-0 border-y border-border py-3 text-sm"><p className="break-words font-medium">{editing.event.title}</p><p className="text-muted-foreground">Current date: {dateLabel(editing.event.date)}</p><Button type="button" variant="link" className="h-auto max-w-full justify-start whitespace-normal p-0 text-left" onClick={() => onOpenSource(editing.event.source.evidenceId)}><CircleHelp className="mr-2 h-4 w-4 shrink-0" /><span className="min-w-0 break-all">{editing.event.source.title}</span></Button></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="min-w-0 space-y-1 text-sm">Event date<Input type="date" required value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label>
            <label className="min-w-0 space-y-1 text-sm">Who<Input maxLength={500} value={draft.actor} onChange={(event) => setDraft({ ...draft, actor: event.target.value })} /></label>
          </div>
          <label className="block space-y-1 text-sm">Event title<Input required maxLength={500} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <label className="block space-y-1 text-sm">What happened<Textarea required maxLength={10000} className="min-h-24" value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
          <label className="block space-y-1 text-sm">Reason for correction<Textarea required minLength={5} maxLength={2000} value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></label>
          {saveError ? <p role="alert" className="text-sm text-destructive">{saveError}</p> : null}
          <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={update.isPending} onClick={() => setEditing(null)}>Cancel</Button><Button disabled={update.isPending || draft.reason.trim().length < 5}>{update.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Pencil className="mr-2 h-4 w-4" />}Save correction</Button></div>
        </form> : null}
      </DialogContent>
    </Dialog>
  </section>;
}
