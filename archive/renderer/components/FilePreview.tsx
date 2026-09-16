import { useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Download,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Loader2,
  FileQuestion,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface FilePreviewProps {
  file: {
    id: string;
    fileName: string;
    fileType: string;
    mimeType?: string | null;
    s3Url: string;
  } | null;
  onClose: () => void;
}

export default function FilePreview({ file, onClose }: FilePreviewProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  // Get presigned download URL
  const getDownloadUrl = trpc.evidenceFiles.getDownloadUrl.useMutation({
    onSuccess: (data) => {
      setDownloadUrl(data.url);
    },
    onError: (error) => {
      toast.error(`Failed to load file: ${error.message}`);
    },
  });

  // Fetch download URL when file changes
  useState(() => {
    if (file) {
      getDownloadUrl.mutate({ id: file.id });
    }
  });

  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setPageNumber(1);
  };

  const handleDownload = () => {
    if (downloadUrl) {
      window.open(downloadUrl, "_blank");
    }
  };

  const isPDF = file?.mimeType === "application/pdf" || file?.fileName.endsWith(".pdf");
  const isImage =
    file?.fileType === "image" ||
    file?.mimeType?.startsWith("image/") ||
    /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file?.fileName || "");

  if (!file) return null;

  return (
    <Dialog open={!!file} onOpenChange={onClose}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            <span className="truncate">{file.fileName}</span>
            <div className="flex gap-2">
              {isPDF && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setScale(Math.max(0.5, scale - 0.25))}
                    disabled={scale <= 0.5}
                  >
                    <ZoomOut className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setScale(Math.min(2.0, scale + 0.25))}
                    disabled={scale >= 2.0}
                  >
                    <ZoomIn className="w-4 h-4" />
                  </Button>
                </>
              )}
              <Button variant="outline" size="sm" onClick={handleDownload}>
                <Download className="w-4 h-4 mr-1" />
                Download
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-auto bg-muted/20 rounded-lg p-4 flex items-center justify-center">
          {getDownloadUrl.isPending && (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-12 h-12 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Loading file...</p>
            </div>
          )}

          {getDownloadUrl.isError && (
            <div className="flex flex-col items-center gap-4">
              <FileQuestion className="w-16 h-16 text-destructive" />
              <p className="text-sm text-muted-foreground">Failed to load file</p>
            </div>
          )}

          {downloadUrl && isPDF && (
            <div className="flex flex-col items-center gap-4">
              <Document
                file={downloadUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                loading={
                  <div className="flex items-center gap-2">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <span>Loading PDF...</span>
                  </div>
                }
                error={
                  <div className="flex flex-col items-center gap-2 text-destructive">
                    <FileQuestion className="w-12 h-12" />
                    <span>Failed to load PDF</span>
                  </div>
                }
              >
                <Page
                  pageNumber={pageNumber}
                  scale={scale}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  loading={
                    <div className="flex items-center gap-2 p-8">
                      <Loader2 className="w-6 h-6 animate-spin" />
                      <span>Loading page...</span>
                    </div>
                  }
                />
              </Document>

              {numPages > 1 && (
                <div className="flex items-center gap-4 bg-background/90 backdrop-blur-sm rounded-lg px-4 py-2 shadow-lg">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPageNumber(Math.max(1, pageNumber - 1))}
                    disabled={pageNumber <= 1}
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm font-medium">
                    Page {pageNumber} of {numPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPageNumber(Math.min(numPages, pageNumber + 1))}
                    disabled={pageNumber >= numPages}
                  >
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              )}
            </div>
          )}

          {downloadUrl && isImage && (
            <div className="relative max-w-full max-h-full">
              <img
                src={downloadUrl}
                alt={file.fileName}
                className="max-w-full max-h-[70vh] object-contain rounded-lg shadow-lg"
                style={{ transform: `scale(${scale})` }}
              />
              <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 flex items-center gap-4 bg-background/90 backdrop-blur-sm rounded-lg px-4 py-2 shadow-lg">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setScale(Math.max(0.5, scale - 0.25))}
                  disabled={scale <= 0.5}
                >
                  <ZoomOut className="w-4 h-4" />
                </Button>
                <span className="text-sm font-medium">{Math.round(scale * 100)}%</span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setScale(Math.min(3.0, scale + 0.25))}
                  disabled={scale >= 3.0}
                >
                  <ZoomIn className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}

          {downloadUrl && !isPDF && !isImage && (
            <div className="flex flex-col items-center gap-4">
              <FileQuestion className="w-16 h-16 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Preview not available for this file type
              </p>
              <Button onClick={handleDownload}>
                <Download className="w-4 h-4 mr-2" />
                Download to view
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
