import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Search,
  Filter,
  Download,
  Eye,
  FileText,
  Image,
  Video,
  Mail,
  File,
  Grid3x3,
  List,
  Calendar,
  HardDrive,
  Upload,
  X,
} from "lucide-react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { format } from "date-fns";
import FilePreview from "@/components/FilePreview";

type ViewMode = "grid" | "list";
type FileType = "all" | "document" | "image" | "video" | "email" | "other";
type UploadSource = "all" | "manual" | "agent";

export default function EvidenceSearch() {
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [fileType, setFileType] = useState<FileType>("all");
  const [uploadSource, setUploadSource] = useState<UploadSource>("all");
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<{ from: Date | null; to: Date | null }>({
    from: null,
    to: null,
  });
  const [previewFile, setPreviewFile] = useState<any | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 20;

  // Fetch evidence files from backend
  const { data: searchResult, isLoading } = trpc.evidenceFiles.search.useQuery({
    query: searchQuery || undefined,
    fileType: fileType !== "all" ? fileType : undefined,
    uploadSource: uploadSource !== "all" ? uploadSource : undefined,
    caseId: selectedCase || undefined,
    dateFrom: dateRange.from || undefined,
    dateTo: dateRange.to || undefined,
    limit: pageSize,
    offset: page * pageSize,
  });

  const evidenceFiles = searchResult?.files || [];
  const totalFiles = searchResult?.total || 0;
  const hasMore = searchResult?.hasMore || false;

  const getFileIcon = (fileType: string) => {
    switch (fileType) {
      case "document":
        return <FileText className="w-5 h-5 text-blue-500" />;
      case "image":
        return <Image className="w-5 h-5 text-green-500" />;
      case "video":
        return <Video className="w-5 h-5 text-purple-500" />;
      case "email":
        return <Mail className="w-5 h-5 text-orange-500" />;
      default:
        return <File className="w-5 h-5 text-gray-500" />;
    }
  };

  const formatFileSize = (bytes: number | string) => {
    const numBytes = typeof bytes === 'string' ? parseInt(bytes) : bytes;
    if (numBytes < 1024) return `${numBytes} B`;
    if (numBytes < 1024 * 1024) return `${(numBytes / 1024).toFixed(1)} KB`;
    if (numBytes < 1024 * 1024 * 1024) return `${(numBytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(numBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const clearFilters = () => {
    setSearchQuery("");
    setFileType("all");
    setUploadSource("all");
    setSelectedCase(null);
    setDateRange({ from: null, to: null });
  };

  const activeFilterCount = [
    searchQuery,
    fileType !== "all",
    uploadSource !== "all",
    selectedCase,
    dateRange.from || dateRange.to,
  ].filter(Boolean).length;

  return (
    <DashboardLayout>
      <div className="p-8 space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-r from-orange-400 to-orange-600 bg-clip-text text-transparent">
            Evidence Search
          </h1>
          <p className="text-muted-foreground mt-2 text-lg">
            Search and filter through all uploaded evidence files
          </p>
        </div>

        {/* Search and Filters */}
        <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
          <CardContent className="p-6 space-y-4">
            {/* Search Bar */}
            <div className="flex gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-muted-foreground" />
                <Input
                  placeholder="Search by file name..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 h-12 text-base"
                />
              </div>
              <Button
                variant="outline"
                size="lg"
                onClick={clearFilters}
                disabled={activeFilterCount === 0}
              >
                <X className="w-4 h-4 mr-2" />
                Clear {activeFilterCount > 0 && `(${activeFilterCount})`}
              </Button>
            </div>

            {/* Filters */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <Select value={fileType} onValueChange={(value: FileType) => setFileType(value)}>
                <SelectTrigger>
                  <SelectValue placeholder="File Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="document">Documents</SelectItem>
                  <SelectItem value="image">Images</SelectItem>
                  <SelectItem value="video">Videos</SelectItem>
                  <SelectItem value="email">Emails</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={uploadSource}
                onValueChange={(value: UploadSource) => setUploadSource(value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Upload Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="manual">Manual Upload</SelectItem>
                  <SelectItem value="agent">Agent Scan</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={selectedCase || "all"}
                onValueChange={(value) => setSelectedCase(value === "all" ? null : value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Case" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Cases</SelectItem>
                  <SelectItem value="case-1">Smith vs. TechCorp</SelectItem>
                  <SelectItem value="case-2">Johnson Injury Claim</SelectItem>
                </SelectContent>
              </Select>

              <div className="flex gap-2">
                <Button
                  variant={viewMode === "grid" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("grid")}
                >
                  <Grid3x3 className="w-4 h-4" />
                </Button>
                <Button
                  variant={viewMode === "list" ? "default" : "outline"}
                  size="icon"
                  onClick={() => setViewMode("list")}
                >
                  <List className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Results Count */}
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Found <span className="font-semibold text-foreground">{totalFiles}</span>{" "}
            {totalFiles === 1 ? "file" : "files"}
          </p>
          {evidenceFiles.length > 0 && (
            <Button variant="outline" size="sm">
              <Download className="w-4 h-4 mr-2" />
              Download All
            </Button>
          )}
        </div>

        {/* Results Grid/List */}
        {viewMode === "grid" ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {evidenceFiles.map((file) => (
              <Card
                key={file.id}
                className="border-border/50 bg-card/50 backdrop-blur-sm hover:border-orange-500/50 transition-colors cursor-pointer"
                onClick={() => setPreviewFile(file)}
              >
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between">
                    {getFileIcon(file.fileType)}
                    <Badge variant="outline" className="text-xs">
                      {file.uploadSource === "manual" ? (
                        <Upload className="w-3 h-3 mr-1" />
                      ) : (
                        <HardDrive className="w-3 h-3 mr-1" />
                      )}
                      {file.uploadSource}
                    </Badge>
                  </div>

                  <div>
                    <p className="font-medium text-sm truncate" title={file.fileName}>
                      {file.fileName}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">{file.caseName}</p>
                  </div>

                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>{formatFileSize(file.fileSize)}</span>
                    <span>{format(new Date(file.uploadedAt), "MMM d, yyyy")}</span>
                  </div>

                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" className="flex-1">
                      <Eye className="w-3 h-3 mr-1" />
                      View
                    </Button>
                    <Button variant="outline" size="sm" className="flex-1">
                      <Download className="w-3 h-3 mr-1" />
                      Download
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {evidenceFiles.map((file) => (
              <Card
                key={file.id}
                className="border-border/50 bg-card/50 backdrop-blur-sm hover:border-orange-500/50 transition-colors cursor-pointer"
                onClick={() => setPreviewFile(file)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center gap-4">
                    {getFileIcon(file.fileType)}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{file.fileName}</p>
                      <p className="text-sm text-muted-foreground">{file.caseName}</p>
                    </div>
                    <Badge variant="outline">
                      {file.uploadSource === "manual" ? (
                        <Upload className="w-3 h-3 mr-1" />
                      ) : (
                        <HardDrive className="w-3 h-3 mr-1" />
                      )}
                      {file.uploadSource}
                    </Badge>
                    <div className="text-sm text-muted-foreground w-24 text-right">
                      {formatFileSize(file.fileSize)}
                    </div>
                    <div className="text-sm text-muted-foreground w-32 text-right">
                      {format(new Date(file.uploadedAt), "MMM d, yyyy")}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm">
                        <Eye className="w-4 h-4 mr-1" />
                        View
                      </Button>
                      <Button variant="outline" size="sm">
                        <Download className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!isLoading && evidenceFiles.length === 0 && (
          <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="p-12 text-center">
              <Filter className="w-16 h-16 mx-auto text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-semibold mb-2">No files found</h3>
              <p className="text-muted-foreground mb-4">
                Try adjusting your search query or filters
              </p>
              <Button variant="outline" onClick={clearFilters}>
                Clear All Filters
              </Button>
            </CardContent>
          </Card>
        )}

        {/* File Preview */}
        <FilePreview file={previewFile} onClose={() => setPreviewFile(null)} />
      </div>
    </DashboardLayout>
  );
}
