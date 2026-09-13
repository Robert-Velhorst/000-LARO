import { useState, type ReactNode } from "react";
import { AlertCircle, Check, ChevronDown, ChevronLeft, ChevronRight, FolderOpen, RefreshCw, type LucideIcon } from "lucide-react";
import { useI18n } from "@/contexts/I18nContext";
import { trpc } from "@/lib/trpc";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function PageHeading({ title, actions }: { title: string; actions?: ReactNode }) {
  return <header className="workspace-heading"><h1>{title}</h1>{actions && <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div>}</header>;
}

export function QueryNotice({ error, retry }: { error: { message: string }; retry?: () => unknown }) {
  const { t, locale } = useI18n();
  return <div role="alert" className="flex flex-wrap items-start gap-3 border-l-2 border-destructive bg-destructive/5 p-4 text-sm">
    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
    <div className="min-w-0 flex-1"><p className="font-medium">{locale === "nl" ? "Gegevens konden niet worden geladen" : "Could not load data"}</p><p className="mt-1 break-words text-muted-foreground">{error.message}</p></div>
    {retry && <Button variant="outline" size="sm" onClick={() => void retry()}><RefreshCw className="h-4 w-4" />{t("common.retry")}</Button>}
  </div>;
}

export function SectionNavigation({ label, items, value, onChange }: {
  label: string; items: Array<{ id: string; label: string; icon?: LucideIcon }>;
  value: string; onChange: (id: string) => void;
}) {
  return <nav aria-label={label} className="border-b border-border">
    <label className="block pb-3 text-sm sm:hidden"><span className="sr-only">{label}</span>
      <select className="min-h-10 w-full rounded-md border border-input bg-background px-3" value={value} onChange={event => onChange(event.target.value)}>
        {items.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
    </label>
    <div className="hidden flex-wrap gap-x-5 gap-y-1 sm:flex">
      {items.map(item => <button key={item.id} type="button" aria-current={value === item.id ? "page" : undefined}
        onClick={() => onChange(item.id)} className={`flex min-h-11 items-center gap-2 border-b-2 px-1 text-sm ${value === item.id ? "border-primary font-medium text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
        {item.icon && <item.icon className="h-4 w-4" />}{item.label}
      </button>)}
    </div>
  </nav>;
}

export function CasePicker({ value, onChange, disabled = false, requireSelection = false, emptyLabel: customEmptyLabel }: { value: string | null; onChange: (id: string | null) => void; disabled?: boolean; requireSelection?: boolean; emptyLabel?: string }) {
  const { locale, t } = useI18n();
  const nl = locale === "nl";
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const query = trpc.cases.list.useQuery({ page, limit: 10, search }, { enabled: open });
  const selected = trpc.cases.byId.useQuery(value || "", { enabled: !!value });
  const choose = (id: string | null) => { onChange(id); setOpen(false); };
  const emptyLabel = customEmptyLabel || (requireSelection ? (nl ? "Dossier kiezen" : "Select a case") : (nl ? "Alle dossiers" : "All cases"));
  const label = value ? selected.data?.clientName || selected.data?.caseType || (selected.isLoading ? t("common.loading") : nl ? "Dossier niet beschikbaar" : "Case unavailable") : emptyLabel;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button disabled={disabled} variant="outline" aria-label={nl ? `Dossier: ${label}` : `Case: ${label}`} className="max-w-full sm:max-w-sm">
      <FolderOpen className="h-4 w-4" /><span className="truncate">{label}</span><ChevronDown className="h-4 w-4" />
    </Button></PopoverTrigger>
    <PopoverContent align="end" className="w-[min(360px,calc(100vw-2rem))] space-y-3">
      <label className="block text-sm">{nl ? "Dossier zoeken" : "Find a case"}
        <input autoFocus value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} className="mt-1 min-h-10 w-full rounded-md border border-input bg-background px-3" />
      </label>
      {!requireSelection && <Button variant="ghost" className="w-full justify-start" onClick={() => choose(null)}>{emptyLabel}</Button>}
      {query.isLoading && <p role="status" className="text-sm">{t("common.loading")}</p>}
      {query.error && <QueryNotice error={query.error} retry={query.refetch} />}
      <div className="max-h-64 overflow-y-auto">
        {query.data?.cases.map(row => <Button key={row.id} variant="ghost" className="w-full justify-start text-left" onClick={() => choose(row.id)}>
          <span className="min-w-0 flex-1 break-words">{row.clientName || row.caseType || row.id}</span>{row.id === value && <Check className="h-4 w-4" />}
        </Button>)}
        {query.data?.cases.length === 0 && <p className="py-4 text-sm text-muted-foreground">{nl ? "Geen dossiers gevonden" : "No cases found"}</p>}
      </div>
      {(query.data?.pagination.totalPages ?? 0) > 1 && <div className="flex items-center justify-between border-t border-border pt-3 text-sm">
        <Button variant="ghost" size="icon" aria-label={nl ? "Vorige dossiers" : "Previous cases"} disabled={page === 1 || query.isFetching} onClick={() => setPage(page - 1)}><ChevronLeft /></Button>
        <span>{page} / {query.data?.pagination.totalPages}</span>
        <Button variant="ghost" size="icon" aria-label={nl ? "Volgende dossiers" : "Next cases"} disabled={query.isFetching || page >= (query.data?.pagination.totalPages ?? 0)} onClick={() => setPage(page + 1)}><ChevronRight /></Button>
      </div>}
    </PopoverContent>
  </Popover>;
}
