import { useState } from "react";
import { FileText, Plus, Save, Search, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useI18n } from "@/contexts/I18nContext";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { CasePicker, QueryNotice } from "./WorkspaceUi";

export default function CommunicationHub({ caseId }: { caseId?: string }) {
  const { locale, t, formatDate } = useI18n();
  const nl = locale === "nl";
  const query = trpc.messages.list.useQuery(caseId ? { caseId } : undefined);
  const templates = trpc.messageTemplates.list.useQuery();
  const [composing, setComposing] = useState(false);
  const [messageContent, setMessageContent] = useState("");
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<string | null>(null);
  const save = trpc.messages.send.useMutation({
    onSuccess: async () => {
      await query.refetch();
      setMessageContent("");
      setComposing(false);
      toast.success(nl ? "Notitie opgeslagen. Geen e-mail verzonden." : "Note saved. No email was sent.");
    },
    onError: error => toast.error(error.message),
  });
  const replaceDraft = (content: string) => {
    if (messageContent.trim()) setReplacement(content);
    else setMessageContent(content);
  };
  const visible = query.data?.filter(item => (item.content || "").toLowerCase().includes(search.toLowerCase()) || item.caseId?.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="relative w-full max-w-md"><span className="sr-only">{nl ? "Notities zoeken" : "Search case notes"}</span><Search className="absolute left-3 top-2 h-4 w-4 text-muted-foreground" />
        <Input value={search} onChange={event => setSearch(event.target.value)} className="pl-9" placeholder={nl ? "Notities zoeken" : "Search saved notes"} />
      </label>
      <Button onClick={() => setComposing(true)}><Plus className="h-4 w-4" />{nl ? "Nieuwe notitie" : "New note"}</Button>
    </div>
    {composing && <section className="space-y-4 rounded-md border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{nl ? "Nieuwe dossiernotitie" : "New Case Note"}</h2><Button size="icon" variant="ghost" aria-label={t("common.close")} title={t("common.close")} onClick={() => setComposing(false)}><X className="h-4 w-4" /></Button></div>
      {!!templates.data?.length && <label className="block text-sm">{nl ? "Sjabloon" : "Template"}<select value="" className="ml-2 max-w-full rounded-md border border-input bg-background p-2" onChange={event => {
        const item = templates.data?.find(row => row.id === event.target.value); if (item) replaceDraft(item.body || "");
      }}><option value="">{nl ? "Sjabloon kiezen" : "Choose a template"}</option>{templates.data.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      {templates.error && <QueryNotice error={templates.error} retry={templates.refetch} />}
      <label className="block text-sm">{nl ? "Notitie" : "Note"}<Textarea className="mt-2" aria-label="Case note message" value={messageContent} onChange={event => setMessageContent(event.target.value)} rows={8} /></label>
      {!caseId && <CasePicker value={selectedCaseId} onChange={setSelectedCaseId} disabled={save.isPending} emptyLabel={nl ? "Zonder dossier" : "No case assigned"} />}
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-muted-foreground">{nl ? "Alleen opgeslagen in LARO. Geen e-mail." : "Saved in LARO only. Not an email."}</p>
        <Button disabled={!messageContent.trim() || save.isPending} onClick={() => save.mutate({ body: messageContent, caseId: caseId || selectedCaseId || undefined })}><Save className="h-4 w-4" />{save.isPending ? (nl ? "Opslaan..." : "Saving...") : (nl ? "Notitie opslaan" : "Save Note")}</Button>
      </div>
    </section>}
    {query.error ? <QueryNotice error={query.error} retry={query.refetch} /> : query.isLoading ? <p role="status" className="py-8 text-sm">{t("common.loading")}</p> : <div className="divide-y divide-border border-y border-border">
      {visible.map(item => <article key={item.id} className="space-y-3 py-4">
        <header className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-medium">{nl ? "Dossiernotitie" : "Case note"}</h2><span className="text-xs text-muted-foreground">{item.createdAt ? formatDate(item.createdAt, { dateStyle: "medium", timeStyle: "short" }) : nl ? "Datum onbekend" : "Date not recorded"}</span></header>
        <p className={`whitespace-pre-wrap break-words text-sm leading-6 ${expanded === item.id ? "" : "line-clamp-3"}`}>{item.content}</p>
        <Button variant="ghost" size="sm" aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? null : item.id)}>{expanded === item.id ? (nl ? "Inklappen" : "Collapse note") : (nl ? "Volledige notitie" : "Read full note")}</Button>
      </article>)}
      {!visible.length && <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"><FileText className="h-8 w-8" />{nl ? "Geen notities gevonden." : "No case notes found"}</div>}
    </div>}
    <Dialog open={replacement !== null} onOpenChange={open => { if (!open) setReplacement(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{nl ? "Huidige tekst vervangen?" : "Replace the current draft?"}</DialogTitle></DialogHeader>
        <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setReplacement(null)}>{t("common.cancel")}</Button><Button onClick={() => { setMessageContent(replacement || ""); setReplacement(null); }}>{nl ? "Vervangen" : "Replace draft"}</Button></div>
      </DialogContent>
    </Dialog>
  </div>;
}

