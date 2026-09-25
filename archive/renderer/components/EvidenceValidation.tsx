import { useState, useEffect } from "react";
import { AutomatedDocumentAnalysis } from "./AutomatedDocumentAnalysis";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  Calendar,
  ListChecks
} from "lucide-react";

interface EvidenceValidationProps {
  caseId: string;
  legalArea: string;
  onValidationComplete?: (isValid: boolean, score: number) => void;
}

export function EvidenceValidation({ caseId, legalArea, onValidationComplete }: EvidenceValidationProps) {
  const [providedEvidence, setProvidedEvidence] = useState<string[]>([]);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);

  // Fetch checklist for legal area
  const { data: checklist, isLoading: checklistLoading } = trpc.legalChecklists.getChecklist.useQuery({
    legalArea: legalArea as any
  });

  // Validate case
  const validateMutation = trpc.legalChecklists.validateCase.useMutation();

  useEffect(() => {
    if (providedEvidence.length > 0 || completedSteps.length > 0) {
      handleValidate();
    }
  }, [providedEvidence, completedSteps]);

  const handleValidate = async () => {
    const result = await validateMutation.mutateAsync({
      caseId,
      legalArea: legalArea as any,
      providedEvidence,
      completedSteps
    });

    if (onValidationComplete) {
      onValidationComplete(
        result.overall_readiness_score >= 70,
        result.overall_readiness_score
      );
    }
  };

  const toggleEvidence = (evidenceId: string) => {
    setProvidedEvidence(prev =>
      prev.includes(evidenceId)
        ? prev.filter(id => id !== evidenceId)
        : [...prev, evidenceId]
    );
  };

  const toggleStep = (stepId: string) => {
    setCompletedSteps(prev =>
      prev.includes(stepId)
        ? prev.filter(id => id !== stepId)
        : [...prev, stepId]
    );
  };

  if (checklistLoading) {
    return <div>Loading checklist...</div>;
  }

  if (!checklist) {
    return (
      <Alert>
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Checklist Not Available</AlertTitle>
        <AlertDescription>
          Evidence and procedural checklist for this legal area is not yet implemented.
        </AlertDescription>
      </Alert>
    );
  }

  const validation = validateMutation.data;

  return (
    <div className="space-y-6">
      {/* Overall Readiness Score */}
      {validation && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ListChecks className="h-5 w-5" />
              Case Readiness Score
            </CardTitle>
            <CardDescription>
              Overall assessment of your case's readiness for legal proceedings
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Overall Readiness</span>
                <span className="text-2xl font-bold">
                  {Math.round(validation.overall_readiness_score)}%
                </span>
              </div>
              <Progress value={validation.overall_readiness_score} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm text-muted-foreground">Evidence Completeness</div>
                <div className="text-lg font-semibold">
                  {validation.evidence_completeness.provided}/{validation.evidence_completeness.total_required}
                  <span className="text-sm text-muted-foreground ml-2">
                    ({Math.round(validation.evidence_completeness.percentage)}%)
                  </span>
                </div>
              </div>
              <div>
                <div className="text-sm text-muted-foreground">Procedural Compliance</div>
                <div className="text-lg font-semibold">
                  {validation.procedural_compliance.completed}/{validation.procedural_compliance.total_steps}
                  <span className="text-sm text-muted-foreground ml-2">
                    ({Math.round(validation.procedural_compliance.percentage)}%)
                  </span>
                </div>
              </div>
            </div>

            {/* Recommendations */}
            {validation.recommendations.length > 0 && (
              <Alert variant={validation.overall_readiness_score < 50 ? "destructive" : "default"}>
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Recommendations</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside space-y-1 mt-2">
                    {validation.recommendations.map((rec, idx) => (
                      <li key={idx} className="text-sm">{rec}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* Red Flags */}
            {validation.red_flags.length > 0 && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>⚠️ Red Flags Detected</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside space-y-1 mt-2">
                    {validation.red_flags.map((flag) => (
                      <li key={flag.id} className="text-sm">
                        <strong>{flag.title}:</strong> {flag.consequences_if_missing}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}

            {/* Critical Deadlines */}
            {validation.critical_deadlines_approaching.length > 0 && (
              <Alert>
                <Clock className="h-4 w-4" />
                <AlertTitle>⏰ Critical Deadlines Approaching</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc list-inside space-y-1 mt-2">
                    {validation.critical_deadlines_approaching.map((deadline) => (
                      <li key={deadline.id} className="text-sm">
                        <strong>{deadline.title}:</strong> {deadline.deadline} - {deadline.consequences_if_missed}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Evidence Checklist */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Evidence Checklist
          </CardTitle>
          <CardDescription>
            Upload documents for automated analysis or manually check off evidence items
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Automated Document Analysis */}
          <div>
            <h3 className="text-sm font-semibold mb-3">📄 Automated Document Analysis</h3>
            <AutomatedDocumentAnalysis 
              caseId={caseId}
              onAnalysisComplete={() => {
                // Refresh validation after document is analyzed
                handleValidate();
              }}
            />
          </div>

          <div className="border-t pt-6">
            <h3 className="text-sm font-semibold mb-3">✓ Manual Evidence Checklist</h3>
          </div>

          {/* Required Evidence */}
          <div>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-500" />
              Required Evidence (Mandatory)
            </h3>
            <div className="space-y-3">
              {checklist.evidence_items
                .filter(item => item.type === "required")
                .map(item => (
                  <div key={item.id} className="flex items-start gap-3 p-3 border rounded-lg">
                    <Checkbox
                      checked={providedEvidence.includes(item.id)}
                      onCheckedChange={() => toggleEvidence(item.id)}
                    />
                    <div className="flex-1">
                      <div className="font-medium">{item.title}</div>
                      <div className="text-sm text-muted-foreground mt-1">{item.description}</div>
                      <div className="text-xs text-red-600 mt-1">
                        <strong>If missing:</strong> {item.consequences_if_missing}
                      </div>
                      {item.examples && item.examples.length > 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          <strong>Examples:</strong> {item.examples.join(", ")}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Supporting Evidence */}
          <div>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-blue-500" />
              Supporting Evidence (Strengthens Case)
            </h3>
            <div className="space-y-3">
              {checklist.evidence_items
                .filter(item => item.type === "supporting")
                .map(item => (
                  <div key={item.id} className="flex items-start gap-3 p-3 border rounded-lg">
                    <Checkbox
                      checked={providedEvidence.includes(item.id)}
                      onCheckedChange={() => toggleEvidence(item.id)}
                    />
                    <div className="flex-1">
                      <div className="font-medium">{item.title}</div>
                      <div className="text-sm text-muted-foreground mt-1">{item.description}</div>
                      {item.examples && item.examples.length > 0 && (
                        <div className="text-xs text-muted-foreground mt-1">
                          <strong>Examples:</strong> {item.examples.join(", ")}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Timeline-Critical Evidence */}
          {checklist.evidence_items.filter(item => item.type === "timeline_critical").length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-orange-500" />
                Timeline-Critical Evidence (Deadline-Sensitive)
              </h3>
              <div className="space-y-3">
                {checklist.evidence_items
                  .filter(item => item.type === "timeline_critical")
                  .map(item => (
                    <div key={item.id} className="flex items-start gap-3 p-3 border rounded-lg border-orange-200 bg-orange-50">
                      <Checkbox
                        checked={providedEvidence.includes(item.id)}
                        onCheckedChange={() => toggleEvidence(item.id)}
                      />
                      <div className="flex-1">
                        <div className="font-medium">{item.title}</div>
                        <div className="text-sm text-muted-foreground mt-1">{item.description}</div>
                        {item.deadline && (
                          <div className="text-xs text-orange-600 mt-1">
                            <strong>Deadline:</strong> {item.deadline}
                          </div>
                        )}
                        <div className="text-xs text-red-600 mt-1">
                          <strong>If missing:</strong> {item.consequences_if_missing}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Commonly Overlooked Evidence */}
          {checklist.evidence_items.filter(item => item.type === "commonly_overlooked").length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
                Commonly Overlooked Evidence
              </h3>
              <div className="space-y-3">
                {checklist.evidence_items
                  .filter(item => item.type === "commonly_overlooked")
                  .map(item => (
                    <div key={item.id} className="flex items-start gap-3 p-3 border rounded-lg">
                      <Checkbox
                        checked={providedEvidence.includes(item.id)}
                        onCheckedChange={() => toggleEvidence(item.id)}
                      />
                      <div className="flex-1">
                        <div className="font-medium">{item.title}</div>
                        <div className="text-sm text-muted-foreground mt-1">{item.description}</div>
                        <div className="text-xs text-yellow-600 mt-1">
                          <strong>If missing:</strong> {item.consequences_if_missing}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Procedural Checklist */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calendar className="h-5 w-5" />
            Procedural Checklist
          </CardTitle>
          <CardDescription>
            Track critical deadlines and procedural requirements
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Critical Deadlines */}
          <div>
            <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-red-500" />
              Critical Deadlines (Miss = Case Dismissed)
            </h3>
            <div className="space-y-3">
              {checklist.procedural_steps
                .filter(step => step.type === "critical_deadline")
                .map(step => (
                  <div key={step.id} className="flex items-start gap-3 p-3 border rounded-lg border-red-200 bg-red-50">
                    <Checkbox
                      checked={completedSteps.includes(step.id)}
                      onCheckedChange={() => toggleStep(step.id)}
                    />
                    <div className="flex-1">
                      <div className="font-medium">{step.title}</div>
                      <div className="text-sm text-muted-foreground mt-1">{step.description}</div>
                      {step.deadline && (
                        <div className="text-xs text-red-600 mt-1">
                          <strong>Deadline:</strong> {step.deadline}
                        </div>
                      )}
                      <div className="text-xs text-red-600 mt-1">
                        <strong>If missed:</strong> {step.consequences_if_missed}
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* Mandatory Prerequisites */}
          {checklist.procedural_steps.filter(step => step.type === "mandatory_prerequisite").length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-blue-500" />
                Mandatory Prerequisites
              </h3>
              <div className="space-y-3">
                {checklist.procedural_steps
                  .filter(step => step.type === "mandatory_prerequisite")
                  .map(step => (
                    <div key={step.id} className="flex items-start gap-3 p-3 border rounded-lg">
                      <Checkbox
                        checked={completedSteps.includes(step.id)}
                        onCheckedChange={() => toggleStep(step.id)}
                      />
                      <div className="flex-1">
                        <div className="font-medium">{step.title}</div>
                        <div className="text-sm text-muted-foreground mt-1">{step.description}</div>
                        <div className="text-xs text-red-600 mt-1">
                          <strong>If missed:</strong> {step.consequences_if_missed}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Common Errors */}
          {checklist.procedural_steps.filter(step => step.type === "common_error").length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-yellow-500" />
                Common Procedural Errors (Avoid These!)
              </h3>
              <div className="space-y-3">
                {checklist.procedural_steps
                  .filter(step => step.type === "common_error")
                  .map(step => (
                    <div key={step.id} className="p-3 border rounded-lg border-yellow-200 bg-yellow-50">
                      <div className="font-medium">{step.title}</div>
                      <div className="text-sm text-muted-foreground mt-1">{step.description}</div>
                      <div className="text-xs text-red-600 mt-1">
                        <strong>Consequences:</strong> {step.consequences_if_missed}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Validate Button */}
      <div className="flex justify-end">
        <Button onClick={handleValidate} disabled={validateMutation.isPending}>
          {validateMutation.isPending ? "Validating..." : "Validate Case Readiness"}
        </Button>
      </div>
    </div>
  );
}

