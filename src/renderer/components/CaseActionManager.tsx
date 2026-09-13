import { useId, useState, type FormEvent } from "react";
import { Check, ChevronLeft, ChevronRight, Plus, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import SuggestedActions, { ActionSource } from "./SuggestedActions";
import ActionExecutionEvidence from "./ActionExecutionEvidence";

const PAGE_SIZE = 20;

export default function CaseActionManager({ caseId }: { caseId: string }) {
  const id = useId();
  const utils = trpc.useUtils();
  const [completed, setCompleted] = useState(false);
  const [page, setPage] = useState(0);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const actions = trpc.caseManagement.getUpcomingDeadlines.useQuery({ caseId, completed, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const refresh = () => utils.caseManagement.getUpcomingDeadlines.invalidate();
  const add = trpc.caseManagement.addDeadline.useMutation({
    onSuccess: () => {
      setTitle(""); setDescription(""); setDueDate(""); setAdding(false); setCompleted(false); setPage(0);
      void refresh();
    },
    onError: (failure) => setError(failure.message),
  });
  const update = trpc.caseManagement.completeDeadline.useMutation({
    onSuccess: (result) => {
      if (!result.ok) { setError("This action is no longer available."); void refresh(); return; }
      if (actions.data?.length === 1 && page > 0) setPage(page - 1);
      void refresh();
    },
    onError: (failure) => setError(failure.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    add.mutate({ caseId, title: title.trim(), description: description.trim() || undefined,
      dueDate: dueDate ? `${dueDate}T12:00:00.000Z` : null });
  };
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <section aria-label="Actions and deadlines" className="min-w-0 space-y-3 border-t border-border py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Actions and deadlines</h3>
        <Button size="sm" variant="outline" onClick={() => { setError(null); setAdding(!adding); }} aria-expanded={adding}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />Add action
        </Button>
      </div>
      <div className="flex gap-1" role="group" aria-label="Action status">
        {[false, true].map((value) => (
          <Button key={String(value)} size="sm" variant={completed === value ? "secondary" : "ghost"}
            aria-pressed={completed === value} onClick={() => { setCompleted(value); setPage(0); }}>
            {value ? "Completed" : "Open"}
          </Button>
        ))}
      </div>
      {adding && (
        <form onSubmit={submit} className="grid min-w-0 gap-3 border-y border-border py-4">
          <div className="space-y-1">
            <Label htmlFor={`${id}-title`}>Action</Label>
            <Input id={`${id}-title`} required maxLength={500} value={title} onChange={(event) => setTitle(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-date`}>Due date (optional)</Label>
            <Input id={`${id}-date`} type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} className="max-w-xs" />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${id}-description`}>Notes (optional)</Label>
            <Textarea id={`${id}-description`} maxLength={10000} value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={add.isLoading || !title.trim()}>{add.isLoading ? "Saving..." : "Save action"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={add.isLoading}>Cancel</Button>
          </div>
        </form>
      )}
      {(error || actions.error) && <p role="alert" className="text-sm text-destructive">{error || actions.error?.message}</p>}
      {actions.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading actions...</p> : (
        <ul className="divide-y divide-border">
          {(actions.data || []).map((action) => {
            const day = action.dueDate ? new Date(action.dueDate).toISOString().slice(0, 10) : null;
            const overdue = !completed && day !== null && day < todayKey;
            return (
              <li key={action.id} className="flex min-w-0 items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="break-words text-sm font-medium">{action.title}</p>
                  {action.description && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{action.description}</p>}
                  <ActionSource actionId={action.id} />
                  <ActionExecutionEvidence actionId={action.id} />
                  <p className={`text-xs ${overdue ? "text-destructive" : "text-muted-foreground"}`}>
                    {day ? `${overdue ? "Overdue: " : "Due: "}${day}` : "No due date"}
                    {completed && action.updatedAt ? ` | Completed: ${new Date(action.updatedAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
                <Button size="icon" variant="outline" className="shrink-0" disabled={update.isLoading}
                  title={completed ? "Reopen action" : "Mark complete"} aria-label={`${completed ? "Reopen" : "Complete"}: ${action.title}`}
                  onClick={() => { setError(null); update.mutate({ id: action.id, completed: !completed }); }}>
                  {completed ? <RotateCcw className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {!actions.isLoading && !actions.error && actions.data?.length === 0 && <p className="text-sm text-muted-foreground">{completed ? "No completed actions." : "No open actions."}</p>}
      {(page > 0 || actions.data?.length === PAGE_SIZE) && <nav aria-label="Action pages" className="flex items-center gap-3">
        <Button size="icon" variant="outline" aria-label="Previous action page" title="Previous page" disabled={page === 0 || actions.isFetching} onClick={() => setPage(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
        <span className="text-sm">Page {page + 1}</span>
        <Button size="icon" variant="outline" aria-label="Next action page" title="Next page" disabled={actions.data?.length !== PAGE_SIZE || actions.isFetching} onClick={() => setPage(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
      </nav>}
      <SuggestedActions caseId={caseId} />
    </section>
  );
}
