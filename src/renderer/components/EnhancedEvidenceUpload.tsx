import { useCallback, useRef, useState } from "react";
import { AlertCircle, Camera, Check, File, FileText, Image, Loader2, Upload, Video } from "lucide-react";
import { toast } from "sonner";
import {
  evidenceTypeForMime,
  isSupportedDocumentAnalysisMimeType,
  isSupportedEvidenceMimeType,
  MAX_EVIDENCE_FILE_BYTES,
} from "../../../shared/evidenceFiles";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

type UploadState = "uploading" | "analyzing" | "complete" | "error";

interface UploadedFile {
  id: string;
  file: File;
  mimeType: string;
  status: UploadState;
  error?: string;
  analysisWarning?: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  eml: "message/rfc822",
  html: "text/html",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  msg: "application/vnd.ms-outlook",
  pdf: "application/pdf",
  png: "image/png",
  txt: "text/plain",
  wav: "audio/wav",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function mimeForFile(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "";
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function FileIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <Image className="h-6 w-6 text-emerald-500" />;
  if (mimeType.startsWith("video/")) return <Video className="h-6 w-6 text-violet-500" />;
  if (mimeType.includes("pdf") || mimeType.includes("word") || mimeType.startsWith("text/")) {
    return <FileText className="h-6 w-6 text-blue-500" />;
  }
  return <File className="h-6 w-6 text-muted-foreground" />;
}

export default function EnhancedEvidenceUpload({ caseId }: { caseId?: string }) {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const utils = trpc.useUtils();
  const uploadEvidenceFile = trpc.evidenceFiles.upload.useMutation();
  const analyzeEvidence = trpc.documentAnalysis.analyzeEvidence.useMutation();

  const refreshEvidenceWorkspace = useCallback(async () => {
    if (!caseId) return;
    await Promise.all([
      utils.evidenceFiles.search.invalidate({ caseId }),
      utils.documentAnalysis.byCase.invalidate({ caseId }),
      utils.documentAnalysis.generateCaseTimeline.invalidate({ caseId }),
      utils.evidenceAnalytics.getStats.invalidate(),
      utils.evidenceAnalytics.getFileTypeDistribution.invalidate(),
      utils.evidenceAnalytics.getUploadTimeline.invalidate(),
      utils.evidenceAnalytics.getStorageByCase.invalidate(),
      utils.evidenceAnalytics.getUploadSourceBreakdown.invalidate(),
    ]);
  }, [caseId, utils]);

  const handleFiles = useCallback(async (fileList: FileList) => {
    if (!caseId) {
      toast.error("Select a case before uploading evidence");
      return;
    }

    const accepted: UploadedFile[] = [];
    let rejected = 0;
    for (const file of Array.from(fileList)) {
      const mimeType = mimeForFile(file);
      if (!file.size || file.size > MAX_EVIDENCE_FILE_BYTES || !isSupportedEvidenceMimeType(mimeType)) {
        rejected += 1;
        continue;
      }
      accepted.push({ id: crypto.randomUUID(), file, mimeType, status: "uploading" });
    }

    if (rejected) toast.error(`${rejected} unsupported, empty, or oversized file${rejected === 1 ? " was" : "s were"} skipped`);
    if (!accepted.length) return;
    setFiles((previous) => [...previous, ...accepted]);

    for (const item of accepted) {
      try {
        const uploaded = await uploadEvidenceFile.mutateAsync({
          caseId,
          title: item.file.name,
          type: evidenceTypeForMime(item.mimeType),
          fileName: item.file.name,
          mimeType: item.mimeType,
          base64: await fileToBase64(item.file),
        });
        if (isSupportedDocumentAnalysisMimeType(item.mimeType)) {
          setFiles((previous) => previous.map((file) => file.id === item.id ? { ...file, status: "analyzing" } : file));
          try {
            await analyzeEvidence.mutateAsync({ evidenceId: uploaded.id });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Automatic analysis failed";
            setFiles((previous) => previous.map((file) => file.id === item.id
              ? { ...file, status: "complete", analysisWarning: message }
              : file));
            toast.warning(`${item.file.name} was stored, but analysis needs review`);
            await refreshEvidenceWorkspace();
            continue;
          }
        }
        setFiles((previous) => previous.map((file) => file.id === item.id ? { ...file, status: "complete" } : file));
        toast.success(`${item.file.name} stored${isSupportedDocumentAnalysisMimeType(item.mimeType) ? " and analyzed" : " as evidence"}`);
        await refreshEvidenceWorkspace();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Upload failed";
        setFiles((previous) => previous.map((file) => file.id === item.id ? { ...file, status: "error", error: message } : file));
        toast.error(`${item.file.name}: ${message}`);
      }
    }
  }, [analyzeEvidence, caseId, refreshEvidenceWorkspace, uploadEvidenceFile]);

  const completeCount = files.filter((file) => file.status === "complete").length;
  const settledCount = files.filter((file) => file.status === "complete" || file.status === "error").length;

  return (
    <div className="space-y-5">
      <Card
        className={`border-2 border-dashed transition-colors ${isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25"}`}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (event.dataTransfer.files.length) void handleFiles(event.dataTransfer.files);
        }}
        onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
        onDragLeave={(event) => { event.preventDefault(); setIsDragging(false); }}
      >
        <CardContent className="p-8 sm:p-10">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <Upload className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold">Add evidence files</h3>
              <p className="mt-1 text-sm text-muted-foreground">Drag files here or select them from this device.</p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button type="button" onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" /> Select files
              </Button>
              <Button type="button" variant="outline" onClick={() => cameraInputRef.current?.click()}>
                <Camera className="mr-2 h-4 w-4" /> Take photo
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">PDF, Office documents, email, text, image, audio, and video up to 7 MB each</p>
          </div>
          <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => event.target.files && void handleFiles(event.target.files)} />
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(event) => event.target.files && void handleFiles(event.target.files)} />
        </CardContent>
      </Card>

      {files.length > 0 ? (
        <section className="space-y-3" aria-live="polite">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium">{completeCount} of {files.length} stored</span>
            <span className="text-muted-foreground">{settledCount} processed</span>
          </div>
          <Progress
            aria-label="Evidence upload progress"
            value={(settledCount / files.length) * 100}
            className="h-2"
          />
          <div className="grid gap-2">
            {files.map((item) => (
              <Card key={item.id} className="border-border/60">
                <CardContent className="flex items-center gap-3 p-3">
                  <FileIcon mimeType={item.mimeType} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.file.name}</p>
                    <p className="text-xs text-muted-foreground">{(item.file.size / 1024).toFixed(1)} KB</p>
                    {item.error ? <p className="mt-1 text-xs text-destructive">{item.error}</p> : null}
                    {item.analysisWarning ? <p className="mt-1 text-xs text-amber-600">Stored; analysis: {item.analysisWarning}</p> : null}
                  </div>
                  {item.status === "uploading" || item.status === "analyzing" ? (
                    <Loader2
                      className="h-5 w-5 animate-spin text-primary"
                      aria-label={item.status === "uploading" ? "Uploading" : "Analyzing"}
                    />
                  ) : null}
                  {item.status === "complete" ? <Check className="h-5 w-5 text-emerald-500" aria-label="Stored" /> : null}
                  {item.status === "error" ? <AlertCircle className="h-5 w-5 text-destructive" aria-label="Failed" /> : null}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
