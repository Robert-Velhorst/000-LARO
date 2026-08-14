import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Check,
  ExternalLink,
  LoaderCircle,
  Newspaper,
  Plus,
  RefreshCw,
  Search,
  Star,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

type TargetType = "media" | "organization";

function parseAreas(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export default function OutreachTargetWorkspace({ targetType }: { targetType: TargetType }) {
  const utils = trpc.useUtils();
  const label = targetType === "media" ? "Media" : "Organizations";
  const singular = targetType === "media" ? "media target" : "organization";
  const Icon = targetType === "media" ? Newspaper : Building2;
  const [caseId, setCaseId] = useState(() => localStorage.getItem("outreach-case-id") || "");
  const [showManual, setShowManual] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualDescription, setManualDescription] = useState("");

  const caseQuery = trpc.cases.list.useQuery({ page: 1, limit: 100, sortBy: "updatedAt", sortDir: "desc" });
  const targetsQuery = trpc.outreachDirectory.list.useQuery({ targetType, limit: 200 });
  const workflowPreferences = trpc.userPreferences.workflow.useQuery();
  const matchesQuery = trpc.outreachDirectory.matches.useQuery(
    { caseId, targetType },
    { enabled: Boolean(caseId), refetchOnWindowFocus: false },
  );
  const cases = caseQuery.data?.cases || [];
  const selectedCase = cases.find((item) => item.id === caseId);

  useEffect(() => {
    if (!caseId && cases[0]?.id) setCaseId(cases[0].id);
  }, [caseId, cases]);

  useEffect(() => {
    if (caseId) localStorage.setItem("outreach-case-id", caseId);
  }, [caseId]);

  const pending = useMemo(
    () => (targetsQuery.data || []).filter((target) => target.status === "pending"),
    [targetsQuery.data],
  );
  const approved = useMemo(
    () => (targetsQuery.data || []).filter((target) => target.status === "approved"),
    [targetsQuery.data],
  );
  const visibleMatches = useMemo(
    () => (matchesQuery.data || []).filter((match) => match.status !== "dismissed"),
    [matchesQuery.data],
  );

  const refreshWorkspace = async () => {
    await Promise.all([
      utils.outreachDirectory.list.invalidate({ targetType }),
      utils.outreachDirectory.summary.invalidate(),
      caseId ? utils.outreachDirectory.matches.invalidate({ caseId, targetType }) : Promise.resolve(),
    ]);
  };

  const matchMutation = trpc.outreachDirectory.matchCase.useMutation({
    onSuccess: async (matches) => {
      await refreshWorkspace();
      toast.success(`${matches.length} approved ${label.toLocaleLowerCase()} match${matches.length === 1 ? "" : "es"} ranked`);
    },
    onError: (error) => toast.error(error.message),
  });

  const discoverMutation = trpc.outreachDirectory.discoverForCase.useMutation({
    onSuccess: async (report) => {
      await refreshWorkspace();
      if (report.reviewMode !== "automatic" && approved.length > 0 && caseId) matchMutation.mutate({ caseId, targetType });
      const message = `${report.newCandidates} new, ${report.existingCandidates} existing candidates`;
      if (report.status === "complete") toast.success(message);
      else if (report.status === "partial") toast.warning(`Partial discovery: ${message}`);
      else toast.error(report.errors[0] || "Public discovery unavailable");
    },
    onError: (error) => toast.error(error.message),
  });

  const reviewMutation = trpc.outreachDirectory.review.useMutation({
    onSuccess: async (result, input) => {
      await refreshWorkspace();
      toast.success(input.status === "approved" ? `${singular} approved and case matches refreshed` : `${singular} rejected`);
      if (result.matches) await utils.outreachDirectory.matches.invalidate({ caseId: input.caseId!, targetType });
    },
    onError: (error) => toast.error(error.message),
  });

  const batchReviewMutation = trpc.outreachDirectory.reviewBatch.useMutation({
    onSuccess: async (result, input) => {
      await refreshWorkspace();
      toast.success(`${result.reviewed} ${label.toLocaleLowerCase()} candidates ${input.status}`);
    },
    onError: (error) => toast.error(error.message),
  });

  const manualMutation = trpc.outreachDirectory.createManual.useMutation({
    onSuccess: async () => {
      setManualName("");
      setManualUrl("");
      setManualDescription("");
      setShowManual(false);
      await refreshWorkspace();
      toast.success(`${singular} added to the review queue`);
    },
    onError: (error) => toast.error(error.message),
  });

  const statusMutation = trpc.outreachDirectory.updateMatchStatus.useMutation({
    onSuccess: refreshWorkspace,
    onError: (error) => toast.error(error.message),
  });

  const isWorking = discoverMutation.isPending || matchMutation.isPending;

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Icon className="h-5 w-5" />{label}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="secondary">{pending.length} pending review</Badge>
            <Badge variant="outline">{approved.length} approved</Badge>
            <Badge variant="outline">{visibleMatches.length} case matches</Badge>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowManual((value) => !value)}>
          <Plus className="mr-2 h-4 w-4" />Add source
        </Button>
      </div>

      <Card className="border-border/50">
        <CardContent className="grid gap-3 p-4 md:grid-cols-[minmax(240px,1fr)_auto_auto] md:items-end">
          <div className="space-y-2">
            <Label>Case</Label>
            <Select value={caseId} onValueChange={setCaseId}>
              <SelectTrigger aria-label={`${label} case`}><SelectValue placeholder="Select a case" /></SelectTrigger>
              <SelectContent>
                {cases.map((item) => (
                  <SelectItem key={item.id} value={item.id}>{item.clientName || item.caseType || item.id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => caseId && discoverMutation.mutate({ caseId, targetType, maxQueries: 4, maxResults: 30 })}
            disabled={!caseId || isWorking}
          >
            {discoverMutation.isPending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
            Discover
          </Button>
          <Button
            variant="outline"
            onClick={() => caseId && matchMutation.mutate({ caseId, targetType, limit: 30 })}
            disabled={!caseId || isWorking || approved.length === 0}
          >
            {matchMutation.isPending ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
            Refresh matches
          </Button>
        </CardContent>
      </Card>

      {showManual && (
        <Card className="border-border/50">
          <CardHeader><CardTitle className="text-base">Add public source</CardTitle></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2"><Label>Name</Label><Input value={manualName} onChange={(event) => setManualName(event.target.value)} /></div>
            <div className="space-y-2"><Label>Public URL</Label><Input type="url" value={manualUrl} onChange={(event) => setManualUrl(event.target.value)} /></div>
            <div className="space-y-2 md:col-span-2"><Label>Description</Label><Textarea value={manualDescription} onChange={(event) => setManualDescription(event.target.value)} rows={3} /></div>
            <div className="flex justify-end gap-2 md:col-span-2">
              <Button variant="ghost" onClick={() => setShowManual(false)}>Cancel</Button>
              <Button
                disabled={manualMutation.isPending || manualName.trim().length < 2 || !manualUrl.trim()}
                onClick={() => manualMutation.mutate({
                  targetType,
                  name: manualName,
                  url: manualUrl,
                  description: manualDescription || undefined,
                  legalAreas: parseAreas(selectedCase?.legalAreas),
                })}
              >
                {manualMutation.isPending && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}Add for review
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid min-w-0 gap-5 xl:grid-cols-2">
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2"><h3 className="font-medium">Review queue</h3><Badge variant="secondary">{pending.length}</Badge></div>
            {workflowPreferences.data?.outreachReviewMode === "batch" && pending.length > 0 ? (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={batchReviewMutation.isPending} onClick={() => batchReviewMutation.mutate({ ids: pending.slice(0, 50).map((target) => target.id), status: "rejected", targetType, caseId: caseId || undefined })}>
                  <X className="mr-1 h-4 w-4" />Reject batch
                </Button>
                <Button size="sm" disabled={batchReviewMutation.isPending} onClick={() => batchReviewMutation.mutate({ ids: pending.slice(0, 50).map((target) => target.id), status: "approved", targetType, caseId: caseId || undefined })}>
                  <Check className="mr-1 h-4 w-4" />Approve batch
                </Button>
              </div>
            ) : null}
          </div>
          {targetsQuery.isLoading ? <Skeleton className="h-40 w-full" /> : pending.length ? pending.map((target) => (
            <Card key={target.id} className="border-border/50">
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0"><h4 className="truncate font-medium">{target.name}</h4><p className="mt-1 text-xs text-muted-foreground">{target.subtype}</p></div>
                  <Badge variant="outline">Unverified</Badge>
                </div>
                {target.description && <p className="line-clamp-3 text-sm text-muted-foreground">{target.description}</p>}
                <div className="flex flex-wrap gap-1">{target.legalAreas.map((area) => <Badge key={area} variant="secondary">{area}</Badge>)}</div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
                  <a href={target.sourceUrl || target.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    Source <ExternalLink className="h-3 w-3" />
                  </a>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => reviewMutation.mutate({ id: target.id, status: "rejected", targetType, caseId: caseId || undefined })} disabled={reviewMutation.isPending}>
                      <X className="mr-1 h-4 w-4" />Reject
                    </Button>
                    <Button size="sm" onClick={() => reviewMutation.mutate({ id: target.id, status: "approved", targetType, caseId: caseId || undefined })} disabled={reviewMutation.isPending}>
                      <Check className="mr-1 h-4 w-4" />Approve
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )) : <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No candidates awaiting review.</div>}
        </section>

        <section className="min-w-0 space-y-3">
          <div className="flex items-center justify-between"><h3 className="font-medium">Case matches</h3><Badge variant="secondary">{visibleMatches.length}</Badge></div>
          {!caseId ? <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">Select a case to view matches.</div>
            : matchesQuery.isLoading ? <Skeleton className="h-40 w-full" />
              : visibleMatches.length ? visibleMatches.map((match) => (
                <Card key={match.id} className="border-border/50">
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0"><h4 className="truncate font-medium">{match.target.name}</h4><p className="mt-1 text-xs text-muted-foreground">{match.target.subtype}</p></div>
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Badge variant="outline" className="capitalize">{match.status}</Badge>
                        <Badge>{match.matchScore}/100</Badge>
                      </div>
                    </div>
                    <div className="space-y-1">{match.matchReasons.map((reason) => <p key={reason} className="text-xs text-muted-foreground">{reason}</p>)}</div>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-3">
                      <a href={match.target.contactUrl || match.target.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                        Public route <ExternalLink className="h-3 w-3" />
                      </a>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => statusMutation.mutate({ id: match.id, status: "dismissed" })} disabled={statusMutation.isPending}>
                          <X className="mr-1 h-4 w-4" />Dismiss
                        </Button>
                        <Button size="sm" variant={match.status === "shortlisted" ? "default" : "outline"} onClick={() => statusMutation.mutate({ id: match.id, status: "shortlisted" })} disabled={statusMutation.isPending}>
                          <Star className="mr-1 h-4 w-4" />Shortlist
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )) : <div className="rounded-md border border-dashed border-border p-8 text-center text-sm text-muted-foreground">No approved targets match this case yet.</div>}
        </section>
      </div>
    </div>
  );
}
