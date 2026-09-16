/**
 * Evidence Categorization Component
 * 
 * Organize evidence by type, relevance, and tags
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  FileText, 
  Mail, 
  MessageSquare, 
  Image, 
  Video, 
  Music, 
  File,
  Filter,
  Search,
  Tag,
  Download,
  Eye
} from "lucide-react";

export interface EvidenceItem {
  id: string;
  name: string;
  type: "document" | "email" | "chat" | "photo" | "video" | "audio" | "other";
  source: string;
  uploadedAt: Date;
  size: string;
  relevant: boolean;
  tags?: string[];
  url?: string;
}

interface EvidenceCategorizationProps {
  items: EvidenceItem[];
  onViewItem?: (item: EvidenceItem) => void;
  onDownloadItem?: (item: EvidenceItem) => void;
}

export default function EvidenceCategorization({ items, onViewItem, onDownloadItem }: EvidenceCategorizationProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [selectedRelevance, setSelectedRelevance] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);

  const getTypeIcon = (type: EvidenceItem["type"]) => {
    switch (type) {
      case "document":
        return { icon: FileText, color: "text-blue-500", bg: "bg-blue-500/10" };
      case "email":
        return { icon: Mail, color: "text-purple-500", bg: "bg-purple-500/10" };
      case "chat":
        return { icon: MessageSquare, color: "text-green-500", bg: "bg-green-500/10" };
      case "photo":
        return { icon: Image, color: "text-pink-500", bg: "bg-pink-500/10" };
      case "video":
        return { icon: Video, color: "text-red-500", bg: "bg-red-500/10" };
      case "audio":
        return { icon: Music, color: "text-orange-500", bg: "bg-orange-500/10" };
      default:
        return { icon: File, color: "text-gray-500", bg: "bg-gray-500/10" };
    }
  };

  const getRelevanceBadge = (relevant: boolean) => {
    return relevant ? (
      <Badge className="bg-green-500">Relevant</Badge>
    ) : (
      <Badge variant="secondary">Not Relevant</Badge>
    );
  };

  // Get all unique tags
  const allTags = Array.from(
    new Set(items.flatMap(item => item.tags || []))
  ).sort();

  // Get type counts
  const typeCounts = items.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Filter items
  const filteredItems = items.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = !selectedType || item.type === selectedType;
    const matchesRelevance = selectedRelevance === null || 
      (selectedRelevance === "relevant" && item.relevant) || 
      (selectedRelevance === "not-relevant" && !item.relevant);
    const matchesTag = !selectedTag || (item.tags && item.tags.includes(selectedTag));
    return matchesSearch && matchesType && matchesRelevance && matchesTag;
  });

  // Group by type
  const groupedByType = filteredItems.reduce((acc, item) => {
    if (!acc[item.type]) {
      acc[item.type] = [];
    }
    acc[item.type].push(item);
    return acc;
  }, {} as Record<string, EvidenceItem[]>);

  return (
    <div className="space-y-6">
      {/* Filters */}
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Filter className="w-5 h-5" />
            Filter & Search
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search evidence..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>

          {/* Type Filter */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Type</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={selectedType === null ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedType(null)}
              >
                All ({items.length})
              </Button>
              {Object.entries(typeCounts).map(([type, count]) => (
                <Button
                  key={type}
                  variant={selectedType === type ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedType(type)}
                >
                  {type.charAt(0).toUpperCase() + type.slice(1)} ({count})
                </Button>
              ))}
            </div>
          </div>

          {/* Relevance Filter */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Relevance</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={selectedRelevance === null ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedRelevance(null)}
              >
                All
              </Button>
              <Button
                variant={selectedRelevance === "relevant" ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedRelevance("relevant")}
                className="border-green-500/30 hover:bg-green-500/10"
              >
                Relevant
              </Button>
              <Button
                variant={selectedRelevance === "not-relevant" ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedRelevance("not-relevant")}
                className="border-gray-500/30 hover:bg-gray-500/10"
              >
                Not Relevant
              </Button>
            </div>
          </div>

          {/* Tag Filter */}
          {allTags.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium flex items-center gap-2">
                <Tag className="w-4 h-4" />
                Tags
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={selectedTag === null ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedTag(null)}
                >
                  All
                </Button>
                {allTags.map(tag => (
                  <Button
                    key={tag}
                    variant={selectedTag === tag ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedTag(tag)}
                  >
                    {tag}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Results */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">
            {filteredItems.length} {filteredItems.length === 1 ? "Item" : "Items"}
          </h3>
        </div>

        {filteredItems.length === 0 ? (
          <Card className="border-border/50 bg-card/50">
            <CardContent className="py-12 text-center">
              <File className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-50" />
              <p className="text-muted-foreground">No evidence found matching your filters</p>
            </CardContent>
          </Card>
        ) : (
          Object.entries(groupedByType).map(([type, typeItems]) => {
            const { icon: Icon, color, bg } = getTypeIcon(type as EvidenceItem["type"]);
            
            return (
              <Card key={type} className="border-border/50 bg-card/50 backdrop-blur-sm">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <div className={`p-2 rounded-lg ${bg}`}>
                      <Icon className={`w-5 h-5 ${color}`} />
                    </div>
                    {type.charAt(0).toUpperCase() + type.slice(1)}s ({typeItems.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {typeItems.map(item => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-background/50 hover:bg-background/80 hover:border-orange-500/50 transition-all"
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className={`p-2 rounded-lg ${bg} flex-shrink-0`}>
                          <Icon className={`w-4 h-4 ${color}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium truncate">{item.name}</h4>
                          <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                            <span className="capitalize">{item.source}</span>
                            <span>•</span>
                            <span>{item.size}</span>
                            <span>•</span>
                            <span>{item.uploadedAt.toLocaleDateString()}</span>
                          </div>
                          {item.tags && item.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-2">
                              {item.tags.map(tag => (
                                <Badge key={tag} variant="outline" className="text-xs">
                                  {tag}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        {getRelevanceBadge(item.relevant)}
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onViewItem?.(item)}
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onDownloadItem?.(item)}
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            );
          })
        )}
      </div>
    </div>
  );
}

