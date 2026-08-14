import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { getElectronAPI } from "@/lib/electronApiShim";
import { useWebSocket } from "@/contexts/WebSocketContext";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Clock,
  Calendar,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  TrendingUp,
  AlertCircle,
  CircleHelp,
  BriefcaseBusiness,
  DoorOpen,
  MessageSquareText,
  Scale,
  Banknote,
  Rows3,
  Columns3,
} from "lucide-react";

interface TimelineEvent {
  date: string;
  title: string;
  description: string;
  source: {
    evidenceId: string;
    title: string;
    citation: { quote: string; lineStart: number; lineEnd: number } | null;
  };
  importance: "critical" | "high" | "medium" | "low";
  category: "employment" | "termination" | "communication" | "legal" | "financial" | "other";
}

interface CaseTimelineProps {
  caseId: string;
}

export function CaseTimeline({ caseId }: CaseTimelineProps) {
  const { isConnected } = useWebSocket();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [layout, setLayout] = useState<"vertical" | "horizontal">("vertical");

  const timelineQuery = trpc.documentAnalysis.generateCaseTimeline.useQuery(
    { caseId },
    { refetchInterval: isConnected ? false : 60_000, refetchOnWindowFocus: true },
  );
  const timeline = timelineQuery.data;
  const generating = timelineQuery.isFetching;
  const sourceMutation = trpc.evidenceFiles.getDownloadUrl.useMutation();
  const sourceOpenedMutation = trpc.evidenceFiles.recordSourceOpened.useMutation();

  const openSource = async (evidenceId: string) => {
    try {
      setErrorMessage(null);
      const source = await sourceMutation.mutateAsync({ id: evidenceId });
      if (!source.url) throw new Error(source.message || "The source file is not available.");
      await getElectronAPI().openExternal(source.url);
      await sourceOpenedMutation.mutateAsync({ id: evidenceId });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "The source file could not be opened.");
    }
  };

  const getImportanceColor = (importance: string) => {
    const colors = {
      critical: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200 border-red-300",
      high: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200 border-orange-300",
      medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 border-yellow-300",
      low: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200 border-gray-300"
    };
    return colors[importance as keyof typeof colors] || colors.medium;
  };

  const getCategoryIconComponent = (category: string) => {
    const icons = {
      employment: BriefcaseBusiness,
      termination: DoorOpen,
      communication: MessageSquareText,
      legal: Scale,
      financial: Banknote,
      other: FileText
    };
    return icons[category as keyof typeof icons] || icons.other;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return dateString;
    return date.toLocaleDateString('nl-NL', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  };

  const renderEventContent = (event: TimelineEvent) => {
    const CategoryIcon = getCategoryIconComponent(event.category);
    return (
      <div className={`h-full rounded-md border p-4 ${getImportanceColor(event.importance)}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <CategoryIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <h3 className="font-semibold">{event.title}</h3>
            </div>
            <div className="mb-2 text-sm text-muted-foreground">{formatDate(event.date)}</div>
            <p className="mb-2 text-sm">{event.description}</p>
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate">{event.source.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    title="Open source document"
                    aria-label={`Open source document ${event.source.title}`}
                    onClick={() => openSource(event.source.evidenceId)}
                  >
                    <CircleHelp className="h-4 w-4" />
                  </Button>
                </div>
                {event.source.citation?.quote && (
                  <p className="mt-1 line-clamp-3">{event.source.citation.quote}</p>
                )}
              </div>
            </div>
          </div>
          <Badge variant="outline" className="shrink-0 capitalize">{event.importance}</Badge>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {(errorMessage || timelineQuery.error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Timeline action failed</AlertTitle>
          <AlertDescription>{errorMessage || timelineQuery.error?.message}</AlertDescription>
        </Alert>
      )}
      {/* Generate Timeline Button */}
      {!timeline && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              Case Timeline
            </CardTitle>
            <CardDescription>
              Generate a chronological timeline of events from your uploaded documents
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={() => void timelineQuery.refetch()}
              disabled={generating}
              size="lg"
            >
              {generating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating Timeline...
                </>
              ) : (
                <>
                  <TrendingUp className="mr-2 h-4 w-4" />
                  Generate Timeline
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Timeline Display */}
      {timeline && (
        <div className="space-y-6">
          {/* Summary Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Timeline Overview
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-muted-foreground">Total Events</div>
                  <div className="text-2xl font-bold">{timeline.events.length}</div>
                </div>
                <div>
                  <div className="text-sm text-muted-foreground">Duration</div>
                  <div className="text-2xl font-bold">{timeline.duration_days} days</div>
                </div>
              </div>

              <div>
                <div className="font-medium mb-2">Summary</div>
                <p className="text-sm text-muted-foreground">{timeline.summary}</p>
              </div>

              {timeline.key_dates && timeline.key_dates.length > 0 && (
                <div>
                  <div className="font-medium mb-2">Key Dates</div>
                  <div className="flex flex-wrap gap-2">
                    {timeline.key_dates.map((date: string, idx: number) => (
                      <Badge key={idx} variant="outline">
                        {formatDate(date)}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Timeline Events */}
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Chronological Events</CardTitle>
                  <CardDescription>{timeline.events.length} events sorted by date</CardDescription>
                </div>
                <div className="inline-flex rounded-md border border-border bg-background p-1" role="group" aria-label="Timeline layout">
                  <Button
                    type="button"
                    variant={layout === "vertical" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-8 w-8"
                    title="Vertical timeline"
                    aria-label="Show vertical timeline"
                    aria-pressed={layout === "vertical"}
                    onClick={() => setLayout("vertical")}
                  >
                    <Rows3 className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant={layout === "horizontal" ? "secondary" : "ghost"}
                    size="icon"
                    className="h-8 w-8"
                    title="Horizontal timeline"
                    aria-label="Show horizontal timeline"
                    aria-pressed={layout === "horizontal"}
                    onClick={() => setLayout("horizontal")}
                  >
                    <Columns3 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {layout === "vertical" ? (
                <div className="relative">
                  <div className="absolute bottom-0 left-4 top-0 w-0.5 bg-border" />
                  <div className="space-y-6">
                    {timeline.events.map((event: TimelineEvent, index: number) => (
                      <div key={`${event.date}-${event.title}-${index}`} className="relative pl-12">
                        <div className={`absolute left-2 h-4 w-4 rounded-full border-2 border-background ${
                          event.importance === "critical" ? "bg-red-500" :
                          event.importance === "high" ? "bg-orange-500" :
                          event.importance === "medium" ? "bg-yellow-500" : "bg-gray-400"
                        }`} />
                        {renderEventContent(event)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="overflow-x-auto pb-3">
                  <div className="relative flex min-w-max gap-4 pt-10">
                    <div className="absolute left-0 right-0 top-4 h-0.5 bg-border" />
                    {timeline.events.map((event: TimelineEvent, index: number) => (
                      <div key={`${event.date}-${event.title}-${index}`} className="relative w-80 shrink-0">
                        <div className={`absolute -top-8 left-1/2 h-4 w-4 -translate-x-1/2 rounded-full border-2 border-background ${
                          event.importance === "critical" ? "bg-red-500" :
                          event.importance === "high" ? "bg-orange-500" :
                          event.importance === "medium" ? "bg-yellow-500" : "bg-gray-400"
                        }`} />
                        {renderEventContent(event)}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Timeline Gaps */}
          {timeline.gaps && timeline.gaps.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Potential Gaps Identified</AlertTitle>
              <AlertDescription>
                <ul className="list-disc list-inside space-y-1 mt-2">
                  {timeline.gaps.map((gap: string, idx: number) => (
                    <li key={idx} className="text-sm">{gap}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          {/* Regenerate Button */}
          <div className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => void timelineQuery.refetch()}
              disabled={generating}
            >
              {generating ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Regenerating...
                </>
              ) : (
                <>
                  <TrendingUp className="mr-2 h-4 w-4" />
                  Regenerate Timeline
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

