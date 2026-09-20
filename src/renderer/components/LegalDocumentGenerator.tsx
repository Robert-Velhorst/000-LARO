import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { apiBase } from "@/providers/TrpcProvider";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  Loader2,
  Scale,
  Send,
  Shield,
} from "lucide-react";

interface LegalDocumentGeneratorProps {
  caseId: string;
}

type DocumentType = "discovery_request" | "preservation_notice" | "spoliation_warning" | "demand_letter";
type ProvenanceType = "owner_entered" | "evidence_derived";

interface PreviewState {
  document: {
    type: DocumentType;
    title: string;
    content: string;
    legalBasis: string[];
    deadline?: string;
    consequences?: string[];
  };
  snapshot: {
    id: string;
    version: number;
    status: "pending_review" | "reviewed";
    contentHash: string;
    byteLength: number;
    fileName: string;
    inputRevision: string;
    sourceRevision: string;
    analysisRevision: string;
    recipientRevision: number;
    recipient: {
      name: string;
      address: string;
      provenanceType: ProvenanceType;
      evidenceId: string | null;
    };
  };
}

export function LegalDocumentGenerator({ caseId }: LegalDocumentGeneratorProps) {
  const [demandAmount, setDemandAmount] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientAddress, setRecipientAddress] = useState("");
  const [provenanceType, setProvenanceType] = useState<ProvenanceType>("owner_entered");
  const [recipientEvidenceId, setRecipientEvidenceId] = useState("");
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const recipientQuery = trpc.gapAnalysis.getReviewedRecipient.useQuery({ caseId });
  const draftsQuery = trpc.gapAnalysis.listLegalDrafts.useQuery({ caseId });
  const evidenceQuery = trpc.evidenceFiles.byCase.useQuery({ caseId });

  useEffect(() => {
    const recipient = recipientQuery.data;
    if (!recipient) return;
    setRecipientName(recipient.name);
    setRecipientAddress(recipient.address);
    setProvenanceType(recipient.provenanceType);
    setRecipientEvidenceId(recipient.evidenceId ?? "");
  }, [recipientQuery.data?.id]);

  const recipientMatchesSaved = Boolean(
    recipientQuery.data
    && recipientName.trim() === recipientQuery.data.name
    && recipientAddress.trim() === recipientQuery.data.address
    && provenanceType === recipientQuery.data.provenanceType
    && (provenanceType === "owner_entered"
      || recipientEvidenceId === (recipientQuery.data.evidenceId ?? "")),
  );

  const markRecipientChanged = () => setRecipientConfirmed(false);

  const saveRecipientMutation = trpc.gapAnalysis.saveReviewedRecipient.useMutation({
    onSuccess: async (recipient) => {
      setRecipientConfirmed(false);
      await recipientQuery.refetch();
      await draftsQuery.refetch();
      toast.success(`Recipient revision ${recipient.revision} reviewed`);
    },
    onError: (error) => toast.error(error.message),
  });

  const generateDocMutation = trpc.gapAnalysis.generateDocument.useMutation({
    onSuccess: (data) => {
      if (data.success && data.document && data.snapshot) {
        setPreview({ document: data.document, snapshot: data.snapshot } as PreviewState);
        setReviewConfirmed(false);
        setPreviewOpen(true);
        void draftsQuery.refetch();
      }
    },
    onError: (error) => toast.error(error.message),
  });

  const reviewMutation = trpc.gapAnalysis.reviewLegalDraft.useMutation({
    onSuccess: (reviewed) => {
      setPreview((current) => current
        ? { ...current, snapshot: { ...current.snapshot, status: reviewed.status } }
        : current);
      setReviewConfirmed(false);
      void draftsQuery.refetch();
      toast.success("Exact draft snapshot reviewed and locked");
    },
    onError: (error) => toast.error(error.message),
  });

  const downloadMutation = trpc.gapAnalysis.prepareLegalDraftDownload.useMutation({
    onError: (error) => toast.error(error.message),
  });

  const saveRecipient = () => {
    saveRecipientMutation.mutate({
      caseId,
      name: recipientName,
      address: recipientAddress,
      provenanceType,
      evidenceId: provenanceType === "evidence_derived" ? recipientEvidenceId : undefined,
      confirmed: true,
    });
  };

  const handleGenerate = (documentType: DocumentType) => {
    if (!recipientQuery.data || !recipientMatchesSaved) {
      toast.error("Save and review the current recipient first.");
      return;
    }
    generateDocMutation.mutate({
      caseId,
      documentType,
      demandAmount: demandAmount ? Number(demandAmount) : undefined,
      recipientRevisionId: recipientQuery.data.id,
    });
  };

  const reviewPreview = () => {
    if (!preview) return;
    reviewMutation.mutate({
      draftId: preview.snapshot.id,
      contentHash: preview.snapshot.contentHash,
      confirmed: true,
    });
  };

  const handleDownload = async (draftId: string) => {
    const payload = await downloadMutation.mutateAsync({ draftId });
    const link = document.createElement("a");
    link.href = `${apiBase()}${payload.url}`;
    link.download = payload.filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    toast.success("Persisted draft download started");
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

  const evidenceFiles = evidenceQuery.data ?? [];
  const canSaveRecipient = Boolean(
    recipientName.trim()
    && recipientAddress.trim()
    && recipientConfirmed
    && (provenanceType === "owner_entered" || recipientEvidenceId),
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Reviewed recipient</CardTitle>
          <CardDescription>
            A draft cannot be downloaded until its exact recipient identity and provenance are saved.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="draft-recipient-name">Recipient name or organization</Label>
              <Input
                id="draft-recipient-name"
                value={recipientName}
                onChange={(event) => {
                  setRecipientName(event.target.value);
                  markRecipientChanged();
                }}
                placeholder="Exact recipient"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="draft-recipient-provenance">Recipient provenance</Label>
              <Select
                value={provenanceType}
                onValueChange={(value: ProvenanceType) => {
                  setProvenanceType(value);
                  markRecipientChanged();
                }}
              >
                <SelectTrigger id="draft-recipient-provenance" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="owner_entered">Owner-provided</SelectItem>
                  <SelectItem value="evidence_derived">Source-linked evidence</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="draft-recipient-address">Complete postal address</Label>
            <Textarea
              id="draft-recipient-address"
              value={recipientAddress}
              onChange={(event) => {
                setRecipientAddress(event.target.value);
                markRecipientChanged();
              }}
              placeholder={"Street and number\nPostal code and city\nCountry"}
              rows={4}
            />
          </div>
          {provenanceType === "evidence_derived" && (
            <div className="space-y-2">
              <Label htmlFor="draft-recipient-source">Evidence supporting this recipient</Label>
              <Select
                value={recipientEvidenceId}
                onValueChange={(value) => {
                  setRecipientEvidenceId(value);
                  markRecipientChanged();
                }}
              >
                <SelectTrigger id="draft-recipient-source" className="w-full">
                  <SelectValue placeholder="Select source evidence" />
                </SelectTrigger>
                <SelectContent>
                  {evidenceFiles.map((item) => (
                    <SelectItem key={item.id} value={item.id}>{item.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {evidenceFiles.length === 0 && (
                <p className="text-sm text-muted-foreground">Import evidence before using source-linked provenance.</p>
              )}
            </div>
          )}
          {!recipientMatchesSaved && (
            <div className="flex items-start gap-3 rounded-md border p-3">
              <Checkbox
                id="confirm-draft-recipient"
                checked={recipientConfirmed}
                onCheckedChange={(value) => setRecipientConfirmed(value === true)}
              />
              <Label htmlFor="confirm-draft-recipient" className="font-normal leading-5">
                I verified this exact name, complete address, and provenance for the intended recipient.
              </Label>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={saveRecipient}
              disabled={!canSaveRecipient || saveRecipientMutation.isPending || recipientMatchesSaved}
            >
              {saveRecipientMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save reviewed recipient
            </Button>
            {recipientMatchesSaved && recipientQuery.data && (
              <Badge variant="secondary" className="gap-1">
                <CheckCircle2 className="h-3 w-3" /> Revision {recipientQuery.data.revision} reviewed · {
                  recipientQuery.data.provenanceType === "owner_entered" ? "owner-provided" : "source-linked"
                }
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Review Draft Generator</CardTitle>
          <CardDescription>
            Create an immutable version from the current case, evidence, analysis, and recipient revisions.
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

          <div className="mb-6">
            <Label htmlFor="demand-amount">Demand Amount (Optional, for Resolution Request)</Label>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-lg">€</span>
              <Input
                id="demand-amount"
                type="number"
                min="0"
                step="0.01"
                placeholder="5000"
                value={demandAmount}
                onChange={(event) => setDemandAmount(event.target.value)}
                className="max-w-xs"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {documents.map((item) => (
              <Card key={item.type} className="relative overflow-hidden">
                <div className={`absolute right-0 top-0 -mr-16 -mt-16 h-32 w-32 rounded-full ${item.bgColor} opacity-10`} />
                <CardHeader>
                  <div className="flex items-start gap-3">
                    <div className={`rounded-lg p-2 ${item.bgColor}`}>
                      <item.icon className={`h-5 w-5 ${item.color}`} />
                    </div>
                    <div className="flex-1">
                      <CardTitle className="text-base">{item.title}</CardTitle>
                      <CardDescription className="mt-1 text-sm">{item.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button
                    onClick={() => handleGenerate(item.type)}
                    disabled={generateDocMutation.isPending || !recipientMatchesSaved}
                    className="w-full"
                    variant="outline"
                  >
                    {generateDocMutation.isPending ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generating...</>
                    ) : (
                      <><Eye className="mr-2 h-4 w-4" />Generate persisted preview</>
                    )}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>

      {(draftsQuery.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Draft version history</CardTitle>
            <CardDescription>Reviewed historical versions remain downloadable as their exact persisted bytes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {draftsQuery.data?.map((draft) => (
              <div key={draft.id} className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{draft.documentType.replaceAll("_", " ")} · v{draft.version}</p>
                    <Badge variant={draft.status === "reviewed" ? "secondary" : "outline"}>{draft.status.replaceAll("_", " ")}</Badge>
                    {!draft.isCurrentInputs && <Badge variant="outline">Historical inputs</Badge>}
                  </div>
                  <p className="mt-1 truncate font-mono text-xs text-muted-foreground">SHA-256 {draft.contentHash}</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={draft.status !== "reviewed" || downloadMutation.isPending}
                  onClick={() => void handleDownload(draft.id)}
                >
                  <Download className="mr-2 h-4 w-4" />Download exact version
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-h-[80vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{preview?.document.title}</DialogTitle>
            <DialogDescription>
              Version {preview?.snapshot.version} · verify the exact recipient and content hash before review.
            </DialogDescription>
          </DialogHeader>

          {preview && (
            <div className="space-y-6">
              <div className="rounded-md border bg-muted/30 p-4 text-sm">
                <p className="font-semibold">Recipient revision {preview.snapshot.recipientRevision}</p>
                <p>{preview.snapshot.recipient.name}</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{preview.snapshot.recipient.address}</p>
                <Badge variant="outline" className="mt-2">
                  {preview.snapshot.recipient.provenanceType === "owner_entered" ? "Owner-provided" : "Source-linked evidence"}
                </Badge>
              </div>

              <div className="rounded-lg border bg-white p-6 text-slate-950">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{preview.document.content}</pre>
              </div>

              {preview.document.legalBasis.length > 0 && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Legal Basis</CardTitle></CardHeader>
                  <CardContent>
                    <ul className="space-y-1">
                      {preview.document.legalBasis.map((basis, index) => (
                        <li key={index} className="font-mono text-sm text-muted-foreground">• {basis}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              {preview.document.deadline && (
                <Alert><AlertDescription><span className="font-semibold">Proposed date:</span> {preview.document.deadline}</AlertDescription></Alert>
              )}

              {preview.document.consequences && preview.document.consequences.length > 0 && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Review Checklist</CardTitle></CardHeader>
                  <CardContent>
                    <ul className="space-y-1">
                      {preview.document.consequences.map((item, index) => (
                        <li key={index} className="text-sm text-muted-foreground">• {item}</li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}

              <div className="rounded-md border p-3">
                <p className="break-all font-mono text-xs">SHA-256 {preview.snapshot.contentHash}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {preview.snapshot.byteLength} persisted bytes · input {preview.snapshot.inputRevision.slice(0, 12)}…
                </p>
              </div>

              {preview.snapshot.status !== "reviewed" ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <Checkbox
                      id="confirm-legal-draft-review"
                      checked={reviewConfirmed}
                      onCheckedChange={(value) => setReviewConfirmed(value === true)}
                    />
                    <Label htmlFor="confirm-legal-draft-review" className="font-normal leading-5">
                      I reviewed this exact recipient, content, source revision, and SHA-256 snapshot.
                    </Label>
                  </div>
                  <Button
                    onClick={reviewPreview}
                    disabled={!reviewConfirmed || reviewMutation.isPending}
                    className="w-full"
                  >
                    {reviewMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Confirm review and lock snapshot
                  </Button>
                </div>
              ) : (
                <Button
                  onClick={() => void handleDownload(preview.snapshot.id)}
                  disabled={downloadMutation.isPending}
                  className="w-full"
                >
                  <Download className="mr-2 h-4 w-4" />Download exact persisted text
                </Button>
              )}

              <Alert>
                <AlertDescription className="text-xs">
                  Review with a qualified lawyer before sending. Download serves the immutable server snapshot,
                  not a browser-created copy.
                </AlertDescription>
              </Alert>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
