import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Upload, File, Image, Video, Music, MessageSquare, FileText, Download, Trash2, Plus } from "lucide-react";
import { toast } from "sonner";
import BulkEvidenceUpload from "@/components/BulkEvidenceUpload";

interface EvidenceCollectionProps {
  caseId: string;
  onEvidenceUpdated?: () => void;
}

export function EvidenceCollection({ caseId, onEvidenceUpdated }: EvidenceCollectionProps) {
  const [uploadOpen, setUploadOpen] = useState(false);

  const { data: evidenceList = [], refetch } = trpc.evidenceFiles.search.useQuery(
    { caseId, limit: 200 },
    { enabled: Boolean(caseId) }
  );
  const deleteMutation = trpc.evidenceFiles.delete.useMutation();
  const utils = trpc.useUtils();

  const invalidateEvidenceQueries = async () => {
    await utils.evidenceFiles.search.invalidate({ caseId });
    await utils.evidenceAnalytics.getStats.invalidate();
    await utils.evidenceAnalytics.getFileTypeDistribution.invalidate();
    await utils.evidenceAnalytics.getUploadTimeline.invalidate();
    await utils.evidenceAnalytics.getStorageByCase.invalidate();
    await utils.evidenceAnalytics.getUploadSourceBreakdown.invalidate();
    onEvidenceUpdated?.();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this evidence?")) return;

    try {
      const result = await deleteMutation.mutateAsync({ id });
      if (result.deletionStatus === "storage_cleanup_pending") {
        toast.warning("Evidence record deleted. Storage cleanup is pending and will retry automatically.");
      } else {
        toast.success("Evidence deleted");
      }
      await invalidateEvidenceQueries();
      await refetch();
    } catch (error) {
      toast.error("Failed to delete evidence");
    }
  };

  const getIcon = (type: string) => {
    switch (type) {
      case "photo": return <Image className="w-5 h-5" />;
      case "video": return <Video className="w-5 h-5" />;
      case "audio": return <Music className="w-5 h-5" />;
      case "chat": return <MessageSquare className="w-5 h-5" />;
      case "email": return <FileText className="w-5 h-5" />;
      default: return <File className="w-5 h-5" />;
    }
  };

  const formatFileSize = (bytes: string | number | null | undefined) => {
    const size = typeof bytes === "number" ? bytes : parseInt(String(bytes ?? "0"), 10);
    if (!size || Number.isNaN(size)) return "—";
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-6">
      {/* Header — single upload entry (multi-file, auto-upload) per client checklist */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-bold">Evidence Collection</h2>
          <p className="text-muted-foreground">Upload and manage case evidence</p>
        </div>
        <Button className="bg-orange-500 hover:bg-orange-600 shrink-0" onClick={() => setUploadOpen(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Upload files
        </Button>
      </div>

      {/* Evidence List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {evidenceList?.length === 0 ? (
          <Card className="col-span-full border-border/50 bg-card/50 backdrop-blur-sm">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="p-4 rounded-full bg-orange-500/10 mb-4">
                <Upload className="w-12 h-12 text-orange-500" />
              </div>
              <h3 className="text-xl font-semibold mb-2">No evidence uploaded yet</h3>
              <p className="text-muted-foreground mb-6 max-w-md">
                Upload documents, emails, photos, and other evidence to support your case.
              </p>
            </CardContent>
          </Card>
        ) : (
          evidenceList?.map((item) => (
            <Card key={item.id} className="border-border/50 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300 hover:shadow-lg">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 rounded-lg bg-orange-500/10 text-orange-500">
                      {getIcon(item.type)}
                    </div>
                    <div>
                      <CardTitle className="text-base">{item.title}</CardTitle>
                      <Badge variant="secondary" className="mt-1 text-xs">
                        {item.type}
                      </Badge>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {item.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {item.description}
                  </p>
                )}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{item.source}</span>
                  {item.fileSize && <span>{formatFileSize(item.fileSize)}</span>}
                </div>
                <div className="flex gap-2">
                  {item.fileUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => window.open(item.fileUrl!, "_blank")}
                    >
                      <Download className="w-3 h-3 mr-1" />
                      Download
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(item.id)}
                    className="text-red-500 hover:text-red-600"
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      <BulkEvidenceUpload
        caseId={caseId}
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onComplete={async () => {
          setUploadOpen(false);
          await invalidateEvidenceQueries();
          await refetch();
        }}
      />
    </div>
  );
}

