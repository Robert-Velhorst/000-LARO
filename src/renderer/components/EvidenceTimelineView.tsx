import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar, FileText, Mail, Upload, Image, Video, Music, File, Search, Filter, Download } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { encodeCsvRows } from "../../../shared/csv";

/**
 * Evidence Timeline View Component
 * 
 * Reusable component that can be used in both standalone page and case details dialog
 * Accepts optional caseId to filter evidence for a specific case
 */

interface EvidenceTimelineViewProps {
  caseId?: string;
}

export default function EvidenceTimelineView({ caseId }: EvidenceTimelineViewProps) {
  const [selectedSource, setSelectedSource] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Fetch evidence with filters
  const { data: evidence, isLoading } = trpc.evidenceTimeline.getTimeline.useQuery({
    caseId: caseId || undefined,
    source: selectedSource !== "all" ? selectedSource : undefined,
    type: selectedType !== "all" ? (selectedType as any) : undefined,
    search: searchQuery || undefined,
  });

  // Group evidence by date
  const groupedEvidence = evidence?.reduce((acc, item) => {
    const date = format(new Date(item.createdAt ?? ""), "yyyy-MM-dd");
    if (!acc[date]) {
      acc[date] = [];
    }
    acc[date].push(item);
    return acc;
  }, {} as Record<string, typeof evidence>);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "email":
        return <Mail className="h-4 w-4" />;
      case "document":
        return <FileText className="h-4 w-4" />;
      case "photo":
        return <Image className="h-4 w-4" />;
      case "video":
        return <Video className="h-4 w-4" />;
      case "audio":
        return <Music className="h-4 w-4" />;
      default:
        return <File className="h-4 w-4" />;
    }
  };

  const getSourceColor = (source: string) => {
    switch (source?.toLowerCase()) {
      case "gmail":
        return "bg-red-100 text-red-800";
      case "outlook":
        return "bg-blue-100 text-blue-800";
      case "manual upload":
        return "bg-green-100 text-green-800";
      case "device scan":
        return "bg-purple-100 text-purple-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const safeParseTags = (tags: unknown): string[] => {
    if (Array.isArray(tags)) return tags.map(String);
    if (typeof tags !== "string" || tags.trim() === "") return [];
    try {
      const parsed = JSON.parse(tags);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };

  // Export the currently-filtered timeline as a CSV download.
  const handleExport = () => {
    if (!evidence || evidence.length === 0) {
      toast.message("Nothing to export", { description: "No evidence matches the current filters." });
      return;
    }
    const header = ["Date", "Type", "Source", "Title", "Description", "Tags"];
    const rows = evidence.map((item: any) =>
      [
        item.createdAt ? new Date(item.createdAt).toISOString() : "",
        item.type ?? "",
        item.source ?? "",
        item.title ?? "",
        String(item.description ?? "").replace(/\s+/g, " "),
        safeParseTags(item.tags).join("; "),
      ]
    );
    const csv = encodeCsvRows([header, ...rows], "\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `evidence-timeline${caseId ? `-${caseId}` : ""}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exported ${evidence.length} item${evidence.length === 1 ? "" : "s"}`);
  };

  // Open the underlying file, or show a preview for items without one (e.g. emails).
  const handleView = (item: any) => {
    if (item.fileUrl) {
      window.open(item.fileUrl, "_blank");
      return;
    }
    let body = "";
    try {
      const meta = item.metadata ? JSON.parse(item.metadata) : {};
      body = meta.bodyExcerpt || "";
    } catch {
      /* ignore */
    }
    toast(item.title || "Evidence", {
      description: body || item.description || "No preview available for this item.",
    });
  };

  return (
    <div className="space-y-6">
      {/* Filters */}
      <Card className="border-border/50 bg-card/50">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search evidence..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            {/* Source Filter */}
            <Select value={selectedSource} onValueChange={setSelectedSource}>
              <SelectTrigger>
                <SelectValue placeholder="All Sources" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                <SelectItem value="gmail">Gmail</SelectItem>
                <SelectItem value="outlook">Outlook</SelectItem>
                <SelectItem value="manual upload">Manual Upload</SelectItem>
                <SelectItem value="device scan">Device Scan</SelectItem>
              </SelectContent>
            </Select>

            {/* Type Filter */}
            <Select value={selectedType} onValueChange={setSelectedType}>
              <SelectTrigger>
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="document">Document</SelectItem>
                <SelectItem value="photo">Photo</SelectItem>
                <SelectItem value="video">Video</SelectItem>
                <SelectItem value="audio">Audio</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-between items-center mt-4">
            <p className="text-sm text-muted-foreground">
              {evidence && Array.isArray(evidence) ? evidence.length : 0} items found
            </p>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={!evidence || evidence.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Export Timeline
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Timeline */}
      {isLoading ? (
        <Card className="border-border/50 bg-card/50">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Loading timeline...</p>
          </CardContent>
        </Card>
      ) : !groupedEvidence || Object.keys(groupedEvidence).length === 0 ? (
        <Card className="border-border/50 bg-card/50">
          <CardContent className="py-12 text-center">
            <Upload className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-lg font-medium">No evidence found</p>
            <p className="text-sm text-muted-foreground mt-2">
              Start collecting evidence by syncing your email or uploading files
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {Object.entries(groupedEvidence)
            .sort(([dateA], [dateB]) => new Date(dateB).getTime() - new Date(dateA).getTime())
            .map(([date, items]) => (
              <div key={date} className="relative">
                {/* Date Header */}
                <div className="flex items-center gap-4 mb-4">
                  <div className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-full">
                    <Calendar className="h-4 w-4" />
                    <span className="font-medium">{format(new Date(date), "MMMM dd, yyyy")}</span>
                  </div>
                  <div className="flex-1 h-px bg-border" />
                  <Badge variant="secondary">{items.length} items</Badge>
                </div>

                {/* Evidence Items */}
                <div className="ml-8 space-y-4">
                  {items.map((item) => {
                    const tags = safeParseTags((item as any).tags);
                    return (
                    <Card key={item.id} className="hover:shadow-md transition-shadow border-border/50 bg-card/50">
                      <CardContent className="p-4">
                        <div className="flex items-start gap-4">
                          {/* Icon */}
                          <div className="mt-1">
                            {getTypeIcon(item.type)}
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <h3 className="font-medium truncate">{item.title}</h3>
                                {item.description && (
                                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                                    {item.description}
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge className={getSourceColor(item.source || "")}>
                                  {item.source}
                                </Badge>
                                <Badge variant="outline">{item.type}</Badge>
                              </div>
                            </div>

                            {/* Metadata */}
                            <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                              <span>{format(new Date(item.createdAt ?? ""), "HH:mm")}</span>
                              {item.fileSize && (
                                <span>{(parseInt(item.fileSize) / 1024 / 1024).toFixed(2)} MB</span>
                              )}
                              {tags.length > 0 && (
                                <div className="flex gap-1">
                                  {tags.slice(0, 3).map((tag: string, idx: number) => (
                                    <Badge key={idx} variant="secondary" className="text-xs">
                                      {tag}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Actions */}
                          <Button variant="ghost" size="sm" onClick={() => handleView(item)}>
                            View
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  )})}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
