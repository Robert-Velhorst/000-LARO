import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  FileText,
  Calendar,
  Users,
  DollarSign,
  AlertCircle,
  CheckCircle2,
  Info
} from "lucide-react";

interface DocumentAnalysisResultsProps {
  analysis: {
    documentType: string;
    confidence: number;
    extractedInfo: {
      parties?: string[];
      dates?: string[];
      amounts?: string[];
      keyTerms?: string[];
    };
    summary: string;
    redFlags?: string[];
  };
}

export default function DocumentAnalysisResults({ analysis }: DocumentAnalysisResultsProps) {
  const confidenceColor = 
    analysis.confidence >= 0.8 ? "text-green-600" :
    analysis.confidence >= 0.6 ? "text-yellow-600" :
    "text-red-600";

  const confidenceLabel =
    analysis.confidence >= 0.8 ? "High" :
    analysis.confidence >= 0.6 ? "Medium" :
    "Low";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>AI Analysis Results</CardTitle>
            <CardDescription>Automated document classification and extraction</CardDescription>
          </div>
          <Badge variant="secondary" className="text-xs">
            <FileText className="h-3 w-3 mr-1" />
            {analysis.documentType}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Confidence Score */}
        <div className="flex items-center justify-between p-4 rounded-lg bg-accent/50">
          <div className="flex items-center gap-2">
            <Info className="h-5 w-5 text-muted-foreground" />
            <span className="font-medium">Confidence Score</span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-2xl font-bold ${confidenceColor}`}>
              {Math.round(analysis.confidence * 100)}%
            </span>
            <Badge variant="outline" className={confidenceColor}>
              {confidenceLabel}
            </Badge>
          </div>
        </div>

        {/* Summary */}
        <div className="space-y-2">
          <h4 className="font-medium text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Summary
          </h4>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {analysis.summary}
          </p>
        </div>

        <Separator />

        {/* Extracted Information */}
        <div className="space-y-4">
          <h4 className="font-medium text-sm">Extracted Information</h4>

          {/* Parties */}
          {analysis.extractedInfo.parties && analysis.extractedInfo.parties.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Users className="h-4 w-4" />
                <span className="font-medium">Parties Involved</span>
              </div>
              <div className="flex flex-wrap gap-2 pl-6">
                {analysis.extractedInfo.parties.map((party, index) => (
                  <Badge key={index} variant="secondary">
                    {party}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Dates */}
          {analysis.extractedInfo.dates && analysis.extractedInfo.dates.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Calendar className="h-4 w-4" />
                <span className="font-medium">Important Dates</span>
              </div>
              <div className="flex flex-wrap gap-2 pl-6">
                {analysis.extractedInfo.dates.map((date, index) => (
                  <Badge key={index} variant="outline">
                    {date}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Amounts */}
          {analysis.extractedInfo.amounts && analysis.extractedInfo.amounts.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <DollarSign className="h-4 w-4" />
                <span className="font-medium">Financial Amounts</span>
              </div>
              <div className="flex flex-wrap gap-2 pl-6">
                {analysis.extractedInfo.amounts.map((amount, index) => (
                  <Badge key={index} variant="outline" className="font-mono">
                    {amount}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Key Terms */}
          {analysis.extractedInfo.keyTerms && analysis.extractedInfo.keyTerms.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                <span className="font-medium">Key Terms</span>
              </div>
              <div className="flex flex-wrap gap-2 pl-6">
                {analysis.extractedInfo.keyTerms.map((term, index) => (
                  <Badge key={index} variant="secondary">
                    {term}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Red Flags */}
        {analysis.redFlags && analysis.redFlags.length > 0 && (
          <>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-red-600">
                <AlertCircle className="h-4 w-4" />
                Potential Issues Detected
              </div>
              <div className="space-y-2">
                {analysis.redFlags.map((flag, index) => (
                  <div
                    key={index}
                    className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20"
                  >
                    <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                    <p className="text-sm text-red-900 dark:text-red-100">
                      {flag}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        {/* No Issues */}
        {(!analysis.redFlags || analysis.redFlags.length === 0) && (
          <>
            <Separator />
            <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
              <p className="text-sm text-green-900 dark:text-green-100 font-medium">
                No issues detected in this document
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

