import { useEffect, useState } from "react";
import { Briefcase, File, FileText, Loader2, MessageSquare, Scale, Search } from "lucide-react";
import { useLocation } from "wouter";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { useI18n } from "@/contexts/I18nContext";
import { getSearchDestination, type SearchResultType } from "../../../shared/globalSearch";

const RESULT_ICONS = {
  case: Briefcase,
  lawyer: Scale,
  evidence: FileText,
  document: File,
  communication: MessageSquare,
} satisfies Record<SearchResultType, typeof Search>;

export default function GlobalSearch() {
  const { locale } = useI18n();
  const nl = locale === "nl";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [, setLocation] = useLocation();
  const normalizedQuery = query.trim();
  const results = trpc.search.global.useQuery(
    { query: normalizedQuery, limit: 20 },
    { enabled: open && normalizedQuery.length >= 2, keepPreviousData: false },
  );

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, []);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  const activate = (result: { type: SearchResultType; id: string }) => {
    const destination = getSearchDestination(result);
    if (!destination) return;
    changeOpen(false);
    setLocation(destination);
  };

  return <>
    <Button type="button" variant="outline" onClick={() => setOpen(true)}
      aria-label={nl ? "Zoeken in LARO" : "Search LARO"} title={nl ? "Zoeken in LARO (Ctrl+K)" : "Search LARO (Ctrl+K)"}
      className="h-9 min-w-9 gap-2 px-2 sm:px-3">
      <Search className="h-4 w-4" aria-hidden="true" />
      <span className="hidden lg:inline">{nl ? "Zoeken" : "Search"}</span>
      <kbd className="hidden rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground xl:inline">Ctrl K</kbd>
    </Button>

    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="flex max-h-[min(80dvh,44rem)] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{nl ? "Zoeken" : "Search LARO"}</DialogTitle>
          <DialogDescription>{nl ? "Zoek in dossiers, advocaten, bewijsstukken, documenten en communicatie." : "Search cases, lawyers, evidence, documents, and communications."}</DialogDescription>
        </DialogHeader>
        <label className="relative block">
          <span className="sr-only">{nl ? "Zoekterm" : "Search query"}</span>
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input value={query} onChange={event => setQuery(event.target.value)} autoFocus className="pl-9"
            aria-label={nl ? "Zoekterm" : "Search query"} placeholder={nl ? "Typ om te zoeken..." : "Type to search..."} />
        </label>

        <div className="min-h-48 flex-1 overflow-y-auto" aria-live="polite">
          {results.isFetching && normalizedQuery.length >= 2 && <div role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />{nl ? "Zoeken..." : "Searching..."}
          </div>}
          {results.error && !results.isFetching && <div role="alert" className="py-10 text-center">
            <p className="font-medium">{nl ? "Zoeken is tijdelijk niet beschikbaar" : "Search is temporarily unavailable"}</p>
            <Button type="button" variant="outline" className="mt-3" onClick={() => void results.refetch()}>{nl ? "Opnieuw proberen" : "Retry"}</Button>
          </div>}
          {!results.isFetching && !results.error && normalizedQuery.length >= 2 && results.data?.results.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">
            {nl ? "Geen resultaten gevonden." : "No results found."}
          </p>}
          {!results.isFetching && !results.error && normalizedQuery.length >= 2 && !!results.data?.results.length && <div className="space-y-2 py-3">
            {results.data.results.map(result => {
              const Icon = RESULT_ICONS[result.type];
              return <button type="button" key={`${result.type}-${result.id}`} onClick={() => activate(result)}
                className={cn("w-full rounded-md border border-border p-4 text-left transition-colors hover:bg-muted/50", "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}>
                <span className="flex items-start gap-3">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-medium">{result.title}</span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">{result.type}</span>
                    </span>
                    <span className="mt-1 line-clamp-2 block break-words text-sm text-muted-foreground">{result.description}</span>
                  </span>
                </span>
              </button>;
            })}
          </div>}
          {normalizedQuery.length < 2 && <p className="py-12 text-center text-sm text-muted-foreground">{nl ? "Typ ten minste 2 tekens." : "Type at least 2 characters."}</p>}
        </div>
        <p className="border-t border-border pt-3 text-xs text-muted-foreground">{nl ? "Sneltoets: Ctrl/⌘ K" : "Shortcut: Ctrl/⌘ K"}</p>
      </DialogContent>
    </Dialog>
  </>;
}
