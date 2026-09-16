/**
 * File Upload Dialog Component
 * 
 * Enhanced drag-and-drop file upload interface with:
 * - Multiple file support
 * - File type validation
 * - Size validation
 * - Preview for images
 * - Progress tracking
 */

import { useState, useCallback } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Upload, X, FileText, Image, Video, Music, File } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface FileUploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  caseId?: string;
  onUploadComplete?: (files: UploadedFile[]) => void;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
}

const MAX_FILE_SIZE = 7 * 1024 * 1024;
const ALLOWED_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/wav",
  "text/plain",
];

export default function FileUploadDialog({
  open,
  onOpenChange,
  caseId,
  onUploadComplete,
}: FileUploadDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const uploadEvidenceFile = trpc.evidenceFiles.upload.useMutation();

  const validateFile = (file: File): { valid: boolean; error?: string } => {
    if (file.size > MAX_FILE_SIZE) {
      return { valid: false, error: `File size exceeds 7 MB limit` };
    }

    if (!ALLOWED_TYPES.includes(file.type) && !file.type.startsWith("image/") && !file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
      return { valid: false, error: `File type not allowed` };
    }

    return { valid: true };
  };

  const handleFiles = useCallback((newFiles: FileList | null) => {
    if (!newFiles) return;

    const validFiles: File[] = [];
    const errors: string[] = [];

    Array.from(newFiles).forEach((file) => {
      const validation = validateFile(file);
      if (validation.valid) {
        validFiles.push(file);
      } else {
        errors.push(`${file.name}: ${validation.error}`);
      }
    });

    if (errors.length > 0) {
      toast.error(`Some files were rejected:\n${errors.join("\n")}`);
    }

    if (validFiles.length > 0) {
      setFiles((prev) => [...prev, ...validFiles]);
      toast.success(`${validFiles.length} file(s) added`);
    }
  }, []);

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFiles(e.dataTransfer.files);
    }
  }, [handleFiles]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleFiles(e.target.files);
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const detectFileType = (mimeType: string): "document" | "photo" | "video" | "audio" | "other" => {
    if (mimeType.startsWith("image/")) return "photo";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType.includes("pdf") || mimeType.includes("word") || mimeType.includes("excel") || mimeType.startsWith("text/")) {
      return "document";
    }
    return "other";
  };

  const fileToBase64 = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  };

  const handleUpload = async () => {
    if (files.length === 0) {
      toast.error("Please select files to upload");
      return;
    }
    if (!caseId) {
      toast.error("Select a case before uploading evidence");
      return;
    }

    setUploading(true);
    setUploadProgress(0);

    try {
      const uploadedFiles: UploadedFile[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const base64 = await fileToBase64(file);
        setUploadProgress(((i + 0.5) / files.length) * 100);
        const result = await uploadEvidenceFile.mutateAsync({
          caseId,
          title: file.name,
          type: detectFileType(file.type),
          fileName: file.name,
          mimeType: file.type || "application/octet-stream",
          base64,
        });

        uploadedFiles.push({
          id: result.id,
          name: file.name,
          size: file.size,
          type: file.type,
        });

        setUploadProgress(((i + 1) / files.length) * 100);
      }

      toast.success(`${files.length} file(s) uploaded successfully`);
      
      if (onUploadComplete) {
        onUploadComplete(uploadedFiles);
      }

      // Reset state
      setFiles([]);
      setUploadProgress(0);
      onOpenChange(false);
    } catch (error) {
      toast.error("Upload failed: " + (error as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const getFileIcon = (type: string) => {
    if (type.startsWith("image/")) return Image;
    if (type.startsWith("video/")) return Video;
    if (type.startsWith("audio/")) return Music;
    if (type.includes("pdf")) return FileText;
    return File;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Upload Evidence Files</DialogTitle>
          <DialogDescription>
            Upload documents, images, videos, or audio files (max 7 MB per file)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Drag & Drop Zone */}
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            className={`
              border-2 border-dashed rounded-lg p-8 text-center transition-all
              ${dragActive ? "border-orange-500 bg-orange-500/10" : "border-border hover:border-orange-500/50"}
            `}
          >
            <Upload className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
            <p className="text-lg font-medium mb-2">
              Drag and drop files here
            </p>
            <p className="text-sm text-muted-foreground mb-4">
              or click to browse
            </p>
            <input
              type="file"
              multiple
              onChange={handleFileInput}
              className="hidden"
              id="file-input"
              accept={ALLOWED_TYPES.join(",")}
            />
            <label htmlFor="file-input">
              <Button variant="outline" asChild>
                <span>Browse Files</span>
              </Button>
            </label>
          </div>

          {/* File List */}
          {files.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium">Selected Files ({files.length})</h4>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {files.map((file, index) => {
                  const Icon = getFileIcon(file.type);
                  return (
                    <div
                      key={index}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border bg-card"
                    >
                      <Icon className="w-8 h-8 text-muted-foreground flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{file.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatFileSize(file.size)}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeFile(index)}
                        disabled={uploading}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Upload Progress */}
          {uploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>Uploading files...</span>
                <span>{Math.round(uploadProgress)}%</span>
              </div>
              <Progress value={uploadProgress} />
            </div>
          )}

          {/* Supported File Types */}
          <div className="text-xs text-muted-foreground">
            <p className="font-medium mb-2">Supported file types:</p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">PDF</Badge>
              <Badge variant="outline">Word</Badge>
              <Badge variant="outline">Excel</Badge>
              <Badge variant="outline">Images</Badge>
              <Badge variant="outline">Videos</Badge>
              <Badge variant="outline">Audio</Badge>
              <Badge variant="outline">Text</Badge>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 justify-end">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={uploading}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpload}
              disabled={files.length === 0 || uploading || !caseId}
              className="bg-gradient-to-r from-orange-500 to-orange-600"
            >
              {uploading ? (
                <>Uploading...</>
              ) : (
                <>
                  <Upload className="w-4 h-4 mr-2" />
                  Upload {files.length > 0 && `(${files.length})`}
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

