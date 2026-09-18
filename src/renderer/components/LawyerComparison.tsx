import { Award, Briefcase, ExternalLink, Languages, MapPin, Scale, X } from "lucide-react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryNotice } from "@/components/WorkspaceUi";

function rateLabel(rate: { percent: number; numerator: number; denominator: number } | null): string {
  return rate ? `${rate.percent.toFixed(1)}% (${rate.numerator}/${rate.denominator})` : "Not recorded";
}

function durationLabel(hours: number | null): string {
  if (hours === null) return "Not recorded";
  if (hours < 24) return `${hours} hours`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 border-t border-border/50 pt-3">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 break-words text-sm font-medium">{value}</dd>
  </div>;
}

export default function LawyerComparison({ lawyerIds, caseId, onClose }: {
  lawyerIds: string[];
  caseId?: string | null;
  onClose?: () => void;
}) {
  const [, setLocation] = useLocation();
  const query = trpc.lawyers.compare.useQuery({ lawyerIds, caseId: caseId || undefined }, {
    enabled: lawyerIds.length >= 2,
    retry: false,
  });

  return <section className="scroll-mt-20 space-y-5 border-y border-border py-5" aria-label="Lawyer comparison">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold">Compare lawyers</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {caseId ? "Directory facts and canonical case-match results." : "Directory facts only. Select a case to calculate canonical match results."}
        </p>
      </div>
      {onClose && <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close lawyer comparison" title="Close lawyer comparison"><X className="h-4 w-4" /></Button>}
    </header>

    {query.error ? <QueryNotice error={query.error} retry={query.refetch} /> : query.isLoading ? (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{lawyerIds.map(id => <Skeleton key={id} className="h-96 w-full" />)}</div>
    ) : <>
      {query.data?.missingCount ? <p role="status" className="text-sm text-muted-foreground">{query.data.missingCount} selected lawyer record is no longer available.</p> : null}
      {caseId && query.data?.matchStatus === "unavailable" && <p role="status" className="border-l-2 border-amber-500 bg-amber-500/5 p-3 text-sm">Canonical matching is unavailable for this case. No match percentages are shown.</p>}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {query.data?.lawyers.map(lawyer => <Card key={lawyer.id} data-comparison-lawyer={lawyer.id} className="flex min-w-0 flex-col border-border/60">
          <CardHeader className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1 basis-48">
                <CardTitle className="break-words text-lg">{lawyer.name}</CardTitle>
                <p className="mt-1 break-words text-sm text-muted-foreground">{lawyer.firm || "Practice not recorded"}</p>
              </div>
              {lawyer.caseMatch && <Badge className="shrink-0 whitespace-nowrap" title={`${lawyer.caseMatch.score} of ${lawyer.caseMatch.maxScore} canonical points`}>
                {lawyer.caseMatch.percent}% case match
              </Badge>}
              {caseId && query.data?.matchStatus === "available" && !lawyer.caseMatch && <Badge className="shrink-0 whitespace-nowrap" variant="outline">Not a current match</Badge>}
            </div>
            {lawyer.city && <p className="flex items-center gap-2 text-sm text-muted-foreground"><MapPin className="h-4 w-4" />{lawyer.city}</p>}
          </CardHeader>
          <CardContent className="flex-1 space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              <Metric label="Experience" value={lawyer.experienceYears === null ? "Not recorded" : `${lawyer.experienceYears} years`} />
              <Metric label="Availability" value={lawyer.availabilityLabel} />
              <Metric label="Response rate" value={rateLabel(lawyer.responseRate)} />
              <Metric label="Acceptance rate" value={rateLabel(lawyer.acceptanceRate)} />
              <Metric label="Average response" value={durationLabel(lawyer.averageResponseHours)} />
              <Metric label="Active case load" value={lawyer.caseLoad === null ? "Not recorded" : String(lawyer.caseLoad)} />
              <Metric label="Capacity filled" value={lawyer.capacityPercent === null ? "Not recorded" : `${lawyer.capacityPercent}%`} />
            </dl>

            <div>
              <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><Scale className="h-4 w-4" />Legal areas</p>
              <div className="flex flex-wrap gap-1">
                {lawyer.legalAreas.length ? lawyer.legalAreas.map(area => <Badge key={area} variant="secondary">{area}</Badge>) : <span className="text-sm text-muted-foreground">Not recorded</span>}
              </div>
            </div>
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><Languages className="h-4 w-4" />Languages</p>
              <p className="text-sm">{lawyer.languages.length ? lawyer.languages.join(", ") : "Not recorded"}</p>
            </div>

            {lawyer.caseMatch && <div className="border-l-2 border-primary bg-primary/5 p-3">
              <p className="flex items-center gap-2 text-sm font-medium"><Award className="h-4 w-4" />Canonical match basis</p>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {lawyer.caseMatch.reasons.slice(0, 4).map(reason => <li key={reason}>{reason}</li>)}
              </ul>
            </div>}
          </CardContent>
          <CardFooter className="flex flex-wrap gap-2 border-t border-border/50 pt-4">
            <Button type="button" variant="outline" className="flex-1" onClick={() => setLocation(`/lawyers/${encodeURIComponent(lawyer.id)}`)}>
              <Briefcase className="h-4 w-4" />View profile
            </Button>
            {lawyer.officialProfileUrl && <Button asChild variant="ghost" size="icon" title="Open official profile">
              <a href={lawyer.officialProfileUrl} target="_blank" rel="noreferrer" aria-label={`Open official profile for ${lawyer.name}`}><ExternalLink className="h-4 w-4" /></a>
            </Button>}
          </CardFooter>
        </Card>)}
      </div>
      {!query.data?.lawyers.length && <p className="py-8 text-center text-sm text-muted-foreground">The selected lawyer records are no longer available.</p>}
    </>}
  </section>;
}
