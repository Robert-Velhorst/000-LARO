import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  HardDrive,
  Loader2,
  Mail,
  Tag,
  XCircle,
} from "lucide-react";

interface CollectionMonitoringDashboardProps {
  caseId: string;
}

type Completeness =
  | "queued"
  | "running"
  | "complete"
  | "complete_zero"
  | "partial"
  | "limited"
  | "interrupted"
  | "cancelled"
  | "failed";

const STATUS_LABELS: Record<Completeness, string> = {
  queued: "Queued",
  running: "Running",
  complete: "Complete",
  complete_zero: "Complete - no new revisions",
  partial: "Partial",
  limited: "Limited",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  failed: "Failed",
};

const SOURCE_LABELS = {
  gmail: "Gmail",
  google_drive: "Google Drive",
  local: "Local files",
} as const;

function formatDuration(milliseconds: number | null, active: boolean) {
  if (milliseconds == null) return active ? "In progress" : "Unavailable";
  if (milliseconds < 1_000) return "<1s";
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function formatBytes(bytes: number) {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function formatDate(value?: Date | string | null) {
  if (!value) return "Time unavailable";
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusIcon({ status }: { status: Completeness }) {
  if (status === "running" || status === "queued") {
    return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  }
  if (status === "complete" || status === "complete_zero") {
    return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  }
  if (status === "failed" || status === "interrupted") {
    return <XCircle className="h-4 w-4 text-destructive" />;
  }
  return <AlertCircle className="h-4 w-4 text-amber-500" />;
}

function statusVariant(status: Completeness): "default" | "secondary" | "destructive" | "outline" {
  if (status === "failed" || status === "interrupted") return "destructive";
  if (status === "complete") return "default";
  if (status === "running" || status === "queued") return "secondary";
  return "outline";
}

export function CollectionMonitoringDashboard({ caseId }: CollectionMonitoringDashboardProps) {
  const monitoring = trpc.autoCollection.monitoring.useQuery(
    { caseId, limit: 20 },
    { enabled: Boolean(caseId), refetchInterval: 5_000 },
  );
  const jobs = monitoring.data?.jobs ?? [];
  const summary = monitoring.data?.summary;

  return (
    <div className="space-y-6" data-testid="canonical-collection-monitoring">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          { label: "Persisted runs", value: summary?.totalRuns ?? 0, icon: Clock },
          { label: "Evidence revisions stored", value: summary?.storedItems ?? 0, icon: Database },
          { label: "Items processed", value: summary?.processedItems ?? 0, icon: FileText },
          { label: "Items skipped", value: summary?.skippedItems ?? 0, icon: AlertCircle },
        ].map((metric) => (
          <Card key={metric.label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-primary/10 p-2"><metric.icon className="h-5 w-5 text-primary" /></div>
                <div><p className="text-2xl font-bold tabular-nums">{metric.value}</p><p className="text-xs text-muted-foreground">{metric.label}</p></div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Canonical collection history</CardTitle>
          <CardDescription>
            Durable keyword-pull jobs and their stored evidence provenance. A zero-result run is distinct from unavailable or failed collection.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {monitoring.isLoading ? (
            <div className="flex items-center justify-center p-8"><Loader2 aria-label="Loading collection history" className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : monitoring.error ? (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/40 p-4 text-sm text-destructive">
              <XCircle className="mt-0.5 h-4 w-4 shrink-0" />Collection history could not be loaded: {monitoring.error.message}
            </div>
          ) : jobs.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm font-medium">No persisted keyword pulls yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Run “Pull evidence by keyword” to create the first canonical history entry.</p>
            </div>
          ) : (
            <ScrollArea
              className="h-[620px] pr-4"
              viewportProps={{ "aria-label": "Collection history", tabIndex: 0 }}
            >
              <div className="space-y-4">
                {jobs.map((job) => {
                  const details = job.monitoring;
                  const active = details.completeness === "queued" || details.completeness === "running";
                  return (
                    <article key={job.id} className="space-y-4 rounded-lg border p-4" data-testid={`collection-job-${details.completeness}`}>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex items-start gap-2">
                          <StatusIcon status={details.completeness} />
                          <div>
                            <p className="text-sm font-medium">{formatDate(details.startedAt || job.createdAt)}</p>
                            <p className="mt-1 text-xs text-muted-foreground">Job {job.id}</p>
                          </div>
                        </div>
                        <Badge variant={statusVariant(details.completeness)}>{STATUS_LABELS[details.completeness]}</Badge>
                      </div>

                      <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
                        <div><span className="block text-xs text-muted-foreground">Duration</span><strong>{formatDuration(details.durationMs, active)}</strong></div>
                        <div><span className="block text-xs text-muted-foreground">Processed</span><strong>{details.processedItems}</strong></div>
                        <div><span className="block text-xs text-muted-foreground">Stored</span><strong>{details.storedItems}</strong></div>
                        <div><span className="block text-xs text-muted-foreground">Skipped</span><strong>{details.skippedItems}</strong></div>
                        <div><span className="block text-xs text-muted-foreground">Stored bytes</span><strong>{formatBytes(details.processedBytes)}</strong></div>
                      </div>

                      <div className="space-y-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">Requested sources</span>{details.requestedSources.map((source) => <Badge key={source} variant="outline">{SOURCE_LABELS[source]}</Badge>)}</div>
                        <div className="flex flex-wrap items-center gap-2"><span className="font-medium">Completed sources</span>{details.completedSources.length ? details.completedSources.map((source) => <Badge key={source} variant="secondary">{SOURCE_LABELS[source]}</Badge>) : <span className="text-muted-foreground">None recorded as complete</span>}</div>
                        <div className="flex flex-wrap items-center gap-2"><Tag className="h-3.5 w-3.5" /><span className="font-medium">Search terms</span>{details.requestedKeywords.length ? details.requestedKeywords.map((keyword) => <Badge key={keyword} variant="secondary">{keyword}</Badge>) : <span className="text-muted-foreground">Unavailable for this older record</span>}</div>
                        {details.matchedKeywords.length > 0 && <div className="flex flex-wrap items-center gap-2"><span className="font-medium">Matched terms</span>{details.matchedKeywords.map((keyword) => <Badge key={keyword} variant="outline">{keyword}</Badge>)}</div>}
                      </div>

                      <div className="grid gap-2 md:grid-cols-3">
                        {details.sources.map((source) => (
                          <div key={source.source} className="rounded-md bg-muted/40 p-3 text-xs">
                            <div className="flex items-center justify-between gap-2">
                              <span className="flex items-center gap-1.5 font-medium">
                                {source.source === "gmail" ? <Mail className="h-3.5 w-3.5" /> : source.source === "google_drive" ? <HardDrive className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
                                {SOURCE_LABELS[source.source]}
                              </span>
                              <Badge variant="outline" className="capitalize">{source.status}</Badge>
                            </div>
                            <p className="mt-2 text-muted-foreground">{source.processedItems} processed · {source.storedItems} stored · {source.skippedItems} skipped</p>
                            {source.errors.length > 0 && <p className="mt-2 text-destructive">{source.errors[0]}</p>}
                          </div>
                        ))}
                      </div>

                      {details.revisions.length > 0 ? (
                        <div className="space-y-2">
                          <p className="text-xs font-medium">Stored evidence revisions</p>
                          {details.revisions.slice(0, 8).map((revision) => (
                            <div key={revision.evidenceId} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-xs">
                              <span className="font-medium">{revision.title}</span>
                              <span className="text-muted-foreground">{revision.source}</span>
                              <span className="break-all text-muted-foreground">Revision {revision.revisionNumber ?? "n/a"}: {revision.contentRevision || "provider revision unavailable"}</span>
                              {revision.matchedKeywords.map((keyword) => <Badge key={keyword} variant="outline">{keyword}</Badge>)}
                            </div>
                          ))}
                        </div>
                      ) : details.completeness === "complete_zero" ? (
                        <p className="text-xs text-muted-foreground">The pull completed successfully and stored no new evidence revision. Requested terms remain recorded above.</p>
                      ) : null}

                      {(job.error || details.matchReasons.length > 0) && (
                        <div className="space-y-1 text-xs text-muted-foreground">
                          {details.matchReasons.map((reason) => <p key={reason}>{reason}</p>)}
                          {job.error && <p className="text-destructive">{job.error}</p>}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default CollectionMonitoringDashboard;
