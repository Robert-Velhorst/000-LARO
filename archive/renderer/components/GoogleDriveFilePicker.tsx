import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Loader2, FolderOpen, FileText, Image, FileSpreadsheet, Presentation, Film, Music, File, Download, Check, CloudDownload } from "lucide-react";
import { toast } from "sonner";

interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}

interface GoogleDriveFilePickerProps {
  accountId: string;
  caseId: string;
  onFilesDownloaded?: (fileIds: string[]) => void;
}

function getFileIcon(mimeType: string) {
  if (mimeType.includes("folder")) return <FolderOpen className="h-5 w-5 text-yellow-500" />;
  if (mimeType.includes("document") || mimeType.includes("pdf") || mimeType.includes("word")) return <FileText className="h-5 w-5 text-blue-500" />;
  if (mimeType.includes("spreadsheet") || mimeType.includes("sheet")) return <FileSpreadsheet className="h-5 w-5 text-green-500" />;
  if (mimeType.includes("presentation") || mimeType.includes("slide")) return <Presentation className="h-5 w-5 text-orange-500" />;
  if (mimeType.includes("image")) return <Image className="h-5 w-5 text-purple-500" />;
  if (mimeType.includes("video")) return <Film className="h-5 w-5 text-red-500" />;
  if (mimeType.includes("audio")) return <Music className="h-5 w-5 text-pink-500" />;
  return <File className="h-5 w-5 text-gray-500" />;
}

function formatFileSize(bytes?: string) {
  if (!bytes) return "Unknown size";
  const size = parseInt(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(dateString?: string) {
  if (!dateString) return "";
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function GoogleDriveFilePicker({ accountId, caseId, onFilesDownloaded }: GoogleDriveFilePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<GoogleDriveFile[]>([]);
  const [isDownloading, setIsDownloading] = useState(false);

  const { data: filesData, isLoading, error, refetch } = trpc.googleDrive.listFiles.useQuery(
    { accountId },
    { enabled: isOpen && !!accountId }
  );

  const downloadMutation = trpc.googleDrive.downloadFile.useMutation({
    onSuccess: () => {
      toast.success("File downloaded successfully");
    },
    onError: (error) => {
      toast.error(`Failed to download file: ${error.message}`);
    },
  });

  const handleFileSelect = (file: GoogleDriveFile) => {
    setSelectedFiles((prev) => {
      const isSelected = prev.some((f) => f.id === file.id);
      if (isSelected) {
        return prev.filter((f) => f.id !== file.id);
      }
      return [...prev, file];
    });
  };

  const handleDownloadSelected = async () => {
    if (selectedFiles.length === 0) {
      toast.error("Please select at least one file");
      return;
    }

    setIsDownloading(true);
    const downloadedIds: string[] = [];

    try {
      for (const file of selectedFiles) {
        await downloadMutation.mutateAsync({
          accountId,
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
        });
      }
      onFilesDownloaded?.(downloadedIds);
      setIsOpen(false);
    } catch (e) {
      console.error(e);
    } finally {
      setIsDownloading(false);
    }
  };

  return <div>Google Drive Picker</div>;
}