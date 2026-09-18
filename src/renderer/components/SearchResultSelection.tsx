import { AlertCircle, ArrowRight, File, FileText, MessageSquare, X } from "lucide-react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useI18n } from "@/contexts/I18nContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getSearchDestination, type SearchResultType } from "../../../shared/globalSearch";

type DetailResultType = Extract<SearchResultType, "evidence" | "document" | "communication">;

const ICONS = {
  evidence: FileText,
  document: File,
  communication: MessageSquare,
} satisfies Record<DetailResultType, typeof FileText>;

export default function SearchResultSelection({ type, id, onDismiss }: {
  type: DetailResultType;
  id: string;
  onDismiss: () => void;
}) {
  const { locale, formatDate } = useI18n();
  const nl = locale === "nl";
  const [, setLocation] = useLocation();
  const query = trpc.search.resolve.useQuery({ type, id }, { retry: false });
  const Icon = ICONS[type];

  if (query.isLoading) {
    return <section aria-label={nl ? "Geselecteerd zoekresultaat" : "Selected search result"} className="space-y-3 border-l-2 border-primary bg-card p-4">
      <span role="status" className="sr-only">{nl ? "Zoekresultaat laden" : "Loading selected search result"}</span>
      <Skeleton className="h-5 w-1/3" /><Skeleton className="h-16 w-full" />
    </section>;
  }

  if (query.error || !query.data) {
    return <section role="alert" aria-label={nl ? "Zoekresultaat niet beschikbaar" : "Search result unavailable"} className="flex flex-wrap items-start gap-3 border-l-2 border-destructive bg-destructive/5 p-4">
      <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 className="font-semibold">{nl ? "Record niet gevonden of niet toegankelijk" : "Record not found or inaccessible"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{nl ? "Het resultaat is mogelijk verwijderd of hoort bij een andere werkruimte." : "The result may have been deleted or belongs to another workspace."}</p>
      </div>
      <Button type="button" variant="outline" size="sm" onClick={onDismiss}>{nl ? "Selectie wissen" : "Clear selection"}</Button>
    </section>;
  }

  const result = query.data;
  return <section data-search-result={result.type} aria-label={nl ? "Geselecteerd zoekresultaat" : "Selected search result"} className="border-l-2 border-primary bg-card p-4">
    <div className="flex items-start gap-3">
      <Icon className="mt-1 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><Badge variant="secondary" className="capitalize">{result.type}</Badge>{result.category && <span className="text-xs text-muted-foreground">{result.category}</span>}</div>
        <h2 className="mt-2 break-words text-lg font-semibold">{result.title}</h2>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{result.description}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {result.occurredAt && <span className="text-xs text-muted-foreground">{formatDate(result.occurredAt, { dateStyle: "medium", timeStyle: "short" })}</span>}
          {result.caseId && <Button type="button" variant="ghost" size="sm" onClick={() => {
            const destination = getSearchDestination({ type: "case", id: result.caseId! });
            if (destination) setLocation(destination);
          }}>{nl ? "Dossier openen" : "Open case"}<ArrowRight className="h-4 w-4" /></Button>}
        </div>
      </div>
      <Button type="button" variant="ghost" size="icon" aria-label={nl ? "Zoekresultaat sluiten" : "Close search result"} title={nl ? "Zoekresultaat sluiten" : "Close search result"} onClick={onDismiss}>
        <X className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  </section>;
}
