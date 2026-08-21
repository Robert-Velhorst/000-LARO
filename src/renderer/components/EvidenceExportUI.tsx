import { useState } from "react";
import { Archive, CheckCircle2, Download, FileText, Loader2, Table2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";
import { apiBase } from "@/providers/TrpcProvider";

interface EvidenceExportUIProps {
  caseId: string;
}

interface DownloadPayload {
  filename: string;
  mimeType: string;
  base64: string;
  bytes: number;
}

function downloadBase64(payload: DownloadPayload): void {
  const binary = atob(payload.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = payload.filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default function EvidenceExportUI({ caseId }: EvidenceExportUIProps) {
  const [lastExport, setLastExport] = useState<{ format: string; bytes?: number } | null>(null);
  const { data: formats = [], isLoading } = trpc.evidenceExport.getFormats.useQuery();

  const csvExport = trpc.evidenceExport.exportCSV.useMutation({
    onSuccess: (payload) => {
      downloadBase64(payload);
      setLastExport({ format: "CSV", bytes: payload.bytes });
      toast.success("Evidence CSV downloaded");
    },
    onError: (error) => toast.error(error.message),
  });
  const zipExport = trpc.evidenceExport.exportZIP.useMutation({
    onSuccess: (payload) => {
      const link = document.createElement("a");
      link.href = `${apiBase()}${payload.url}`;
      link.download = payload.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setLastExport({ format: "ZIP" });
      toast.success("Evidence package download started");
    },
    onError: (error) => toast.error(error.message),
  });
  const exporting = csvExport.isPending || zipExport.isPending;

  const startExport = (format: string) => {
    if (format === "csv") csvExport.mutate({ caseId });
    if (format === "zip") zipExport.mutate({ caseId });
  };

  const icons = { csv: Table2, zip: Archive, pdf: FileText } as const;

  return (
    <Card className="border-border/50 bg-card/50">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          Export Evidence
        </CardTitle>
        <CardDescription>
          Create an owner-scoped package for this case. ZIP includes available source files and document analyses.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex h-28 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading export formats
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {formats.map((format) => {
              const Icon = icons[format.id];
              return (
                <div key={format.id} className="flex min-h-40 flex-col border border-border/60 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <Icon className="h-5 w-5 text-orange-500" />
                    {!format.available && <Badge variant="outline">Unavailable</Badge>}
                  </div>
                  <p className="mt-3 font-semibold">{format.label}</p>
                  <p className="mt-1 flex-1 text-sm text-muted-foreground">{format.description}</p>
                  <Button
                    className="mt-4 w-full"
                    size="sm"
                    variant={format.available ? "default" : "outline"}
                    disabled={!format.available || exporting}
                    onClick={() => startExport(format.id)}
                  >
                    {exporting && ((format.id === "csv" && csvExport.isPending) || (format.id === "zip" && zipExport.isPending)) ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Download className="mr-2 h-4 w-4" />
                    )}
                    {format.available ? "Download" : "Not available"}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {lastExport && (
          <div className="flex items-center gap-2 border-t border-border/60 pt-4 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            Last download: {lastExport.format}
            {typeof lastExport.bytes === "number" ? `, ${(lastExport.bytes / 1024).toFixed(1)} KB` : ""}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
