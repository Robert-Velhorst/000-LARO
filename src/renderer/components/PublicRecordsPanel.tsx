import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { trpc } from "@/lib/trpc";
import {
  Building2,
  Search,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Gavel,
  Database,
  ListChecks,
  Calendar,
  MapPin,
  Briefcase,
  ExternalLink,
  BookOpen,
} from "lucide-react";

interface PublicRecordsPanelProps {
  caseId: string;
  companyName?: string;
  kvkNumber?: string;
}

export function PublicRecordsPanel({ caseId, companyName, kvkNumber }: PublicRecordsPanelProps) {
  const [searchKvk, setSearchKvk] = useState(kvkNumber || "");
  const [searchCompany, setSearchCompany] = useState(companyName || "");
  const [legislationQuery, setLegislationQuery] = useState("");
  const [legislationDate, setLegislationDate] = useState(() => new Date().toISOString().slice(0, 10));

  // KvK lookup mutation
  const kvkLookup = trpc.gapAnalysis.lookupCompany.useMutation();

  // Court records search mutation
  const courtRecordsSearch = trpc.gapAnalysis.searchCourtRecords.useMutation();
  const legislationSearch = trpc.gapAnalysis.searchLegislation.useMutation();

  const handleKvkLookup = async () => {
    if (!searchKvk) return;

    await kvkLookup.mutateAsync({
      caseId,
      kvkNumber: searchKvk,
    });
  };

  const handleCourtRecordsSearch = async () => {
    if (!searchCompany) return;

    await courtRecordsSearch.mutateAsync({
      caseId,
      companyName: searchCompany,
      searchType: "company_history",
    });
  };

  const opponentHistory = courtRecordsSearch.data?.opponentHistory;

  return (
    <div className="space-y-6">
      <Tabs defaultValue="kvk" className="w-full">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="kvk">
            <Building2 className="w-4 h-4 mr-2" />
            KvK Business Registry
          </TabsTrigger>
          <TabsTrigger value="court">
            <Gavel className="w-4 h-4 mr-2" />
            Court Records
          </TabsTrigger>
          <TabsTrigger value="legislation">
            <BookOpen className="w-4 h-4 mr-2" />
            Legislation
          </TabsTrigger>
        </TabsList>

        {/* KvK Tab */}
        <TabsContent value="kvk" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Dutch Business Registry (KvK) Lookup</CardTitle>
              <CardDescription>
                Search for company information, insolvency status, and business activities
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="kvk-number">KvK Number</Label>
                <Input
                  id="kvk-number"
                  inputMode="numeric"
                  pattern="[0-9]{8}"
                  maxLength={8}
                  placeholder="12345678"
                  value={searchKvk}
                  onChange={(e) => setSearchKvk(e.target.value.replace(/\D/g, "").slice(0, 8))}
                />
              </div>

              <Button
                onClick={handleKvkLookup}
                disabled={kvkLookup.isPending || searchKvk.length !== 8}
                className="w-full"
              >
                <Search className="w-4 h-4 mr-2" />
                {kvkLookup.isPending ? "Searching..." : "Search KvK Registry"}
              </Button>

              {/* KvK Results */}
              {kvkLookup.data && (
                <div className="mt-4 space-y-4">
                  <ResearchStatus
                    research={kvkLookup.data.research}
                    error={kvkLookup.data.error}
                    emptyMessage="The complete KvK response contained no matching company record. No activity or insolvency conclusion can be drawn."
                  />
                  {kvkLookup.data.research.empty ? null : kvkLookup.data.success ? (
                    <>
                      <Alert>
                        <CheckCircle className="h-4 w-4" />
                        <AlertDescription>Registry record returned by the KvK open dataset</AlertDescription>
                      </Alert>

                      {kvkLookup.data.source && (
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Registry source</CardTitle>
                            <CardDescription>{kvkLookup.data.source.dataset}</CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-2 text-xs text-muted-foreground">
                            <p>{kvkLookup.data.source.provider}</p>
                            <p>Retrieved {new Date(kvkLookup.data.source.retrievedAt).toLocaleString()}</p>
                            <a
                              href={kvkLookup.data.source.documentationUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                            >
                              Open dataset documentation <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                          </CardContent>
                        </Card>
                      )}

                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">KvK Number</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="text-2xl font-bold">
                              {kvkLookup.data.data?.kvkNumber}
                            </p>
                            <SourceField sourceField="kvknummer (lookup key)" rawValue={kvkLookup.data.data?.kvkNumber ?? null} />
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Status</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            {kvkLookup.data.data?.isActive === true ? (
                              <Badge variant="default" className="bg-green-500">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Active
                              </Badge>
                            ) : kvkLookup.data.data?.isActive === false ? (
                              <Badge variant="destructive">
                                <XCircle className="w-3 h-3 mr-1" />
                                Inactive
                              </Badge>
                            ) : (
                              <Badge variant="secondary">Not returned</Badge>
                            )}
                            <SourceField {...kvkLookup.data.data!.fieldProvenance.activityStatus} />
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Start Date</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <p className="text-lg font-semibold">
                              {kvkLookup.data.data?.startDate
                                ?? (kvkLookup.data.data?.fieldProvenance.startDate.rawValue ? "Unknown in source" : "Not returned")}
                            </p>
                            <SourceField {...kvkLookup.data.data!.fieldProvenance.startDate} />
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Legal Form</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <p className="text-lg font-semibold">
                              {kvkLookup.data.data?.legalForm ?? "Not returned"}
                            </p>
                            {kvkLookup.data.data?.legalForm && <p className="text-xs text-muted-foreground">
                              {kvkLookup.data.data.legalForm === "BV"
                                ? "Private Company"
                                : "Public Limited Company"}
                            </p>}
                            <SourceField {...kvkLookup.data.data!.fieldProvenance.legalForm} />
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Region</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <p className="text-lg font-semibold flex items-center">
                              <MapPin className="w-4 h-4 mr-1" />
                              {kvkLookup.data.data?.postalCodeRegion
                                ? `${kvkLookup.data.data.postalCodeRegion}xx`
                                : "Not returned"}
                            </p>
                            <SourceField {...kvkLookup.data.data!.fieldProvenance.postalCodeRegion} />
                          </CardContent>
                        </Card>
                      </div>

                      {/* Insolvency status is explicit; a missing field never means no warning exists. */}
                      {kvkLookup.data.data?.insolvencyStatus ? (
                        <Alert variant="destructive">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription>
                            <div className="font-semibold">Registry special legal status</div>
                            <div className="mt-1">{kvkLookup.data.data.insolvencyStatus.label}</div>
                            <SourceField {...kvkLookup.data.data.fieldProvenance.insolvencyStatus} />
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <Alert>
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription>
                            <div className="font-semibold">Insolvency/status warning not established</div>
                            <div className="mt-1">
                              The open-dataset response did not provide a supported special-status value. This is not evidence that no insolvency or status warning exists.
                            </div>
                            <SourceField {...kvkLookup.data.data!.fieldProvenance.insolvencyStatus} />
                          </AlertDescription>
                        </Alert>
                      )}

                      {/* Activities */}
                      {kvkLookup.data.data?.activities &&
                        kvkLookup.data.data.activities.length > 0 && (
                          <Card>
                            <CardHeader>
                              <CardTitle className="text-sm">Business Activities</CardTitle>
                            </CardHeader>
                            <CardContent>
                              <div className="space-y-2">
                                {kvkLookup.data.data.activities.map((activity, idx) => (
                                  <div
                                    key={idx}
                                    className="flex items-center justify-between p-2 border rounded"
                                  >
                                    <div className="flex items-center gap-2">
                                      <Briefcase className="w-4 h-4" />
                                      <span className="font-mono text-sm">
                                        {activity.sbiCode}
                                      </span>
                                    </div>
                                    <Badge variant={activity.type === "main" ? "default" : "secondary"}>
                                      {activity.type === "main" ? "Main" : "Secondary"}
                                    </Badge>
                                    <span className="sr-only">Source field {activity.sourceField}</span>
                                  </div>
                                ))}
                              </div>
                            </CardContent>
                          </Card>
                        )}

                      {kvkLookup.data.reviewTriage && kvkLookup.data.reviewTriage.length > 0 && (
                        <Card className="border-amber-500/50">
                          <CardHeader>
                            <CardTitle className="text-sm">Review-only triage</CardTitle>
                            <CardDescription>These prompts are not registry facts or legal findings.</CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {kvkLookup.data.reviewTriage.map((item) => (
                              <div key={item.id} className="space-y-1 text-sm">
                                <p className="font-semibold">{item.label}</p>
                                <p>{item.description}</p>
                                <p className="text-xs text-muted-foreground">Based on source field: {item.sourceFields.join(", ")}</p>
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      )}

                      {kvkLookup.data.limitations && kvkLookup.data.limitations.length > 0 && (
                        <Alert>
                          <AlertDescription className="space-y-2 text-sm">
                            <div className="font-semibold">Dataset limitations</div>
                            <ul className="list-disc space-y-1 pl-5">
                              {kvkLookup.data.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
                            </ul>
                          </AlertDescription>
                        </Alert>
                      )}
                    </>
                  ) : (
                    <div className="space-y-3">
                      {kvkLookup.data.source && (
                        <p className="text-xs text-muted-foreground">
                          Source: {kvkLookup.data.source.provider} · retrieved {new Date(kvkLookup.data.source.retrievedAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Court Records Tab */}
        <TabsContent value="court" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Court Records Search (Rechtspraak.nl)</CardTitle>
              <CardDescription>
                Search recently published decisions and open the original Rechtspraak.nl source
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="court-company">Company Name</Label>
                <Input
                  id="court-company"
                  placeholder="ABC BV"
                  value={searchCompany}
                  onChange={(e) => setSearchCompany(e.target.value)}
                />
              </div>

              <Button
                onClick={handleCourtRecordsSearch}
                disabled={courtRecordsSearch.isPending || !searchCompany}
                className="w-full"
              >
                <Search className="w-4 h-4 mr-2" />
                {courtRecordsSearch.isPending ? "Searching..." : "Search Court Records"}
              </Button>

              {courtRecordsSearch.data && (
                <ResearchStatus
                  research={courtRecordsSearch.data.research}
                  error={courtRecordsSearch.data.error}
                  emptyMessage="The complete Rechtspraak response contained no matching published decisions."
                />
              )}

              {/* Opponent History Summary */}
              {opponentHistory?.success && (
                <div className="mt-4 space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-sm font-semibold">Published results</p>
                      <p className="mt-2 text-2xl font-bold">{opponentHistory.totalCases}</p>
                    </div>

                    <div className="rounded-md border border-border/60 p-3">
                      <p className="flex items-center gap-1 text-sm font-semibold">
                          <ListChecks className="h-4 w-4" />
                          Classified outcomes
                      </p>
                      <p className="mt-2 text-2xl font-bold">
                        {(opponentHistory.wonCases ?? 0) + (opponentHistory.lostCases ?? 0)}
                      </p>
                    </div>

                    <div className="rounded-md border border-border/60 p-3">
                      <p className="flex items-center gap-1 text-sm font-semibold">
                          <Database className="h-4 w-4" />
                          Source coverage
                      </p>
                      <p className="mt-2 text-2xl font-bold">RSS</p>
                    </div>
                  </div>

                  {/* Litigation Patterns */}
                  {opponentHistory.patterns.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm">Litigation Patterns</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {opponentHistory.patterns.map((pattern, idx) => (
                            <Alert key={idx}>
                              <AlertTriangle className="h-4 w-4" />
                              <AlertDescription className="text-sm">{pattern}</AlertDescription>
                            </Alert>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Recent Cases */}
                  {opponentHistory.recentCases.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm">Recent Court Decisions</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {opponentHistory.recentCases.map((decision, idx) => (
                            <div key={idx} className="p-3 border rounded space-y-2">
                              <div className="flex items-start justify-between">
                                <div className="flex-1">
                                  <div className="font-semibold">{decision.title}</div>
                                  <div className="text-sm text-muted-foreground mt-1">
                                    {decision.court}
                                  </div>
                                </div>
                                {decision.outcome && (
                                  <Badge
                                    variant={
                                      decision.outcome === "granted"
                                        ? "default"
                                        : decision.outcome === "denied"
                                          ? "destructive"
                                          : "secondary"
                                    }
                                  >
                                    {decision.outcome}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Calendar className="w-3 h-3" />
                                  {decision.date}
                                </span>
                                <span className="font-mono">{decision.ecli}</span>
                              </div>
                              {decision.summary && (
                                <p className="text-sm text-muted-foreground">{decision.summary}</p>
                              )}
                              {decision.sourceUrl && (
                                <a
                                  href={decision.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                                >
                                  Open source decision
                                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {/* Court Records Search Results */}
              {courtRecordsSearch.data?.success && (
                <div className="mt-4">
                  <Alert>
                    <CheckCircle className="h-4 w-4" />
                    <AlertDescription>
                      The partial RSS response returned {courtRecordsSearch.data.totalResults} recently published decision(s).
                      {courtRecordsSearch.data.totalResults === 0 && (
                        <div className="mt-2 text-sm font-medium">
                          Zero in this partial source is not evidence that no published decisions exist.
                        </div>
                      )}
                      {courtRecordsSearch.data.legalSignificance && (
                        <div className="mt-2 text-sm">
                          {courtRecordsSearch.data.legalSignificance}
                        </div>
                      )}
                      {courtRecordsSearch.data.coverageNotice && (
                        <div className="mt-2 text-xs text-muted-foreground">
                          {courtRecordsSearch.data.coverageNotice}
                        </div>
                      )}
                    </AlertDescription>
                  </Alert>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="legislation" className="space-y-4">
          <section className="border-y border-border/60 py-5" aria-labelledby="legislation-search-title">
            <div className="mb-4">
              <h3 id="legislation-search-title" className="font-semibold">Official Dutch legislation</h3>
              <p className="text-sm text-muted-foreground">Search consolidated legislation in KOOP's Basiswettenbestand for the version valid on a specific date.</p>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_11rem_auto] md:items-end">
              <div className="space-y-2">
                <Label htmlFor="legislation-query">Law or regulation</Label>
                <Input id="legislation-query" value={legislationQuery} onChange={(event) => setLegislationQuery(event.target.value)} placeholder="Algemene wet bestuursrecht" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="legislation-date">Valid on</Label>
                <Input id="legislation-date" type="date" value={legislationDate} onChange={(event) => setLegislationDate(event.target.value)} />
              </div>
              <Button
                type="button"
                disabled={legislationSearch.isPending || legislationQuery.trim().length < 3 || !legislationDate}
                onClick={() => legislationSearch.mutate({ caseId, query: legislationQuery.trim(), asOfDate: legislationDate, limit: 15 })}
              >
                <Search className="mr-2 h-4 w-4" />
                {legislationSearch.isPending ? "Searching..." : "Search"}
              </Button>
            </div>
            {legislationSearch.error ? (
              <Alert variant="destructive" className="mt-4"><AlertTriangle className="h-4 w-4" /><AlertDescription>{legislationSearch.error.message}</AlertDescription></Alert>
            ) : null}
            {legislationSearch.data ? (
              <div className="mt-5 space-y-3">
                <ResearchStatus
                  research={legislationSearch.data.research}
                  error={legislationSearch.data.success ? undefined : legislationSearch.data.error}
                  emptyMessage="The complete KOOP response contained no legislation matching this title and validity date."
                />
                {legislationSearch.data.success && <p className="text-xs text-muted-foreground">{legislationSearch.data.coverageNotice}</p>}
                {legislationSearch.data.success && legislationSearch.data.results.map((result) => (
                  <article key={result.identifier} className="border-t border-border/60 pt-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="font-medium">{result.title}</h4>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {result.identifier} · {result.type || "regeling"} · geldig {result.effectiveFrom || "onbekend"} tot {result.effectiveUntil === "9999-12-31" ? "heden" : result.effectiveUntil || "onbekend"}
                        </p>
                        {result.legalAreas.length ? <p className="mt-1 text-xs text-muted-foreground">{result.legalAreas.join(" · ")}</p> : null}
                      </div>
                      <a href={result.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                        Open official source <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                      </a>
                    </div>
                  </article>
                ))}
              </div>
            ) : null}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SourceField({ sourceField, rawValue }: { sourceField: string; rawValue: string | null }) {
  return (
    <p className="text-xs text-muted-foreground">
      Source field: <code>{sourceField}</code>{rawValue === null ? " (not returned)" : ` = ${rawValue}`}
    </p>
  );
}

type ResearchReceipt = {
  completeness: "complete" | "partial" | "unavailable" | "failed";
  empty: boolean;
  resultCount: number | null;
  retrievedAt: string;
  source: "kvk_open_dataset" | "rechtspraak_rss" | "koop_bwb_sru";
};

function ResearchStatus({
  research,
  error,
  emptyMessage,
}: {
  research: ResearchReceipt;
  error?: string;
  emptyMessage: string;
}) {
  const renderedState = research.empty ? "empty" : research.completeness;
  const source = research.source === "kvk_open_dataset"
    ? "KvK open dataset"
    : research.source === "rechtspraak_rss"
      ? "Rechtspraak.nl RSS"
      : "KOOP Basiswettenbestand";
  if (research.empty) {
    return (
      <Alert data-testid="research-state-empty">
        <CheckCircle className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">Complete response — no matches</p>
          <p className="mt-1">{emptyMessage}</p>
          <p className="mt-2 text-xs text-muted-foreground">{source} · retrieved {new Date(research.retrievedAt).toLocaleString()}</p>
        </AlertDescription>
      </Alert>
    );
  }
  if (research.completeness === "complete") {
    return (
      <Alert data-testid="research-state-complete">
        <CheckCircle className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">Complete provider response</p>
          <p className="mt-1">Recorded {research.resultCount ?? 0} matching result(s) for this bounded query.</p>
          <p className="mt-2 text-xs text-muted-foreground">{source} · retrieved {new Date(research.retrievedAt).toLocaleString()}</p>
        </AlertDescription>
      </Alert>
    );
  }
  if (research.completeness === "partial") {
    return (
      <Alert data-testid="research-state-partial">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">Partial provider response</p>
          <p className="mt-1">
            {research.resultCount === 0
              ? "The source returned zero matches, but its coverage is partial; absence is not established."
              : `Recorded ${research.resultCount ?? 0} result(s), but the source or returned fields are incomplete.`}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{source} · retrieved {new Date(research.retrievedAt).toLocaleString()}</p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" data-testid={`research-state-${renderedState}`}>
      {research.completeness === "unavailable"
        ? <AlertTriangle className="h-4 w-4" />
        : <XCircle className="h-4 w-4" />}
      <AlertDescription>
        <p className="font-semibold">
          {research.completeness === "unavailable" ? "Provider unavailable" : "Research failed"}
        </p>
        <p className="mt-1">{error || "The provider response could not be used."}</p>
        <p className="mt-1">No zero-result, status, insolvency, or absence conclusion was recorded.</p>
        <p className="mt-2 text-xs">{source} · attempted {new Date(research.retrievedAt).toLocaleString()}</p>
      </AlertDescription>
    </Alert>
  );
}
