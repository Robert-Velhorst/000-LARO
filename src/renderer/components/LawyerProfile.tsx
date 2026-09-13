import { useLocation, useParams } from "wouter";
import { ArrowLeft, Building2, ExternalLink, Mail, MapPin, Phone, Scale } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryNotice } from "@/components/WorkspaceUi";

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

export default function LawyerProfile() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const query = trpc.lawyers.byId.useQuery(id || "", { enabled: Boolean(id) });
  const lawyer = query.data;

  if (query.isLoading) {
    return <section className="mx-auto max-w-5xl p-6"><Skeleton className="h-48 w-full" /></section>;
  }
  if (!lawyer || query.error) {
    return (
      <section className="mx-auto max-w-5xl p-6">
        <h1 className="text-2xl font-semibold">{query.error ? "Lawyer profile unavailable" : "Lawyer not found"}</h1>
        {query.error && <QueryNotice error={query.error} retry={query.refetch} />}
        <Button className="mt-4" variant="outline" onClick={() => setLocation("/outreach?view=lawyers")}><ArrowLeft />Back</Button>
      </section>
    );
  }

  const legalAreas = parseList(lawyer.legalAreas);
  const languages = parseList(lawyer.languages);
  const totalOutreach = Number(lawyer.totalOutreaches || 0);
  const totalResponses = Number(lawyer.totalResponses || 0);
  const responseRate = totalOutreach > 0 ? Math.round((totalResponses / totalOutreach) * 100) : null;

  return (
    <section className="space-y-5">
      <Button variant="ghost" onClick={() => setLocation("/outreach?view=lawyers")}><ArrowLeft />Lawyers</Button>
      <header className="border-b pb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">{lawyer.name || "Unnamed lawyer"}</h1>
            <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground"><Building2 className="h-4 w-4" />{lawyer.firmName || lawyer.firm || "Practice not recorded"}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {lawyer.barAssociationStatus && <Badge variant="outline">{lawyer.barAssociationStatus}</Badge>}
            {lawyer.currentlyAccepting && <Badge variant="secondary">Accepting: {lawyer.currentlyAccepting}</Badge>}
          </div>
        </div>
      </header>

      <section className="grid gap-5 md:grid-cols-[1.4fr_0.6fr]">
        <Card>
          <CardHeader><CardTitle className="text-base">Practice profile</CardTitle></CardHeader>
          <CardContent className="space-y-5">
            <div><p className="mb-2 text-sm font-medium">Legal areas</p><div className="flex flex-wrap gap-2">{legalAreas.length ? legalAreas.map((area) => <Badge key={area} variant="secondary">{area}</Badge>) : <span className="text-sm text-muted-foreground">No legal areas recorded.</span>}</div></div>
            {languages.length > 0 && <div><p className="mb-2 text-sm font-medium">Languages</p><p className="text-sm text-muted-foreground">{languages.join(", ")}</p></div>}
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-muted-foreground">Experience</dt><dd className="font-medium">{lawyer.experienceYears || "Not recorded"}{lawyer.experienceYears ? " years" : ""}</dd></div>
              <div><dt className="text-muted-foreground">Current case load</dt><dd className="font-medium">{lawyer.caseLoad || "Not recorded"}</dd></div>
              <div><dt className="text-muted-foreground">Recorded outreaches</dt><dd className="font-medium">{totalOutreach}</dd></div>
              <div><dt className="text-muted-foreground">Recorded response rate</dt><dd className="font-medium">{responseRate == null ? "Not available" : `${responseRate}%`}</dd></div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Contact</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {lawyer.city && <p className="flex items-start gap-2"><MapPin className="mt-0.5 h-4 w-4" /><span>{lawyer.address ? `${lawyer.address}, ` : ""}{lawyer.city}</span></p>}
            {lawyer.email && <a className="flex min-w-0 items-center gap-2 break-all text-primary hover:underline" href={`mailto:${lawyer.email}`}><Mail className="h-4 w-4" />{lawyer.email}</a>}
            {lawyer.phone && <a className="flex min-w-0 items-center gap-2 break-all text-primary hover:underline" href={`tel:${lawyer.phone}`}><Phone className="h-4 w-4" />{lawyer.phone}</a>}
            {lawyer.website && <a className="flex min-w-0 items-center gap-2 break-all text-primary hover:underline" href={lawyer.website} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" />Website</a>}
            {lawyer.novaId && <p className="flex items-center gap-2"><Scale className="h-4 w-4" />NOvA identifier {lawyer.novaId}</p>}
            {!lawyer.city && !lawyer.email && !lawyer.phone && !lawyer.website && !lawyer.novaId && <p className="text-muted-foreground">No contact details recorded.</p>}
          </CardContent>
        </Card>
      </section>
    </section>
  );
}
