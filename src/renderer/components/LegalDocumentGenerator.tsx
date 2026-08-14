import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";
import {
  FileText,
  Download,
  Eye,
  Shield,
  AlertTriangle,
  Scale,
  Send,
  Loader2,
} from "lucide-react";

interface LegalDocumentGeneratorProps {
  caseId: string;
}

export function LegalDocumentGenerator({ caseId }: LegalDocumentGeneratorProps) {
  const [demandAmount, setDemandAmount] = useState("");
  const [previewDoc, setPreviewDoc] = useState<any>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const generateDocMutation = trpc.gapAnalysis.generateDocument.useMutation({
    onSuccess: (data) => {
      if (data.success && data.document) {
        setPreviewDoc(data.document);
        setPreviewOpen(true);
      }
    },
  });

  const handleGenerate = async (
    documentType: "discovery_request" | "preservation_notice" | "spoliation_warning" | "demand_letter"
  ) => {
    await generateDocMutation.mutateAsync({
      caseId,
      documentType,
      demandAmount: demandAmount ? parseFloat(demandAmount) : undefined,
    });
  };

  const handleDownload = () => {
    if (!previewDoc) return;

    const reviewItems = previewDoc.consequences?.length
      ? `\n\nReview checklist:\n${previewDoc.consequences.join("\n")}`
      : "";
    const content = `${previewDoc.title}\n\n${previewDoc.content}${reviewItems}`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${previewDoc.type}_${caseId}_${new Date().toISOString().split("T")[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const documents = [
    {
      type: "discovery_request" as const,
      title: "Records Request",
      description: "Source-limited draft asking for identified records",
      icon: FileText,
      color: "text-blue-500",
      bgColor: "bg-blue-50",
    },
    {
      type: "preservation_notice" as const,
      title: "Records Preservation Request",
      description: "Review draft defining records that may need preservation",
      icon: Shield,
      color: "text-green-500",
      bgColor: "bg-green-50",
    },
    {
      type: "spoliation_warning" as const,
      title: "Missing Records Clarification",
      description: "Ask about unavailable records without alleging misconduct",
      icon: AlertTriangle,
      color: "text-red-500",
      bgColor: "bg-red-50",
    },
    {
      type: "demand_letter" as const,
      title: "Resolution Request",
      description: "Review draft listing verified open items and requested resolution",
      icon: Send,
      color: "text-orange-500",
      bgColor: "bg-orange-50",
    },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
        <CardTitle>Review Draft Generator</CardTitle>
          <CardDescription>
            Prepare factual drafts from the evidence currently available in this case
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Alert className="mb-4">
            <Scale className="h-4 w-4" />
            <AlertDescription>
              Drafts do not establish legal rights, misconduct, deadlines, or consequences. Verify
              every fact and obtain qualified legal review before sending.
            </AlertDescription>
          </Alert>

          {/* Demand Amount Input (for demand letter) */}
          <div className="mb-6">
            <Label htmlFor="demand-amount">Demand Amount (Optional, for Demand Letter)</Label>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-lg">€</span>
              <Input
                id="demand-amount"
                type="number"
                placeholder="5000"
                value={demandAmount}
                onChange={(e) => setDemandAmount(e.target.value)}
                className="max-w-xs"
              />
            </div>
          </div>

          {/* Document Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {documents.map((doc) => (
              <Card key={doc.type} className="relative overflow-hidden">
                <div className={`absolute top-0 right-0 w-32 h-32 ${doc.bgColor} opacity-10 rounded-full -mr-16 -mt-16`} />
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${doc.bgColor}`}>
                      <doc.icon className={`w-5 h-5 ${doc.color}`} />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-base">{doc.title}</CardTitle>
                      <CardDescription className="text-sm mt-1">
                        {doc.description}
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button
                    onClick={() => handleGenerate(doc.type)}
                    disabled={generateDocMutation.isPending}
                    className="w-full"
                    variant="outline"
                  >
                    {generateDocMutation.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Generating...
                      </>
                    ) : (
                      <>
                        <Eye className="w-4 h-4 mr-2" />
                        Generate & Preview
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{previewDoc?.title}</DialogTitle>
            <DialogDescription>
              Review the generated document before downloading
            </DialogDescription>
          </DialogHeader>

          {previewDoc && (
            <div className="space-y-6">
              {/* Document Content */}
              <div className="p-6 bg-white border rounded-lg">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">
                  {previewDoc.content}
                </pre>
              </div>

              {previewDoc.legalBasis.length > 0 && <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Legal Basis</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1">
                    {previewDoc.legalBasis.map((basis: string, idx: number) => (
                      <li key={idx} className="text-sm text-muted-foreground font-mono">
                        • {basis}
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>}

              {/* Deadline */}
              {previewDoc.deadline && (
                <Alert>
                  <AlertDescription>
                    <span className="font-semibold">Deadline:</span> {previewDoc.deadline}
                  </AlertDescription>
                </Alert>
              )}

              {/* Consequences */}
              {previewDoc.consequences && previewDoc.consequences.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Review Checklist</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ul className="space-y-1">
                      {previewDoc.consequences.map((consequence: string, idx: number) => (
                        <li key={idx} className="text-sm text-muted-foreground">
                          • {consequence}
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {/* Download Buttons */}
              <div>
                <Button onClick={handleDownload} className="w-full">
                  <Download className="w-4 h-4 mr-2" />
                  Download as Text
                </Button>
              </div>

              <Alert>
                <AlertDescription className="text-xs">
                  <strong>Note:</strong> Review this document with a qualified lawyer before
                  sending to the opponent. This is a template that may require customization for
                  your specific case.
                </AlertDescription>
              </Alert>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

