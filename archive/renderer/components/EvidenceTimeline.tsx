import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Calendar,
  File,
  FileText,
  Mail,
  Upload,
  Image,
  Video,
  Music,
  Search,
  Download,
  MessageSquare,
} from "lucide-react";
import { format } from "date-fns";
import { encodeCsvRows } from "../../../shared/csv";

interface EvidenceTimelineProps {
  caseId?: string;
}

type EvidenceItem = {
  id: string;
  type: string;
  source?: string | null;
  title: string;
  description?: string | null;
  tags?: string | null;
  fileSize?: string | null;
  createdAt: string | Date;
};

export default function EvidenceTimeline({ caseId }: EvidenceTimelineProps) {
  const [selectedSource, setSelectedSource] = useState<string>("all");
  const [selectedType, setSelectedType] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const { data, isLoading } = trpc.evidenceTimeline.getTimeline.useQuery({
    caseId: caseId || undefined,
    source: selectedSource !== "all" ? selectedSource : undefined,
    type: selectedType !== "all" ? (selectedType as any) : undefined,
    search: searchQuery || undefined,
  });

  const evidence = (data as EvidenceItem[] | undefined) ?? [];

  const groupedEvidence = useMemo(() => {
    return evidence.reduce<Record<string, EvidenceItem[]>>((acc, item) => {
      const dateKey = format(new Date(item.createdAt), "yyyy-MM-dd");
      if (!acc[dateKey]) acc[dateKey] = [];
      acc[dateKey].push(item);
      return acc;
    }, {});
  }, [evidence]);

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "email":
        return <Mail className="h-4 w-4" />;
      case "document":
        return <FileText className="h-4 w-4" />;
      case "chat":
        return <MessageSquare className="h-4 w-4" />;
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
    switch (source.toLowerCase()) {
      case "gmail":
        return "bg-red-100 text-red-800";
      case "outlook":
        return "bg-blue-100 text-blue-800";
      case "manual upload":
      case "manual":
        return "bg-green-100 text-green-800";
      case "device scan":
      case "agent":
        return "bg-purple-100 text-purple-800";
      default:
        return "bg-gray-100 text-gray-800";
    }
  };

  const parseTags = (tags: string | null | undefined): string[] => {
    if (!tags) return [];
    try {
      const parsed = JSON.parse(tags);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  const exportTimeline = () => {
    if (evidence.length === 0) return;
    const csvHeader = ["id", "title", "type", "source", "createdAt", "fileSize"];
    const csvRows = evidence.map((item) => [
      item.id,
      item.title,
      item.type,
      item.source ?? "",
      new Date(item.createdAt).toISOString(),
      item.fileSize ?? "",
    ]);
    const csv = encodeCsvRows([csvHeader, ...csvRows], "\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `evidence-timeline-${format(new Date(), "yyyy-MM-dd")}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <Card className="border-border/50 bg-card/50">
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search evidence..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            <Select value={selectedSource} onValueChange={setSelectedSource}>
              <SelectTrigger>
                <SelectValue placeholder="All Sources" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Sources</SelectItem>
                <SelectItem value="gmail">Gmail</SelectItem>
                <SelectItem value="outlook">Outlook</SelectItem>
                <SelectItem value="manual">Manual Upload</SelectItem>
                <SelectItem value="agent">Device Scan</SelectItem>
              </SelectContent>
            </Select>

            <Select value={selectedType} onValueChange={setSelectedType}>
              <SelectTrigger>
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="document">Document</SelectItem>
                <SelectItem value="chat">Chat</SelectItem>
                <SelectItem value="photo">Photo</SelectItem>
                <SelectItem value="video">Video</SelectItem>
                <SelectItem value="audio">Audio</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-between items-center mt-4">
            <p className="text-sm text-muted-foreground">{evidence.length} items found</p>
            <Button variant="outline" size="sm" onClick={exportTimeline} disabled={evidence.length === 0}>
              <Download className="h-4 w-4 mr-2" />
              Export Timeline
            </Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <Card className="border-border/50 bg-card/50">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">Loading timeline...</p>
          </CardContent>
        </Card>
      ) : Object.keys(groupedEvidence).length === 0 ? (
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
            .sort(([a], [b]) => new Date(b).getTime() - new Date(a).getTime())
            .map(([date, items]) => (
              <div key={date} className="relative">
                <div className="flex items-center gap-4 mb-4">
                  <div className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-full">
                    <Calendar className="h-4 w-4" />
                    <span className="font-medium">{format(new Date(date), "MMMM dd, yyyy")}</span>
                  </div>
                  <div className="flex-1 h-px bg-border" />
                  <Badge variant="secondary">{items.length} items</Badge>
                </div>

                <div className="ml-8 space-y-4">
                  {items.map((item) => {
                    const tags = parseTags(item.tags);
                    return (
                      <Card key={item.id} className="hover:shadow-md transition-shadow border-border/50 bg-card/50">
                        <CardContent className="p-4">
                          <div className="flex items-start gap-4">
                            <div className="mt-1">{getTypeIcon(item.type)}</div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-4">
                                <div className="flex-1">
                                  <h3 className="font-medium truncate">{item.title}</h3>
                                  {item.description && (
                                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{item.description}</p>
                                  )}
                                </div>
                                <div className="flex items-center gap-2">
                                  <Badge className={getSourceColor(item.source || "unknown")}>{item.source || "unknown"}</Badge>
                                  <Badge variant="outline">{item.type}</Badge>
                                </div>
                              </div>

                              <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                                <span>{format(new Date(item.createdAt), "HH:mm")}</span>
                                {item.fileSize && (
                                  <span>{(parseInt(item.fileSize, 10) / 1024 / 1024).toFixed(2)} MB</span>
                                )}
                                {tags.length > 0 && (
                                  <div className="flex gap-1">
                                    {tags.slice(0, 3).map((tag, idx) => (
                                      <Badge key={`${item.id}-tag-${idx}`} variant="secondary" className="text-xs">
                                        {tag}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
