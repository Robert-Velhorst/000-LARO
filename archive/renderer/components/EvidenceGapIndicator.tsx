import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Upload,
  Info
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

interface EvidenceGap {
  category: string;
  required: boolean;
  present: boolean;
  description: string;
  suggestions?: string[];
}

interface EvidenceGapIndicatorProps {
  caseType: string;
  uploadedDocuments: Array<{
    type: string;
    name: string;
  }>;
  onUploadClick?: () => void;
}

const requiredEvidenceByType: Record<string, EvidenceGap[]> = {
  "Huurrecht": [
    {
      category: "Rental Contract",
      required: true,
      present: false,
      description: "Original signed rental agreement",
      suggestions: ["Scan or photo of signed contract", "Digital copy if available"]
    },
    {
      category: "Payment Records",
      required: true,
      present: false,
      description: "Bank statements showing rent payments",
      suggestions: ["Last 6 months of bank statements", "Payment receipts"]
    },
    {
      category: "Communication",
      required: true,
      present: false,
      description: "Email or letter correspondence with landlord",
      suggestions: ["Email threads", "Registered mail receipts"]
    },
    {
      category: "Property Inspection",
      required: false,
      present: false,
      description: "Photos or inspection reports of property condition",
      suggestions: ["Photos with timestamps", "Professional inspection report"]
    }
  ],
  "Arbeidsrecht": [
    {
      category: "Employment Contract",
      required: true,
      present: false,
      description: "Signed employment agreement",
      suggestions: ["Original contract", "Any amendments or addendums"]
    },
    {
      category: "Termination Letter",
      required: true,
      present: false,
      description: "Official termination or dismissal notice",
      suggestions: ["Registered mail receipt", "Email notification"]
    },
    {
      category: "Performance Reviews",
      required: false,
      present: false,
      description: "Annual reviews or performance evaluations",
      suggestions: ["Last 2 years of reviews", "Any disciplinary notices"]
    },
    {
      category: "Salary Statements",
      required: true,
      present: false,
      description: "Payslips showing compensation",
      suggestions: ["Last 12 months of payslips", "Annual salary statement"]
    }
  ],
  "default": [
    {
      category: "Incident Documentation",
      required: true,
      present: false,
      description: "Documentation of the incident or dispute",
      suggestions: ["Timeline of events", "Photos or videos if applicable"]
    },
    {
      category: "Correspondence",
      required: true,
      present: false,
      description: "Communication with other parties",
      suggestions: ["Emails", "Letters", "Text messages"]
    },
    {
      category: "Financial Records",
      required: false,
      present: false,
      description: "Relevant financial documentation",
      suggestions: ["Invoices", "Receipts", "Bank statements"]
    }
  ]
};

export default function EvidenceGapIndicator({ 
  caseType, 
  uploadedDocuments,
  onUploadClick 
}: EvidenceGapIndicatorProps) {
  // Get required evidence for this case type
  const requiredEvidence = requiredEvidenceByType[caseType] || requiredEvidenceByType["default"];

  // Check which evidence is present
  const evidenceStatus = requiredEvidence.map(evidence => {
    const isPresent = uploadedDocuments.some(doc => 
      doc.type.toLowerCase().includes(evidence.category.toLowerCase()) ||
      doc.name.toLowerCase().includes(evidence.category.toLowerCase())
    );
    return { ...evidence, present: isPresent };
  });

  // Calculate completeness
  const requiredCount = evidenceStatus.filter(e => e.required).length;
  const requiredPresent = evidenceStatus.filter(e => e.required && e.present).length;
  const completeness = requiredCount > 0 ? (requiredPresent / requiredCount) * 100 : 0;

  const missingRequired = evidenceStatus.filter(e => e.required && !e.present);
  const missingOptional = evidenceStatus.filter(e => !e.required && !e.present);

  const isComplete = missingRequired.length === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Evidence Completeness</CardTitle>
            <CardDescription>
              Required evidence for {caseType} case
            </CardDescription>
          </div>
          {isComplete ? (
            <CheckCircle2 className="h-8 w-8 text-green-600" />
          ) : (
            <AlertTriangle className="h-8 w-8 text-orange-500" />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Completeness Progress */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Required Evidence</span>
            <span className={`font-bold ${isComplete ? 'text-green-600' : 'text-orange-600'}`}>
              {requiredPresent}/{requiredCount} ({Math.round(completeness)}%)
            </span>
          </div>
          <Progress value={completeness} className="h-2" />
        </div>

        {/* Status Alert */}
        {isComplete ? (
          <Alert className="border-green-500 bg-green-500/10">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertTitle className="text-green-900 dark:text-green-100">
              All Required Evidence Collected
            </AlertTitle>
            <AlertDescription className="text-green-800 dark:text-green-200">
              You have uploaded all required documents for this case type.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Missing Required Evidence</AlertTitle>
            <AlertDescription>
              {missingRequired.length} required document{missingRequired.length !== 1 ? 's' : ''} still needed
            </AlertDescription>
          </Alert>
        )}

        {/* Missing Required Evidence */}
        {missingRequired.length > 0 && (
          <div className="space-y-3">
            <h4 className="font-medium text-sm text-red-600 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Missing Required Documents
            </h4>
            <div className="space-y-3">
              {missingRequired.map((evidence, index) => (
                <div
                  key={index}
                  className="p-4 rounded-lg border border-red-500/20 bg-red-500/5 space-y-2"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="font-medium text-sm">{evidence.category}</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {evidence.description}
                      </p>
                    </div>
                    <Badge variant="destructive" className="text-xs">
                      Required
                    </Badge>
                  </div>
                  {evidence.suggestions && evidence.suggestions.length > 0 && (
                    <div className="pt-2 border-t border-red-500/20">
                      <p className="text-xs text-muted-foreground mb-1">Acceptable formats:</p>
                      <ul className="text-xs text-muted-foreground space-y-1">
                        {evidence.suggestions.map((suggestion, i) => (
                          <li key={i} className="flex items-start gap-1">
                            <span className="text-red-500">•</span>
                            {suggestion}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Present Evidence */}
        {evidenceStatus.some(e => e.present) && (
          <div className="space-y-3">
            <h4 className="font-medium text-sm text-green-600 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4" />
              Uploaded Documents
            </h4>
            <div className="space-y-2">
              {evidenceStatus.filter(e => e.present).map((evidence, index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 p-3 rounded-lg border border-green-500/20 bg-green-500/5"
                >
                  <FileText className="h-4 w-4 text-green-600" />
                  <div className="flex-1">
                    <p className="font-medium text-sm">{evidence.category}</p>
                    <p className="text-xs text-muted-foreground">{evidence.description}</p>
                  </div>
                  <CheckCircle2 className="h-5 w-5 text-green-600" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Optional Evidence */}
        {missingOptional.length > 0 && (
          <div className="space-y-3">
            <h4 className="font-medium text-sm text-muted-foreground flex items-center gap-2">
              <Info className="h-4 w-4" />
              Optional (Recommended)
            </h4>
            <div className="space-y-2">
              {missingOptional.map((evidence, index) => (
                <div
                  key={index}
                  className="p-3 rounded-lg border border-border bg-card/50 space-y-1"
                >
                  <div className="flex items-start justify-between">
                    <p className="font-medium text-sm">{evidence.category}</p>
                    <Badge variant="outline" className="text-xs">
                      Optional
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {evidence.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upload Button */}
        {!isComplete && onUploadClick && (
          <Button className="w-full" size="lg" onClick={onUploadClick}>
            <Upload className="h-4 w-4 mr-2" />
            Upload Missing Documents
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

