import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { trpc } from "@/lib/trpc";
import { useI18n } from "../contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";
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

const OUTCOME_KEYS: Record<string, TranslationKey> = {
  granted: "publicRecords.outcome.granted",
  denied: "publicRecords.outcome.denied",
  partial: "publicRecords.outcome.partial",
  unknown: "publicRecords.outcome.unknown",
};

const RESEARCH_SOURCE_KEYS = {
  kvk_open_dataset: "publicRecords.research.sourceKvk",
  rechtspraak_rss: "publicRecords.research.sourceCourt",
  koop_bwb_sru: "publicRecords.research.sourceLegislation",
} as const satisfies Record<ResearchReceipt["source"], TranslationKey>;

const researchSourceKey = (source: ResearchReceipt["source"]): TranslationKey => RESEARCH_SOURCE_KEYS[source];

type DateFormatter = (value: Date | string | number, options?: Intl.DateTimeFormatOptions) => string;

function localizedSourceDate(value: string, formatDate: DateFormatter): string {
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00`)
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : formatDate(parsed, { dateStyle: "medium" });
}

export function PublicRecordsPanel({ caseId, companyName, kvkNumber }: PublicRecordsPanelProps) {
  const { t, formatDate, formatNumber } = useI18n();
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
        <TabsList className="grid w-full grid-cols-1 group-data-[orientation=horizontal]/tabs:h-auto sm:grid-cols-3">
          <TabsTrigger value="kvk" className="min-h-10 whitespace-normal">
            <Building2 className="w-4 h-4 mr-2" />
            {t("publicRecords.tab.kvk")}
          </TabsTrigger>
          <TabsTrigger value="court" className="min-h-10 whitespace-normal">
            <Gavel className="w-4 h-4 mr-2" />
            {t("publicRecords.tab.court")}
          </TabsTrigger>
          <TabsTrigger value="legislation" className="min-h-10 whitespace-normal">
            <BookOpen className="w-4 h-4 mr-2" />
            {t("publicRecords.tab.legislation")}
          </TabsTrigger>
        </TabsList>

        {/* KvK Tab */}
        <TabsContent value="kvk" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("publicRecords.kvk.title")}</CardTitle>
              <CardDescription>{t("publicRecords.kvk.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="kvk-number">{t("publicRecords.kvk.number")}</Label>
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
                {kvkLookup.isPending ? t("publicRecords.searching") : t("publicRecords.kvk.search")}
              </Button>

              {/* KvK Results */}
              {kvkLookup.data && (
                <div className="mt-4 space-y-4">
                  <ResearchStatus
                    research={kvkLookup.data.research}
                    error={kvkLookup.data.error}
                    emptyMessageKey="publicRecords.kvk.empty"
                  />
                  {kvkLookup.data.research.empty ? null : kvkLookup.data.success ? (
                    <>
                      <Alert>
                        <CheckCircle className="h-4 w-4" />
                        <AlertDescription>{t("publicRecords.registryReturned")}</AlertDescription>
                      </Alert>

                      {kvkLookup.data.source && (
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">{t("publicRecords.registrySource")}</CardTitle>
                            <CardDescription>{kvkLookup.data.source.dataset}</CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-2 text-xs text-muted-foreground">
                            <p>{kvkLookup.data.source.provider}</p>
                            <p>{t("publicRecords.retrieved", { date: formatDate(kvkLookup.data.source.retrievedAt, { dateStyle: "medium", timeStyle: "short" }) })}</p>
                            <a
                              href={kvkLookup.data.source.documentationUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                            >
                              {t("publicRecords.openDatasetDocumentation")} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                          </CardContent>
                        </Card>
                      )}

                      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">{t("publicRecords.kvk.number")}</CardTitle>
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
                            <CardTitle className="text-sm">{t("publicRecords.status")}</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            {kvkLookup.data.data?.isActive === true ? (
                              <Badge variant="default" className="bg-green-500">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                {t("publicRecords.active")}
                              </Badge>
                            ) : kvkLookup.data.data?.isActive === false ? (
                              <Badge variant="destructive">
                                <XCircle className="w-3 h-3 mr-1" />
                                {t("publicRecords.inactive")}
                              </Badge>
                            ) : (
                              <Badge variant="secondary">{t("publicRecords.notReturned")}</Badge>
                            )}
                            <SourceField {...kvkLookup.data.data!.fieldProvenance.activityStatus} />
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">{t("publicRecords.startDate")}</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <p className="text-lg font-semibold">
                              {kvkLookup.data.data?.startDate
                                ? localizedSourceDate(kvkLookup.data.data.startDate, formatDate)
                                : kvkLookup.data.data?.fieldProvenance.startDate.rawValue
                                  ? t("publicRecords.unknownInSource")
                                  : t("publicRecords.notReturned")}
                            </p>
                            <SourceField {...kvkLookup.data.data!.fieldProvenance.startDate} />
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">{t("publicRecords.legalForm")}</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <p className="text-lg font-semibold">
                              {kvkLookup.data.data?.legalForm ?? t("publicRecords.notReturned")}
                            </p>
                            {kvkLookup.data.data?.legalForm && <p className="text-xs text-muted-foreground">
                              {kvkLookup.data.data.legalForm === "BV"
                                ? t("publicRecords.privateCompany")
                                : t("publicRecords.publicCompany")}
                            </p>}
                            <SourceField {...kvkLookup.data.data!.fieldProvenance.legalForm} />
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">{t("publicRecords.region")}</CardTitle>
                          </CardHeader>
                          <CardContent className="space-y-2">
                            <p className="text-lg font-semibold flex items-center">
                              <MapPin className="w-4 h-4 mr-1" />
                              {kvkLookup.data.data?.postalCodeRegion
                                ? t("publicRecords.regionValue", { region: kvkLookup.data.data.postalCodeRegion })
                                : t("publicRecords.notReturned")}
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
                            <div className="font-semibold">{t("publicRecords.insolvencyTitle")}</div>
                            <div className="mt-1">{kvkLookup.data.data.insolvencyStatus.label}</div>
                            <SourceField {...kvkLookup.data.data.fieldProvenance.insolvencyStatus} />
                          </AlertDescription>
                        </Alert>
                      ) : (
                        <Alert>
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription>
                            <div className="font-semibold">{t("publicRecords.insolvencyWarningTitle")}</div>
                            <div className="mt-1">
                              {t("publicRecords.insolvencyWarningBody")}
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
                              <CardTitle className="text-sm">{t("publicRecords.activities")}</CardTitle>
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
                                      {activity.type === "main" ? t("publicRecords.activity.main") : t("publicRecords.activity.secondary")}
                                    </Badge>
                                    <span className="sr-only">{t("publicRecords.sourceFieldScreenReader")} {activity.sourceField}</span>
                                  </div>
                                ))}
                              </div>
                            </CardContent>
                          </Card>
                        )}

                      {kvkLookup.data.reviewTriage && kvkLookup.data.reviewTriage.length > 0 && (
                        <Card className="border-amber-500/50">
                          <CardHeader>
                            <CardTitle className="text-sm">{t("publicRecords.reviewTriage")}</CardTitle>
                            <CardDescription>{t("publicRecords.triageDisclaimer")}</CardDescription>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            {kvkLookup.data.reviewTriage.map((item) => (
                              <div key={item.id} className="space-y-1 text-sm">
                                <p className="font-semibold">{item.label}</p>
                                <p>{item.description}</p>
                                <p className="text-xs text-muted-foreground">{t("publicRecords.basedOnSourceField")} {item.sourceFields.join(", ")}</p>
                              </div>
                            ))}
                          </CardContent>
                        </Card>
                      )}

                      {kvkLookup.data.limitations && kvkLookup.data.limitations.length > 0 && (
                        <Alert>
                          <AlertDescription className="space-y-2 text-sm">
                            <div className="font-semibold">{t("publicRecords.datasetLimitations")}</div>
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
                          {t("publicRecords.sourceLabel")} {kvkLookup.data.source.provider} · {t("publicRecords.retrievedLower", { date: formatDate(kvkLookup.data.source.retrievedAt, { dateStyle: "medium", timeStyle: "short" }) })}
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
              <CardTitle>{t("publicRecords.court.title")}</CardTitle>
              <CardDescription>{t("publicRecords.court.description")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="court-company">{t("publicRecords.court.company")}</Label>
                <Input
                  id="court-company"
                  placeholder={t("publicRecords.placeholder.company")}
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
                {courtRecordsSearch.isPending ? t("publicRecords.searching") : t("publicRecords.court.search")}
              </Button>

              {courtRecordsSearch.data && (
                <ResearchStatus
                  research={courtRecordsSearch.data.research}
                  error={courtRecordsSearch.data.error}
                  emptyMessageKey="publicRecords.court.empty"
                />
              )}

              {/* Opponent History Summary */}
              {opponentHistory?.success && (
                <div className="mt-4 space-y-4">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    <div className="rounded-md border border-border/60 p-3">
                      <p className="text-sm font-semibold">{t("publicRecords.court.published")}</p>
                      <p className="mt-2 text-2xl font-bold">{opponentHistory.totalCases}</p>
                    </div>

                    <div className="rounded-md border border-border/60 p-3">
                      <p className="flex items-center gap-1 text-sm font-semibold">
                          <ListChecks className="h-4 w-4" />
                          {t("publicRecords.court.classified")}
                      </p>
                      <p className="mt-2 text-2xl font-bold">
                        {(opponentHistory.wonCases ?? 0) + (opponentHistory.lostCases ?? 0)}
                      </p>
                    </div>

                    <div className="rounded-md border border-border/60 p-3">
                      <p className="flex items-center gap-1 text-sm font-semibold">
                          <Database className="h-4 w-4" />
                          {t("publicRecords.court.coverage")}
                      </p>
                      <p className="mt-2 text-2xl font-bold">{t("publicRecords.sourceCoverageRss")}</p>
                    </div>
                  </div>

                  {/* Litigation Patterns */}
                  {opponentHistory.patterns.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm">{t("publicRecords.court.patterns")}</CardTitle>
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
                        <CardTitle className="text-sm">{t("publicRecords.court.recent")}</CardTitle>
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
                                    {OUTCOME_KEYS[decision.outcome] ? t(OUTCOME_KEYS[decision.outcome]) : decision.outcome}
                                  </Badge>
                                )}
                              </div>
                              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <Calendar className="w-3 h-3" />
                                  {localizedSourceDate(decision.date, formatDate)}
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
                                  {t("publicRecords.openSourceDecision")}
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
                      {t(courtRecordsSearch.data.totalResults === 1 ? "publicRecords.court.partialSummaryOne" : "publicRecords.court.partialSummaryMany", { count: formatNumber(courtRecordsSearch.data.totalResults ?? 0) })}
                      {courtRecordsSearch.data.totalResults === 0 && (
                        <div className="mt-2 text-sm font-medium">
                          {t("publicRecords.court.zeroNotice")}
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
              <h3 id="legislation-search-title" className="font-semibold">{t("publicRecords.legislation.title")}</h3>
              <p className="text-sm text-muted-foreground">{t("publicRecords.legislation.description")}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_11rem_auto] md:items-end">
              <div className="space-y-2">
                <Label htmlFor="legislation-query">{t("publicRecords.legislation.query")}</Label>
                <Input id="legislation-query" value={legislationQuery} onChange={(event) => setLegislationQuery(event.target.value)} placeholder={t("publicRecords.placeholder.legislation")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="legislation-date">{t("publicRecords.legislation.validOn")}</Label>
                <Input id="legislation-date" type="date" value={legislationDate} onChange={(event) => setLegislationDate(event.target.value)} />
              </div>
              <Button
                type="button"
                disabled={legislationSearch.isPending || legislationQuery.trim().length < 3 || !legislationDate}
                onClick={() => legislationSearch.mutate({ caseId, query: legislationQuery.trim(), asOfDate: legislationDate, limit: 15 })}
              >
                <Search className="mr-2 h-4 w-4" />
                {legislationSearch.isPending ? t("publicRecords.searching") : t("publicRecords.legislation.search")}
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
                  emptyMessageKey="publicRecords.legislation.empty"
                />
                {legislationSearch.data.success && <p className="text-xs text-muted-foreground">{legislationSearch.data.coverageNotice}</p>}
                {legislationSearch.data.success && legislationSearch.data.results.map((result) => (
                  <article key={result.identifier} className="border-t border-border/60 pt-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="font-medium">{result.title}</h4>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("publicRecords.legislation.validity", {
                            identifier: result.identifier,
                            type: result.type || t("publicRecords.legislation.regulation"),
                            from: result.effectiveFrom ? localizedSourceDate(result.effectiveFrom, formatDate) : t("publicRecords.legislation.unknown"),
                            until: result.effectiveUntil === "9999-12-31" ? t("publicRecords.legislation.current") : result.effectiveUntil ? localizedSourceDate(result.effectiveUntil, formatDate) : t("publicRecords.legislation.unknown"),
                          })}
                        </p>
                        {result.legalAreas.length ? <p className="mt-1 text-xs text-muted-foreground">{result.legalAreas.join(" · ")}</p> : null}
                      </div>
                      <a href={result.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                        {t("publicRecords.openOfficialSource")} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
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
  const { t } = useI18n();
  return (
    <p className="text-xs text-muted-foreground">
      {t("publicRecords.sourceField")} <code>{sourceField}</code>{rawValue === null ? t("publicRecords.sourceFieldMissing") : t("publicRecords.sourceFieldValue", { value: rawValue })}
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
  emptyMessageKey,
}: {
  research: ResearchReceipt;
  error?: string;
  emptyMessageKey: TranslationKey;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const renderedState = research.empty ? "empty" : research.completeness;
  const source = t(researchSourceKey(research.source));
  const retrieved = formatDate(research.retrievedAt, { dateStyle: "medium", timeStyle: "short" });
  if (research.empty) {
    return (
      <Alert data-testid="research-state-empty">
        <CheckCircle className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">{t("publicRecords.research.emptyTitle")}</p>
          <p className="mt-1">{t(emptyMessageKey)}</p>
          <p className="mt-2 text-xs text-muted-foreground">{source} · {t("publicRecords.retrievedLower", { date: retrieved })}</p>
        </AlertDescription>
      </Alert>
    );
  }
  if (research.completeness === "complete") {
    return (
      <Alert data-testid="research-state-complete">
        <CheckCircle className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">{t("publicRecords.research.completeTitle")}</p>
          <p className="mt-1">{t(research.resultCount === 1 ? "publicRecords.research.recordedOne" : "publicRecords.research.recordedMany", { count: formatNumber(research.resultCount ?? 0) })}</p>
          <p className="mt-2 text-xs text-muted-foreground">{source} · {t("publicRecords.retrievedLower", { date: retrieved })}</p>
        </AlertDescription>
      </Alert>
    );
  }
  if (research.completeness === "partial") {
    return (
      <Alert data-testid="research-state-partial">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>
          <p className="font-semibold">{t("publicRecords.research.partialTitle")}</p>
          <p className="mt-1">
            {research.resultCount === 0
              ? t("publicRecords.research.partialZero")
              : t(research.resultCount === 1 ? "publicRecords.research.partialIncompleteOne" : "publicRecords.research.partialIncompleteMany", { count: formatNumber(research.resultCount ?? 0) })}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">{source} · {t("publicRecords.retrievedLower", { date: retrieved })}</p>
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
          {research.completeness === "unavailable" ? t("publicRecords.research.unavailableTitle") : t("publicRecords.research.failedTitle")}
          </p>
        <p className="mt-1">{error || t("publicRecords.research.providerFallback")}</p>
        <p className="mt-1">{t("publicRecords.research.noConclusion")}</p>
        <p className="mt-2 text-xs">{source} · {t("publicRecords.attempted", { date: retrieved })}</p>
      </AlertDescription>
    </Alert>
  );
}
