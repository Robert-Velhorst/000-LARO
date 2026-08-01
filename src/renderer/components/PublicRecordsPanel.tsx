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
} from "lucide-react";

interface PublicRecordsPanelProps {
  caseId: string;
  companyName?: string;
  kvkNumber?: string;
}

export function PublicRecordsPanel({ caseId, companyName, kvkNumber }: PublicRecordsPanelProps) {
  const [searchKvk, setSearchKvk] = useState(kvkNumber || "");
  const [searchCompany, setSearchCompany] = useState(companyName || "");

  // KvK lookup mutation
  const kvkLookup = trpc.gapAnalysis.lookupCompany.useMutation();

  // Court records search mutation
  const courtRecordsSearch = trpc.gapAnalysis.searchCourtRecords.useMutation();

  // Opponent history query
  const { data: opponentHistory, refetch: refetchHistory } =
    trpc.gapAnalysis.getOpponentHistory.useQuery(
      { companyName: searchCompany },
      { enabled: false }
    );

  const handleKvkLookup = async () => {
    if (!searchKvk) return;

    await kvkLookup.mutateAsync({
      kvkNumber: searchKvk,
    });
  };

  const handleCourtRecordsSearch = async () => {
    if (!searchCompany) return;

    await courtRecordsSearch.mutateAsync({
      companyName: searchCompany,
      searchType: "company_history",
    });

    // Also fetch detailed history
    await refetchHistory();
  };

  return (
    <div className="space-y-6">
      <Tabs defaultValue="kvk" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="kvk">
            <Building2 className="w-4 h-4 mr-2" />
            KvK Business Registry
          </TabsTrigger>
          <TabsTrigger value="court">
            <Gavel className="w-4 h-4 mr-2" />
            Court Records
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
                  {kvkLookup.data.success ? (
                    <>
                      <Alert>
                        <CheckCircle className="h-4 w-4" />
                        <AlertDescription>Company found in KvK registry</AlertDescription>
                      </Alert>

                      <div className="grid grid-cols-2 gap-4">
                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">KvK Number</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="text-2xl font-bold">
                              {kvkLookup.data.data?.kvkNumber}
                            </p>
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Status</CardTitle>
                          </CardHeader>
                          <CardContent>
                            {kvkLookup.data.data?.isActive ? (
                              <Badge variant="default" className="bg-green-500">
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Active
                              </Badge>
                            ) : (
                              <Badge variant="destructive">
                                <XCircle className="w-3 h-3 mr-1" />
                                Inactive
                              </Badge>
                            )}
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Legal Form</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="text-lg font-semibold">
                              {kvkLookup.data.data?.legalForm}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {kvkLookup.data.data?.legalForm === "BV"
                                ? "Private Company"
                                : "Public Limited Company"}
                            </p>
                          </CardContent>
                        </Card>

                        <Card>
                          <CardHeader className="pb-3">
                            <CardTitle className="text-sm">Region</CardTitle>
                          </CardHeader>
                          <CardContent>
                            <p className="text-lg font-semibold flex items-center">
                              <MapPin className="w-4 h-4 mr-1" />
                              {kvkLookup.data.data?.postalCodeRegion}xx
                            </p>
                          </CardContent>
                        </Card>
                      </div>

                      {/* Insolvency Warning */}
                      {kvkLookup.data.data?.insolvencyStatus && (
                        <Alert variant="destructive">
                          <AlertTriangle className="h-4 w-4" />
                          <AlertDescription>
                            <div className="font-semibold">Insolvency Detected</div>
                            <div className="mt-1">
                              Type:{" "}
                              {kvkLookup.data.data.insolvencyStatus.type === "bankruptcy"
                                ? "Bankruptcy (Faillissement)"
                                : kvkLookup.data.data.insolvencyStatus.type ===
                                    "debt_restructuring"
                                  ? "Debt Restructuring (WSNP)"
                                  : "Suspension of Payments (Surseance)"}
                            </div>
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
                                  </div>
                                ))}
                              </div>
                            </CardContent>
                          </Card>
                        )}

                      {/* Legal Significance */}
                      {kvkLookup.data.legalSignificance && (
                        <Alert>
                          <AlertDescription className="text-sm">
                            <div className="font-semibold mb-1">Legal Significance:</div>
                            {kvkLookup.data.legalSignificance}
                          </AlertDescription>
                        </Alert>
                      )}
                    </>
                  ) : (
                    <Alert variant="destructive">
                      <XCircle className="h-4 w-4" />
                      <AlertDescription>{kvkLookup.data.error}</AlertDescription>
                    </Alert>
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

              {/* Opponent History Summary */}
              {opponentHistory && (
                <div className="mt-4 space-y-4">
                  <div className="grid grid-cols-3 gap-4">
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
                        {opponentHistory.wonCases + opponentHistory.lostCases}
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
              {courtRecordsSearch.data && (
                <div className="mt-4">
                  {courtRecordsSearch.data.success ? (
                    <Alert>
                      <CheckCircle className="h-4 w-4" />
                      <AlertDescription>
                        Returned {courtRecordsSearch.data.totalResults} recently published decisions
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
                  ) : (
                    <Alert variant="destructive">
                      <XCircle className="h-4 w-4" />
                      <AlertDescription>{courtRecordsSearch.data.error}</AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

